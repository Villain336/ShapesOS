// Marketr — Phase 16 slice 7: live watch (real-time headed-browser stream).
//
// Decision (b): true watch-it-work stream, not screenshots-on-interval.
// Mechanism: CDP screencast (Page.startScreencast → JPEG frames) attached
// to the slice-5 recorder's live page, fanned out to dashboard subscribers
// over SSE. Frames are TRANSIENT — they are never written to disk; the
// slice-5 WebM remains the permanent record.
//
// SERVER-SIDE ONLY: nothing here is reachable from the client. The SSE
// route (app/api/agent-runs/[runId]/watch) is the only client entry point,
// and it re-checks workspace ownership via getAgentRun (RLS fail-closed)
// before attaching a subscriber.
//
// In-process registry: subscribers in the producer's own process read the
// frames straight from memory. Deploy PR (WS=state): the recording runs on
// the worker and the SSE route on any web replica, so a stream started with
// its workspace id is ALSO relayed through Postgres (./watch-relay.ts:
// latest frame only, uploaded only while someone watches, deleted at the
// end). A subscriber in another process reads the relay instead. The
// one-stream-per-run claim stays in-process: a run is recorded by exactly
// one process (the one that owns its lease).
//
// Guardrails (spec §7 task): one live stream (producer) per run —
// startWatchStream() fails fast with WatchBusyError when a stream is
// already active, mirroring RecorderBusyError. Multiple dashboard
// subscribers may share one stream; every subscriber is workspace-scoped
// by the route. endWatchStream() is called by the recorder's stop() /
// teardown, so frames stop the moment the run finishes.

import type { RecorderPage } from "./recorder";
import { getAgentRun } from "./service";
import type { AgentRunStatus } from "./types";
import {
  postgresWatchRelay,
  WATCH_RELAY_FLUSH_MS,
  WATCH_RELAY_HEARTBEAT_MS,
  WATCH_RELAY_POLL_MS,
  type WatchRelay,
} from "./watch-relay";

export class WatchBusyError extends Error {
  constructor(runId: string) {
    super(`live watch already active for run ${runId}: one stream per run`);
    this.name = "WatchBusyError";
  }
}

/** Screencast capture profile — JPEG frames sized for the dashboard surface. */
export const WATCH_CAPTURE_OPTS = {
  quality: 70,
  everyNthFrame: 2,
  maxWidth: 1280,
  maxHeight: 800,
} as const;

/** Absolute cap on one SSE watch connection (a stuck run must not leak it). */
export const WATCH_SSE_MAX_MS = 30 * 60 * 1000;

interface WatchStreamState {
  active: boolean;
  seq: number;
  latest: Buffer | null;
  ended: boolean;
  waiters: Set<(frame: { jpeg: Buffer; seq: number } | null) => void>;
}

const streams = new Map<string, WatchStreamState>();

// ---- cross-process relay (Deploy PR) ----

let relayOverride: WatchRelay | null | undefined;
let defaultRelay: WatchRelay | null = null;

/** The relay to use: Postgres whenever a database is configured. */
function relay(): WatchRelay | null {
  if (relayOverride !== undefined) return relayOverride;
  if (!process.env.DATABASE_URL?.trim()) return null;
  return (defaultRelay ??= postgresWatchRelay());
}

/** Test seam: force a relay (null = none); undefined restores the default. */
export function _setWatchRelayForTests(r: WatchRelay | null | undefined): void {
  relayOverride = r;
}

const relayWarned = new Set<string>();
function relayWarn(op: string, err: unknown): void {
  if (relayWarned.has(op)) return;
  relayWarned.add(op);
  console.warn(`[watch-relay] ${op} failed (live watch from other instances may lag): ${err instanceof Error ? err.message : String(err)}`);
}

/** Producer side of the relay for one run: throttled, only while watched. */
class RelayProducer {
  private latest: Buffer | null = null;
  private latestN = 0;
  private flushedN = 0;
  private watched = false;
  private lastFlushAt = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private opened: Promise<void>;

  constructor(
    private readonly r: WatchRelay,
    private readonly workspaceId: string,
    private readonly runId: string,
  ) {
    this.opened = r.open(workspaceId, runId).catch((err) => relayWarn("open", err));
    this.heartbeatTimer = setInterval(() => void this.beat(), WATCH_RELAY_HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  private async beat(): Promise<void> {
    if (this.stopped) return;
    await this.opened;
    try {
      const hb = await this.r.heartbeat(this.workspaceId, this.runId);
      this.watched = hb.watched;
      if (this.watched && this.latestN > this.flushedN) this.schedule();
    } catch (err) {
      relayWarn("heartbeat", err);
    }
  }

  frame(jpeg: Buffer): void {
    if (this.stopped) return;
    this.latest = jpeg;
    this.latestN += 1;
    if (this.watched) this.schedule();
  }

  private schedule(): void {
    if (this.flushTimer || this.stopped) return;
    const wait = Math.max(0, this.lastFlushAt + WATCH_RELAY_FLUSH_MS - Date.now());
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, wait);
    this.flushTimer.unref?.();
  }

  private async flush(): Promise<void> {
    if (this.stopped || !this.latest || this.latestN <= this.flushedN) return;
    const n = this.latestN;
    const jpeg = this.latest;
    this.lastFlushAt = Date.now();
    await this.opened;
    try {
      const res = await this.r.publish(this.workspaceId, this.runId, jpeg);
      this.flushedN = n;
      this.watched = res?.watched ?? false;
    } catch (err) {
      relayWarn("publish", err);
    }
    if (this.watched && this.latestN > this.flushedN) this.schedule();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.opened;
    await this.r.end(this.workspaceId, this.runId).catch((err) => relayWarn("end", err));
  }
}

const producers = new Map<string, RelayProducer>();

/**
 * Claim the single live-stream slot for a run. Fail-fast when a stream is
 * already active (same posture as the slice-5 recording semaphore). With
 * `workspaceId` the frames are also relayed to other processes.
 */
export function startWatchStream(runId: string, opts: { workspaceId?: string } = {}): void {
  const existing = streams.get(runId);
  if (existing?.active) throw new WatchBusyError(runId);
  streams.set(runId, { active: true, seq: 0, latest: null, ended: false, waiters: new Set() });
  const r = opts.workspaceId ? relay() : null;
  if (r && opts.workspaceId) producers.set(runId, new RelayProducer(r, opts.workspaceId, runId));
}

/** Publish one JPEG frame; no-op when no stream is active for the run. */
export function publishWatchFrame(runId: string, jpeg: Buffer): void {
  const s = streams.get(runId);
  if (!s?.active || s.ended) return;
  s.seq += 1;
  s.latest = jpeg;
  const frame = { jpeg, seq: s.seq };
  for (const w of [...s.waiters]) {
    s.waiters.delete(w);
    w(frame);
  }
  producers.get(runId)?.frame(jpeg);
}

/**
 * End the stream: all waiting subscribers resolve `ended`, late
 * subscribers get `ended` immediately, and the slot is freed so a
 * (never-reused) run id cannot leak the entry. The relay row is deleted.
 */
export function endWatchStream(runId: string): Promise<void> {
  const producer = producers.get(runId);
  producers.delete(runId);
  const s = streams.get(runId);
  if (s) {
    s.active = false;
    s.ended = true;
    for (const w of [...s.waiters]) {
      s.waiters.delete(w);
      w(null);
    }
    streams.delete(runId);
  }
  return producer ? producer.stop() : Promise.resolve();
}

/** True while a live stream is producing frames for the run IN THIS PROCESS. */
export function isWatchStreamActive(runId: string): boolean {
  return streams.get(runId)?.active === true;
}

/** True while a live stream produces frames for the run in ANY process. */
export async function isWatchStreamLive(workspaceId: string, runId: string): Promise<boolean> {
  if (isWatchStreamActive(runId)) return true;
  const r = relay();
  if (!r) return false;
  return r.isLive(workspaceId, runId).catch((err) => {
    relayWarn("isLive", err);
    return false;
  });
}

export interface WatchSubscription {
  /**
   * Resolve with the latest frame newer than the last one this subscriber
   * saw, `{ ended: true }` when the stream finished, or `null` on timeout.
   * Latest-wins: a slow subscriber skips to the newest frame instead of
   * queueing stale ones.
   */
  nextFrame(timeoutMs: number): Promise<{ jpeg: Buffer; seq: number } | { ended: true } | null>;
  close(): void;
}

/**
 * Attach a subscriber to a run's live stream (route-checked, not auth).
 * The producer's own process reads frames from memory; any other process
 * (given the workspace id) reads them from the relay.
 */
export function subscribeWatchStream(runId: string, opts: { workspaceId?: string } = {}): WatchSubscription {
  const r = opts.workspaceId ? relay() : null;
  if (!streams.has(runId) && r && opts.workspaceId) return relaySubscription(r, opts.workspaceId, runId);
  return memorySubscription(runId);
}

/** Test seam: subscribe exactly as another process would (through the relay). */
export function _relaySubscriptionForTests(workspaceId: string, runId: string, r: WatchRelay | null = relay()): WatchSubscription {
  if (!r) throw new Error("no watch relay configured");
  return relaySubscription(r, workspaceId, runId);
}

/** Cross-process subscriber: polls the relay (latest-wins, like memory). */
function relaySubscription(r: WatchRelay, workspaceId: string, runId: string): WatchSubscription {
  let lastSeen = 0;
  let closed = false;
  return {
    async nextFrame(timeoutMs: number) {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      for (;;) {
        if (closed) return { ended: true };
        let polled;
        try {
          polled = await r.poll(workspaceId, runId, lastSeen);
        } catch (err) {
          relayWarn("poll", err);
          polled = null;
        }
        if (polled?.state === "ended") return { ended: true };
        if (polled?.state === "live" && polled.frame && polled.frame.seq > lastSeen) {
          lastSeen = polled.frame.seq;
          return polled.frame;
        }
        const left = deadline - Date.now();
        if (left <= 0) return null;
        await new Promise((res) => setTimeout(res, Math.min(WATCH_RELAY_POLL_MS, left)));
      }
    },
    close() {
      closed = true;
    },
  };
}

function memorySubscription(runId: string): WatchSubscription {
  let lastSeen = 0;
  let closed = false;
  return {
    nextFrame(timeoutMs: number) {
      return new Promise((resolve) => {
        if (closed) return resolve({ ended: true });
        const s = streams.get(runId);
        if (!s || !s.active || s.ended) return resolve({ ended: true });
        if (s.latest && s.seq > lastSeen) {
          lastSeen = s.seq;
          return resolve({ jpeg: s.latest, seq: s.seq });
        }
        let timer: ReturnType<typeof setTimeout> | null = null;
        const waiter = (frame: { jpeg: Buffer; seq: number } | null) => {
          if (timer) clearTimeout(timer);
          s.waiters.delete(waiter);
          if (closed || !frame) return resolve({ ended: true });
          lastSeen = frame.seq;
          resolve(frame);
        };
        s.waiters.add(waiter);
        // Re-check after registering: the stream may have ended in between.
        const cur = streams.get(runId);
        if (!cur || !cur.active || cur.ended) {
          s.waiters.delete(waiter);
          return resolve({ ended: true });
        }
        if (cur.latest && cur.seq > lastSeen) {
          s.waiters.delete(waiter);
          lastSeen = cur.seq;
          return resolve({ jpeg: cur.latest, seq: cur.seq });
        }
        timer = setTimeout(() => {
          s.waiters.delete(waiter);
          resolve(null);
        }, Math.max(0, timeoutMs));
      });
    },
    close() {
      closed = true;
    },
  };
}

/**
 * Route-level access check for the SSE watch endpoint: the run must have an
 * ACTIVE live stream AND be visible in the caller's workspace (RLS
 * fail-closed via getAgentRun). Returns the run status for the client, or
 * null when the route must answer 404 (foreign run, finished run, or no
 * stream — the client cannot distinguish which, by design).
 */
export async function getWatchStreamAccess(
  workspaceId: string,
  runId: string,
): Promise<{ status: AgentRunStatus } | null> {
  if (!(await isWatchStreamLive(workspaceId, runId))) return null;
  const run = await getAgentRun(workspaceId, runId);
  if (!run) return null;
  return { status: run.status as AgentRunStatus };
}

/**
 * Attach the live screencast to a recorder page. Returns a detach function,
 * or null when the page cannot screencast (stub launchers, headless-shell
 * builds without the CDP surface) — the caller then skips the stream
 * silently instead of failing the run.
 *
 * The screencast starts BEFORE the stream slot is claimed so a producer
 * that cannot capture never occupies the one-stream-per-run slot; on a
 * claim conflict the screencast is stopped again.
 */
export async function attachWatch(
  page: RecorderPage,
  runId: string,
  workspaceId?: string,
): Promise<(() => Promise<void>) | null> {
  if (!page.startScreencast) return null;
  const stopScreencast = await page.startScreencast(WATCH_CAPTURE_OPTS, (jpeg) =>
    publishWatchFrame(runId, jpeg),
  );
  try {
    startWatchStream(runId, { workspaceId });
  } catch (err) {
    await stopScreencast().catch(() => undefined);
    throw err;
  }
  let detached = false;
  return async () => {
    if (detached) return;
    detached = true;
    try {
      await stopScreencast();
    } finally {
      await endWatchStream(runId);
    }
  };
}

/** Test seam: drop all stream state (production code never calls this). */
export function _resetWatchRegistryForTests(): void {
  streams.clear();
  producers.clear();
}
