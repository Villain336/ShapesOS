// ShapesOS — Phase 22 (chat): the rest of a capped tool result ("Load more").
// GET /api/chat/threads/[id]/results/[toolUseId]?runId=<agentRunId>&offset=<n>
//   → { text, next: number | null }
//
// The transcript shows a tool result under the Phase 17 cap; the full text
// stays in the run's saved transcript for the model's fetch_more
// (lib/agents/tool-loading.ts). This reads the same stored result, one slice
// at a time, for the person. Read-only; the thread must be this user's own,
// in a project the user can access (viewer+), and the run must belong to the
// thread (RLS-scoped read in the thread's workspace).

import type { NextRequest } from "next/server";
import { accessibleWorkspaceWhere, requireProjectRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getAgentRun } from "@/lib/agents/runs/service";
import { prismaTranscriptStore } from "@/lib/agents/runs/transcript";
import { isLoopState, loopLimitsFromEnv } from "@/lib/agents/loop";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

const ID_RE = /^[A-Za-z0-9_:-]{1,120}$/;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; toolUseId: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id, toolUseId } = await params;
  const runId = req.nextUrl.searchParams.get("runId") ?? "";
  const offsetRaw = req.nextUrl.searchParams.get("offset") ?? "0";
  if (!ID_RE.test(toolUseId) || !ID_RE.test(runId)) return Response.json({ error: "Result not found" }, { status: 404 });
  if (!/^\d{1,9}$/.test(offsetRaw)) return Response.json({ error: "offset must be a number" }, { status: 400 });
  try {
    const thread = await prisma.aiChatThread.findFirst({
      where: { id, userId: user.id },
      select: { id: true, projectId: true, project: { select: { workspaceId: true } } },
    });
    if (!thread) return Response.json({ error: "Thread not found" }, { status: 404 });
    const accessible = await prisma.project.findFirst({ where: { id: thread.projectId, workspace: accessibleWorkspaceWhere(user.id) }, select: { id: true } });
    if (!accessible || !(await requireProjectRole(user.id, thread.projectId, "viewer"))) return Response.json({ error: "Thread not found" }, { status: 404 });
    const workspaceId = thread.project.workspaceId;
    const run = await getAgentRun(workspaceId, runId);
    if (!run || run.threadId !== thread.id) return Response.json({ error: "Result not found" }, { status: 404 });
    const state = await prismaTranscriptStore.load(workspaceId, runId).catch(() => null);
    const stored = isLoopState(state) ? state.storedResults?.[toolUseId] : undefined;
    if (stored === undefined) return Response.json({ error: "Result not found" }, { status: 404 });
    const cap = loopLimitsFromEnv().toolResultMaxChars;
    const from = Math.min(Number(offsetRaw), stored.length);
    const text = stored.slice(from, from + cap);
    const next = from + text.length;
    return Response.json({ text, next: next < stored.length ? next : null, total: stored.length }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "GET /api/chat/threads/[id]/results/[toolUseId]");
  }
}
