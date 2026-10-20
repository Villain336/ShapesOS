// ShapesOS — Phase 22 (chat): decide held tool calls from the approval block.
// POST /api/chat/threads/[id]/decisions
//   { decisions: [{ toolUseId?, tool, decision: "approve" | "deny", args? }] }
//   → text/event-stream of AG-UI events: the decided calls run (or are
//     recorded as denied) and the turn CONTINUES in this stream from the
//     transcript that proposed them (lib/chat/agent.ts settleProposals), so
//     the result lands under the call's block without a reload. The same
//     continuation path as a typed "yes" (continuationState,
//     resumeChildAfterDecision); Tier 3 and destructive calls are decided
//     ONLY here (a typed or spoken "yes" leaves them pending).
//
// Access: the thread must be this user's own, in a project the user can
// access, with the editor role (the same bar as sending a message). An
// edited argument set must be a JSON object; the tool must be a pending
// proposal of the thread (anything else is ignored, answered as "nothing to
// decide" in the stream).

import { accessibleWorkspaceWhere, getMembership, requireProjectRole, forbidden } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { validateBody, z, boundedString } from "@/lib/api/validate";
import { streamChatTurnAgui, aguiStreamResponse } from "@/lib/agents/agui/adapter";

export const dynamic = "force-dynamic";

const DecisionSchema = z.object({
  toolUseId: boundedString(120, "toolUseId").nullable().optional(),
  tool: boundedString(120, "tool"),
  decision: z.enum(["approve", "deny"]),
  args: z.record(z.string(), z.unknown()).optional(),
});

const BodySchema = z.object({
  decisions: z.array(DecisionSchema).min(1).max(20),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const v = validateBody(BodySchema, rawBody);
  if (!v.ok) return v.error;
  const { decisions } = v.data;
  if (decisions.some((d) => d.args && JSON.stringify(d.args).length > 20_000)) {
    return Response.json({ error: "Edited arguments are too large" }, { status: 400 });
  }

  const thread = await prisma.aiChatThread.findFirst({
    where: { id, userId: user.id },
    include: { project: { select: { id: true, workspaceId: true } } },
  });
  if (!thread) return Response.json({ error: "Thread not found" }, { status: 404 });
  const accessible = await prisma.project.findFirst({
    where: { id: thread.projectId, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true },
  });
  if (!accessible) return Response.json({ error: "Thread not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, thread.projectId, "editor"))) return forbidden();
  const membership = await getMembership(user.id, thread.project.workspaceId);
  if (!membership) return forbidden();

  const line = decisions.map((d) => `${d.decision === "deny" ? "Denied" : d.args ? "Edited and approved" : "Approved"} ${d.tool}`).join(" · ");
  return aguiStreamResponse((hooks) =>
    streamChatTurnAgui(
      {
        projectId: thread.projectId,
        workspaceId: thread.project.workspaceId,
        userId: user.id,
        role: membership.role,
        threadId: thread.id,
        userContent: line,
        decisions: decisions.map((d) => ({ toolUseId: d.toolUseId ?? null, tool: d.tool, decision: d.decision, ...(d.args ? { args: d.args } : {}) })),
      },
      { onCursor: hooks.onCursor, shouldReconnect: hooks.shouldReconnect },
    ),
  );
}
