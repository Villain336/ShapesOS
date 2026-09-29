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
// In-process registry: the recorder and the SSE route run in the same
// Next server process, exactly like the slice-5 recording semaphore.
// Cross-process fan-out is out of scope (slice 8 territory).
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

/**
 * Claim the single live-stream slot for a run. Fail-fast when a stream is
 * already active (same posture as the slice-5 recording semaphore).
 */
export function startWatchStream(runId: string): void {
  const existing = streams.get(runId);
  if (existing?.active) throw new WatchBusyError(runId);
  streams.set(runId, { active: true, seq: 0, latest: null, ended: false, waiters: new Set() });
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
}

/**
 * End the stream: all waiting subscribers resolve `ended`, late
 * subscribers get `ended` immediately, and the slot is freed so a
 * (never-reused) run id cannot leak the entry.
 */
export function endWatchStream(runId: string): void {
  const s = streams.get(runId);
  if (!s) return;
  s.active = false;
  s.ended = true;
  for (const w of [...s.waiters]) {
    s.waiters.delete(w);
    w(null);
  }
  streams.delete(runId);
}

/** True while a live stream is producing frames for the run. */
export function isWatchStreamActive(runId: string): boolean {
  return streams.get(runId)?.active === true;
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

/** Attach a subscriber to a run's live stream (route-checked, not auth). */
export function subscribeWatchStream(runId: string): WatchSubscription {
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
  if (!isWatchStreamActive(runId)) return null;
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
): Promise<(() => Promise<void>) | null> {
  if (!page.startScreencast) return null;
  const stopScreencast = await page.startScreencast(WATCH_CAPTURE_OPTS, (jpeg) =>
    publishWatchFrame(runId, jpeg),
  );
  try {
    startWatchStream(runId);
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
      endWatchStream(runId);
    }
  };
}

/** Test seam: drop all stream state (production code never calls this). */
export function _resetWatchRegistryForTests(): void {
  streams.clear();
}
