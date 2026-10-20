// ShapesOS — Phase 13 (twincore): the twin LIVE stream (server-only).
//
// GET /api/twin/sites/[id]/live wires this up after its own auth checks;
// it is modelled on app/api/agent-runs/[runId]/watch/route.ts:
//
//   event: snapshot   data: TwinSnapshot     first frame, and after a layout
//                                            change (the object set changed)
//   event: patch      data: TwinPatchOp[]    RFC 6902 ops against the last
//                                            frame (lib/twin/derive.ts)
//   event: end        data: { reason }       access-revoked | site-gone |
//                                            max-duration | error
//   ": ping" comment every 15 s.
//
// Safe across replicas: there is no in-memory bus — every loop re-reads the
// database (siteSnapshot) every pollMs and diffs against what THIS
// connection last sent. Access is re-checked on every loop.

import { TWIN_LIVE_MAX_MS, TWIN_LIVE_POLL_MS, type TwinSnapshot } from "./types";
import { diffSnapshots } from "./derive";
import { SSE_HEADERS, SSE_HEARTBEAT_MS, sseSleep, sseStream, type SseOptions } from "@/lib/http/sse";

export const TWIN_LIVE_HEARTBEAT_MS = SSE_HEARTBEAT_MS;

export interface TwinLiveOptions {
  /** Loads the current snapshot (throws TwinNotFoundError when the site is gone). */
  snapshot: () => Promise<TwinSnapshot>;
  /** Re-checked every loop: false ends the stream. */
  stillAllowed: () => Promise<boolean>;
  /**
   * Phase 17 (latency): the change signal (lib/twin/signal.ts). While it does
   * not move the snapshot is not rebuilt (nothing it reads changed); absent,
   * every loop rebuilds as before.
   */
  signal?: () => Promise<string>;
  pollMs?: number;
  maxMs?: number;
  heartbeatMs?: number;
  /** Deploy PR: SSE helper options (tests inject a clock / registry). */
  sse?: SseOptions;
}

const sameObjectSet = (a: TwinSnapshot, b: TwinSnapshot) =>
  a.objects.length === b.objects.length && a.objects.every((o, i) => o.id === b.objects[i]!.id);

/**
 * The SSE body. The first snapshot is taken by the caller (so a 404 can be a
 * normal response) and passed in. Deploy PR: built on lib/http/sse.ts — the
 * `: ping` heartbeat, `retry:` and the graceful drain come from there. On a
 * drain the stream says `event: reconnect` and closes; the client reconnects
 * (to another replica) and gets a fresh `snapshot` — the snapshot IS the
 * resume point, so no event id is needed.
 */
export function twinLiveStream(first: TwinSnapshot, opts: TwinLiveOptions): ReadableStream<Uint8Array> {
  const pollMs = opts.pollMs ?? TWIN_LIVE_POLL_MS;
  const maxMs = opts.maxMs ?? TWIN_LIVE_MAX_MS;
  return sseStream(
    async (ch) => {
      const deadline = Date.now() + maxMs;
      let last = first;
      let reason = "max-duration";
      let lastSignal = opts.signal ? await opts.signal().catch(() => null) : null;
      ch.send("snapshot", first);
      while (!ch.closed) {
        await sseSleep(ch, Math.max(0, Math.min(pollMs, deadline - Date.now())));
        if (ch.closed) return;
        if (Date.now() >= deadline) break;
        if (!(await opts.stillAllowed().catch(() => false))) {
          reason = "access-revoked";
          break;
        }
        if (opts.signal) {
          const sig = await opts.signal().catch(() => null);
          if (sig !== null && sig === lastSignal) continue; // nothing the snapshot reads changed
          lastSignal = sig;
        }
        let next: TwinSnapshot;
        try {
          next = await opts.snapshot();
        } catch (e) {
          reason = (e as { status?: number })?.status === 404 ? "site-gone" : "error";
          break;
        }
        if (ch.closed) return;
        if (!sameObjectSet(last, next) || last.site.id !== next.site.id) {
          ch.send("snapshot", next);
        } else {
          const ops = diffSnapshots(last, next);
          if (ops.length) ch.send("patch", ops);
        }
        last = next;
      }
      if (!ch.closed) ch.send("end", { reason });
    },
    { heartbeatMs: opts.heartbeatMs, ...(opts.sse ?? {}) },
  );
}

export const TWIN_SSE_HEADERS = SSE_HEADERS;
