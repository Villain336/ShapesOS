// ShapesOS — Phase 19B (WS=engine): streaming a town run to the browser.
// Commercial layer (entitlement dress_rehearsal). Architecture: lib/sim/engine.ts.
//
// Server-Sent Events through the shared helper (lib/http/sse.ts: `retry:`,
// a heartbeat every 15 s, a SIGTERM drain). Next route handlers can't
// upgrade to a WebSocket (19A learned this), and the plan's WebSocket was
// only ever a pipe: the client needs each resident's PLANNED PATH with
// timestamps plus the decisions, then interpolates locally — so bandwidth
// stays small at any playback speed (1× … 1,000×; speed is the client's).
//
//   event: meta      the run (status, days, seeds) — first
//   event: snapshot  the hourly snapshot at or before a seek (`from` minute)
//   event: events    a page of events (trips with paths, arrivals, decisions…),
//                    id = "<variant>:<last seq>" — the Last-Event-ID cursor
//   event: status    the run moved on (running → completed / partial …)
//   event: end       nothing more will come (the run finished and was sent)
// A reconnect resumes after the Last-Event-ID; while the run is still going
// the stream polls for new rows (they're flushed every sim-day).

import type { PanelActor } from "@/lib/panel/service.server";
import { gate } from "@/lib/panel/service.server";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { HttpError } from "@/lib/api/errors";
import type { Variant } from "./runner";
import { eventsAfter, firstSeqAtOrAfter, snapshotAtOrBefore } from "./store.server";

export const STREAM_PAGE = 500;
export const STREAM_POLL_MS = 1_000;

export interface StreamChannel {
  send(event: string | null, data: unknown, opts?: { id?: string | null }): boolean;
  readonly closed: boolean;
  readonly signal: AbortSignal;
}

export interface StreamOptions {
  variant: Variant;
  /** Seek: start at this sim minute (via the snapshot at or before it). */
  fromMinute?: number | null;
  /** "<variant>:<seq>" — resume after it. */
  lastEventId?: string | null;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const TERMINAL = new Set(["completed", "partial", "failed", "cancelled"]);

export function parseCursor(id: string | null | undefined, variant: Variant): number | null {
  const m = /^([AB]):(-?\d+)$/.exec(id ?? "");
  return m && m[1] === variant ? Number(m[2]) : null;
}

export async function streamTownRun(actor: PanelActor, runId: string, opts: StreamOptions, ch: StreamChannel): Promise<void> {
  await gate(actor, "viewer");
  const status = async () => {
    const r = await withWorkspaceScope(actor.workspaceId, (tx) => tx.simRun.findFirst({ where: { id: runId, workspaceId: actor.workspaceId }, select: { status: true, days: true, seeds: true, scenarioB: true, progress: true } }));
    if (!r) throw new HttpError(404, "That run wasn't found.");
    return r;
  };
  let run = await status();
  if (opts.variant === "B" && !run.scenarioB) throw new HttpError(400, "This run has no scenario B.");
  ch.send("meta", { runId, status: run.status, days: run.days, seeds: run.seeds, variant: opts.variant });

  let cursor = parseCursor(opts.lastEventId, opts.variant);
  if (cursor === null) {
    cursor = -1;
    if (opts.fromMinute !== undefined && opts.fromMinute !== null && opts.fromMinute > 0) {
      const snap = await snapshotAtOrBefore(actor.workspaceId, runId, opts.variant, 0, Math.floor(opts.fromMinute / 60));
      if (snap) {
        ch.send("snapshot", snap.state);
        const seq = await firstSeqAtOrAfter(actor.workspaceId, runId, opts.variant, 0, snap.t);
        cursor = seq === null ? cursor : seq - 1;
      }
    }
  }
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastStatus = run.status;
  while (!ch.closed && !ch.signal.aborted) {
    const page = await eventsAfter(actor.workspaceId, runId, opts.variant, 0, cursor, STREAM_PAGE);
    if (page.length) {
      cursor = page[page.length - 1]!.seq;
      const events = page.map(({ variant: _v, seedIndex: _s, ...e }) => e);
      if (!ch.send("events", events, { id: `${opts.variant}:${cursor}` })) return;
      if (page.length === STREAM_PAGE) continue;
    }
    run = await status();
    if (run.status !== lastStatus) {
      lastStatus = run.status;
      ch.send("status", { status: run.status, progress: run.progress });
    }
    if (TERMINAL.has(run.status)) {
      // One more read: rows flushed just before the status changed.
      const tail = await eventsAfter(actor.workspaceId, runId, opts.variant, 0, cursor, STREAM_PAGE);
      if (tail.length) continue;
      ch.send("end", { status: run.status });
      return;
    }
    await sleep(opts.pollMs ?? STREAM_POLL_MS);
  }
}
