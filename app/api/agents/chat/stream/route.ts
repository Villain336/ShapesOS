// ShapesOS — Deploy PR (WS=state): resume a chat turn's AG-UI stream.
// GET /api/agents/chat/stream?runId=<agentRunId>&aguiRunId=<id>[&after=<seq>]
//   (or Last-Event-ID: <agentRunId>:<seq>, which wins over ?after=)
//   → text/event-stream continuing the turn from that run-timeline cursor:
//     the remaining TEXT_MESSAGE_* / TOOL_CALL_* events, the final text and
//     RUN_FINISHED — or `event: reconnect` again if this server drains too.
//
// Used after the POST /api/agents/chat stream ended with `event: reconnect`
// (its server was shutting down; the turn was handed to the worker) or was
// cut. Read-only: it only tails the run's timeline.
//
// Access (fail-closed, same rules as the POST): signed in; the run must be
// visible in the thread's workspace (RLS-scoped read) and belong to a thread
// of THIS user in a project the user can access, with the editor role.
// Anything else answers 404 with one body.

import { accessibleWorkspaceWhere, requireProjectRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getAgentRun } from "@/lib/agents/runs/service";
import { aguiStreamResponse, resumeChatTurnAgui } from "@/lib/agents/agui/adapter";
import { lastEventIdOf } from "@/lib/http/sse";

export const dynamic = "force-dynamic";

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const AGUI_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

function notFound(): Response {
  return Response.json({ error: "Stream not found" }, { status: 404 });
}

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const runId = url.searchParams.get("runId") ?? "";
  const aguiRunId = url.searchParams.get("aguiRunId") ?? "";
  if (!ID_RE.test(runId) || !AGUI_ID_RE.test(aguiRunId)) return Response.json({ error: "runId and aguiRunId are required" }, { status: 400 });

  // The cursor: Last-Event-ID "<runId>:<seq>" (EventSource-style), else ?after=.
  let afterSeq = -1;
  const lastId = lastEventIdOf(req);
  const m = lastId ? /^([A-Za-z0-9_-]{1,80}):(-?\d{1,9})$/.exec(lastId) : null;
  if (m && m[1] === runId) afterSeq = Number(m[2]);
  else if (/^-?\d{1,9}$/.test(url.searchParams.get("after") ?? "")) afterSeq = Number(url.searchParams.get("after"));

  // Find the run in a workspace the user can access (RLS-scoped reads), then
  // require its thread to be this user's, with the editor role (like the POST).
  const workspaces = await prisma.workspace.findMany({ where: accessibleWorkspaceWhere(user.id), select: { id: true }, take: 100 });
  for (const ws of workspaces) {
    const run = await getAgentRun(ws.id, runId).catch(() => null);
    if (!run) continue;
    if (!run.threadId) return notFound();
    const thread = await prisma.aiChatThread.findFirst({
      where: { id: run.threadId, userId: user.id },
      select: { id: true, projectId: true, project: { select: { workspaceId: true } } },
    });
    if (!thread || thread.project.workspaceId !== ws.id) return notFound();
    if (!(await requireProjectRole(user.id, thread.projectId, "editor"))) return notFound();
    return aguiStreamResponse(
      (hooks) =>
        resumeChatTurnAgui(
          { workspaceId: ws.id, threadId: thread.id, agentRunId: runId, aguiRunId, afterSeq },
          { onCursor: hooks.onCursor, shouldReconnect: hooks.shouldReconnect },
        ),
      { lastEventId: lastId },
    );
  }
  return notFound();
}
