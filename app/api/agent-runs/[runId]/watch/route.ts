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
// Phase 16: GET …/watch?view=delegation streams a delegating run's plan
// instead — `event: delegation` with the DelegationView (lib/aos/delegation.ts)
// on connect and whenever a sub-agent's state changes, `event: end` when the
// run finishes or waits for the user. Access: signed in + the run visible in
// the caller's workspace (RLS-scoped read); no browser stream is needed.
//
// Transport notes: frames are latest-wins (a slow client skips to the
// newest frame, never queues stale ones). Deploy PR: both streams use the
// shared SSE helper (lib/http/sse.ts) — `retry:`, a `: ping` every 15 s and
// the graceful drain (`event: reconnect`, then close; the browser reconnects
// to another replica). Both are snapshot-style: a reconnect gets the current
// status + newest frame (or the current delegation view) at once, so they
// need no event id. Frames come from this process when the recording runs
// here, otherwise from the Postgres relay (lib/agents/runs/watch-relay.ts).
// One SSE connection is capped at WATCH_SSE_MAX_MS; the run finishing ends
// it earlier.

import type { NextRequest } from "next/server";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import {
  getWatchStreamAccess,
  subscribeWatchStream,
  WATCH_SSE_MAX_MS,
} from "@/lib/agents/runs/watch";
import { TERMINAL_RUN_STATUSES } from "@/lib/agents/runs/types";
import { loadDelegationView } from "@/lib/agents/delegation/store";
import { sseResponse, sseSleep } from "@/lib/http/sse";

export const dynamic = "force-dynamic";

const FRAME_POLL_MS = 2_000;

const DELEGATION_POLL_MS = 1_500;

/** Phase 16: stream a delegating run's plan (sub-agent states) until it settles. */
function delegationStream(workspaceId: string, runId: string, first: NonNullable<Awaited<ReturnType<typeof loadDelegationView>>>): Response {
  return sseResponse(async (ch) => {
    let last = JSON.stringify(first);
    ch.send("delegation", last);
    const deadline = Date.now() + WATCH_SSE_MAX_MS;
    let view = first;
    while (!ch.closed && view.live && Date.now() < deadline) {
      await sseSleep(ch, DELEGATION_POLL_MS);
      if (ch.closed) return;
      const next = await loadDelegationView(workspaceId, runId).catch(() => null);
      if (ch.closed) return;
      if (!next) {
        ch.send("end", { reason: "stream-ended" });
        return;
      }
      view = next;
      const json = JSON.stringify(next);
      if (json !== last) {
        last = json;
        ch.send("delegation", json);
      }
      if (next.runStatus === "awaiting_confirmation") {
        ch.send("end", { reason: "needs-you" });
        return;
      }
    }
    if (ch.closed) return;
    if (!view.live) ch.send("end", { reason: "run-finished" });
    else if (Date.now() >= deadline) ch.send("end", { reason: "watch-timeout" });
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { runId } = await params;
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (new URL(req.url).searchParams.get("view") === "delegation") {
    const view = await loadDelegationView(workspace.id, runId).catch(() => null);
    if (!view || view.plans.length === 0) return Response.json({ error: "No delegation plan for this run" }, { status: 404 });
    return delegationStream(workspace.id, runId, view);
  }
  const access = await getWatchStreamAccess(workspace.id, runId);
  if (!access) {
    return Response.json({ error: "No live stream for this run" }, { status: 404 });
  }

  return sseResponse(async (ch) => {
    const sub = subscribeWatchStream(runId, { workspaceId: workspace.id });
    ch.signal.addEventListener("abort", () => sub.close(), { once: true });
    try {
      ch.send("status", { status: access.status });
      let lastStatus = access.status;
      const deadline = Date.now() + WATCH_SSE_MAX_MS;
      while (!ch.closed && Date.now() < deadline) {
        const next = await sub.nextFrame(FRAME_POLL_MS);
        if (ch.closed) return;
        if (next === null) {
          // Poll timeout — re-check run status before waiting again.
        } else if ("ended" in next) {
          ch.send("end", { reason: "stream-ended" });
          return;
        } else {
          ch.send("frame", next.jpeg.toString("base64"));
        }

        // Re-verify workspace-scoped access on every loop: the run may
        // have finished (or moved out of scope) mid-watch.
        const cur = await getWatchStreamAccess(workspace.id, runId).catch(() => null);
        if (ch.closed) return;
        if (!cur) {
          ch.send("end", { reason: "stream-ended" });
          return;
        }
        if (cur.status !== lastStatus) {
          lastStatus = cur.status;
          ch.send("status", { status: lastStatus });
        }
        if (TERMINAL_RUN_STATUSES.has(lastStatus)) {
          ch.send("end", { reason: "run-finished" });
          return;
        }
      }
      if (!ch.closed && Date.now() >= deadline) ch.send("end", { reason: "watch-timeout" });
    } finally {
      sub.close();
    }
  });
}
