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

export const TWIN_LIVE_HEARTBEAT_MS = 15_000;

export interface TwinLiveOptions {
  /** Loads the current snapshot (throws TwinNotFoundError when the site is gone). */
  snapshot: () => Promise<TwinSnapshot>;
  /** Re-checked every loop: false ends the stream. */
  stillAllowed: () => Promise<boolean>;
  pollMs?: number;
  maxMs?: number;
  heartbeatMs?: number;
}

const sameObjectSet = (a: TwinSnapshot, b: TwinSnapshot) =>
  a.objects.length === b.objects.length && a.objects.every((o, i) => o.id === b.objects[i]!.id);

/** The SSE body. The first snapshot is taken by the caller (so a 404 can be a normal response) and passed in. */
export function twinLiveStream(first: TwinSnapshot, opts: TwinLiveOptions): ReadableStream<Uint8Array> {
  const pollMs = opts.pollMs ?? TWIN_LIVE_POLL_MS;
  const maxMs = opts.maxMs ?? TWIN_LIVE_MAX_MS;
  const encoder = new TextEncoder();
  let closed = false;
  let wake: (() => void) | null = null;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(t);
        wake = null;
        resolve();
      };
    });

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": ping\n\n"));
      }, opts.heartbeatMs ?? TWIN_LIVE_HEARTBEAT_MS);
      const deadline = Date.now() + maxMs;
      let last = first;
      let reason = "max-duration";
      send("snapshot", first);
      try {
        while (!closed) {
          await sleep(Math.max(0, Math.min(pollMs, deadline - Date.now())));
          if (closed) break;
          if (Date.now() >= deadline) break;
          if (!(await opts.stillAllowed().catch(() => false))) {
            reason = "access-revoked";
            break;
          }
          let next: TwinSnapshot;
          try {
            next = await opts.snapshot();
          } catch (e) {
            reason = (e as { status?: number })?.status === 404 ? "site-gone" : "error";
            break;
          }
          if (!sameObjectSet(last, next) || last.site.id !== next.site.id) {
            send("snapshot", next);
          } else {
            const ops = diffSnapshots(last, next);
            if (ops.length) send("patch", ops);
          }
          last = next;
        }
        if (!closed) send("end", { reason });
      } finally {
        clearInterval(heartbeat);
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
      (wake as (() => void) | null)?.();
    },
  });
}

export const TWIN_SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;
