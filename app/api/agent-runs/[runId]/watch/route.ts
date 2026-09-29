// Marketr — Phase 16 slice 7: live watch SSE endpoint.
//
// GET /api/agent-runs/[runId]/watch → text/event-stream carrying the run's
// live headed-browser frames:
//
//   event: status  data: {"status":"running"}     (emitted on connect + on change)
//   event: frame   data: <base64 JPEG>             (transient — never stored)
//   event: end     data: {"reason":"run-finished" | "stream-ended" | "watch-timeout"}
//
// Access control (fail-closed, both must hold):
//   1. the caller is signed in (requireUser → 401 otherwise);
//   2. getWatchStreamAccess(): a live stream is ACTIVE for the run AND the
//      run is visible in the caller's workspace (slice-5 service, RLS).
// A foreign runId, a finished run, or a run with no stream all answer 404
// with the same body — the client cannot distinguish which.
//
// Transport notes: frames are latest-wins (a slow client skips to the
// newest frame, never queues stale ones). Heartbeat comments keep proxies
// from idling the connection out. One SSE connection is capped at
// WATCH_SSE_MAX_MS; the run finishing ends it earlier.

import type { NextRequest } from "next/server";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import {
  getWatchStreamAccess,
  subscribeWatchStream,
  WATCH_SSE_MAX_MS,
} from "@/lib/agents/runs/watch";
import { TERMINAL_RUN_STATUSES } from "@/lib/agents/runs/types";

export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;
const FRAME_POLL_MS = 2_000;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { runId } = await params;
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const access = await getWatchStreamAccess(workspace.id, runId);
  if (!access) {
    return Response.json({ error: "No live stream for this run" }, { status: 404 });
  }

  const sub = subscribeWatchStream(runId);
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: string) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
      };
      send("status", JSON.stringify({ status: access.status }));
      let lastStatus = access.status;

      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": ping\n\n"));
      }, HEARTBEAT_MS);
      const deadline = Date.now() + WATCH_SSE_MAX_MS;

      try {
        while (!closed && Date.now() < deadline) {
          const next = await sub.nextFrame(FRAME_POLL_MS);
          if (closed) break;
          if (next === null) {
            // Poll timeout — re-check run status before waiting again.
          } else if ("ended" in next) {
            send("end", JSON.stringify({ reason: "stream-ended" }));
            break;
          } else {
            send("frame", next.jpeg.toString("base64"));
          }

          // Re-verify workspace-scoped access on every loop: the run may
          // have finished (or moved out of scope) mid-watch.
          const cur = await getWatchStreamAccess(workspace.id, runId).catch(() => null);
          if (!cur) {
            send("end", JSON.stringify({ reason: "stream-ended" }));
            break;
          }
          if (cur.status !== lastStatus) {
            lastStatus = cur.status;
            send("status", JSON.stringify({ status: lastStatus }));
          }
          if (TERMINAL_RUN_STATUSES.has(lastStatus)) {
            send("end", JSON.stringify({ reason: "run-finished" }));
            break;
          }
        }
        if (!closed && Date.now() >= deadline) {
          send("end", JSON.stringify({ reason: "watch-timeout" }));
        }
      } finally {
        clearInterval(heartbeat);
        sub.close();
        closed = true;
        try {
          controller.close();
        } catch {
          // Client already gone.
        }
      }
    },
    cancel() {
      closed = true;
      sub.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
