// ShapesOS — Phase 17 (latency): GET /api/agent-runs/[runId]/events?before=<seq>[&limit=]
//   → { steps: TimelineStep[] (oldest first), before: number | null }
//
// One older page of a run's timeline for the run page's "Load earlier
// steps" (the page itself renders only the newest page). Streamed text and
// usage bookkeeping are not steps (excluded, as on the page). Read-only.
//
// Access (fail-closed): signed in; a member (viewer+) of the current
// workspace; the run visible in that workspace (RLS-scoped read) — a run of
// another workspace answers 404, like the page.

import type { NextRequest } from "next/server";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { getAgentRun, listAgentRunEventsPage, RUN_EVENTS_PAGE } from "@/lib/agents/runs/service";
import { isStreamEvent } from "@/lib/agents/runs/usage";
import { isSandboxOutputEvent } from "@/lib/sandbox/run-view";
import { eventSteps } from "@/lib/aos/runs";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export async function GET(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer"))) {
    return Response.json({ error: "Forbidden: workspace members only" }, { status: 403 });
  }
  const { runId } = await params;
  if (!ID_RE.test(runId)) return Response.json({ error: "Run not found" }, { status: 404 });
  const sp = req.nextUrl.searchParams;
  const beforeRaw = sp.get("before") ?? "";
  if (!/^\d{1,9}$/.test(beforeRaw)) return Response.json({ error: "before (a step number) is required" }, { status: 400 });
  const limitRaw = Number(sp.get("limit") ?? RUN_EVENTS_PAGE);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : RUN_EVENTS_PAGE;
  try {
    const run = await getAgentRun(workspace.id, runId);
    if (!run) return Response.json({ error: "Run not found" }, { status: 404 });
    const page = await listAgentRunEventsPage(workspace.id, runId, { beforeSeq: Number(beforeRaw), limit });
    const events = page.events.filter((e) => !isStreamEvent(e) && !isSandboxOutputEvent(e));
    const steps = eventSteps(
      events.map((e) => ({ id: e.id, seq: e.seq, type: e.type, summary: e.summary, payload: e.payload, createdAt: e.createdAt.toISOString() })),
    );
    return Response.json({ steps, before: page.before }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err, "GET /api/agent-runs/[runId]/events");
  }
}
