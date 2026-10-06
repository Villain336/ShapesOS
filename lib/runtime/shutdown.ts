// ShapesOS — Deploy PR (WS=state): ONE graceful-shutdown path per process.
//
// Production runs several web replicas behind a load balancer, and every
// deploy replaces them: the platform sends SIGTERM, waits a grace period
// (Render: 30 s by default; ECS: stopTimeout, 30 s by default) and then
// SIGKILLs. Without a drain, every open stream (SSE: run watch, twin live,
// chat) would hang until the kill and then drop with no hint, and in-flight
// agent turns running inside the request would be cut mid-step.
//
// What happens on SIGTERM / SIGINT (installShutdownHandlers):
//
//   1. draining = true. /api/health (readiness) answers 503 "draining" so the
//      load balancer stops sending new requests here. Next's own handler
//      (start-server.js) stops accepting connections in parallel.
//   2. Every open SSE stream gets its drain callback (lib/http/sse.ts): by
//      default `retry:` + `event: reconnect` and the stream closes, so the
//      browser reconnects — to another replica — and resumes with
//      Last-Event-ID. Streams that must finish a unit of work first (the
//      chat turn) drain cooperatively and are force-closed at the deadline.
//   3. The registered hooks run: the in-app cron runner stops ticking and
//      the in-app agent worker stops claiming; agent turns running inline in
//      a request hand off to the worker at their next step boundary (the
//      Phase 8 hand-off), and the ones still mid-call are handed off by abort
//      after SHUTDOWN_HANDOFF_MS (their transcript is saved; the worker
//      resumes from it).
//   4. Background work registered with trackBackgroundWork() and the streams
//      get until the deadline (SHUTDOWN_GRACE_MS, default 25 s — under the
//      platforms' 30 s) to finish; then the process exits. Next's handler
//      usually exits first, as soon as the server has closed.
//
// The worker process (scripts/worker.mts) uses the same module: same signal
// handling, same deadline, its own hooks.

export type DrainReason = "SIGTERM" | "SIGINT" | "manual";

export interface DrainableStream {
  /** Called once when the process starts draining. */
  drain(reason: DrainReason): void;
  /** Resolves when the stream has closed. */
  readonly done: Promise<void>;
}

type Hook = { name: string; run: (reason: DrainReason) => void | Promise<void> };

interface State {
  draining: boolean;
  reason: DrainReason | null;
  startedAt: number | null;
  streams: Set<DrainableStream>;
  background: Set<Promise<unknown>>;
  hooks: Hook[];
  installed: boolean;
  finished: Promise<void> | null;
}

// One state per process, even if the module is bundled twice (Next can load
// instrumentation and route code as separate module graphs).
const KEY = Symbol.for("shapesos.runtime.shutdown");
const g = globalThis as unknown as Record<symbol, State | undefined>;
const state: State = (g[KEY] ??= {
  draining: false,
  reason: null,
  startedAt: null,
  streams: new Set(),
  background: new Set(),
  hooks: [],
  installed: false,
  finished: null,
});

/** Default grace: under Render's and ECS's 30 s default stop timeouts. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 25_000;
/** Inline agent turns get this long to reach a step boundary before abort-handoff. */
export const DEFAULT_SHUTDOWN_HANDOFF_MS = 8_000;

function envMs(name: string, def: number, min: number, max: number, env: NodeJS.ProcessEnv): number {
  const n = Number((env[name] ?? "").trim());
  if (!(env[name] ?? "").trim() || !Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.round(n), min), max);
}

export function shutdownGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  return envMs("SHUTDOWN_GRACE_MS", DEFAULT_SHUTDOWN_GRACE_MS, 1_000, 600_000, env);
}

export function shutdownHandoffMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.min(envMs("SHUTDOWN_HANDOFF_MS", DEFAULT_SHUTDOWN_HANDOFF_MS, 0, 600_000, env), shutdownGraceMs(env));
}

export function isDraining(): boolean {
  return state.draining;
}

export function drainReason(): DrainReason | null {
  return state.reason;
}

/** Register an open stream; returns the unregister function. */
export function registerStream(stream: DrainableStream): () => void {
  state.streams.add(stream);
  if (state.draining) queueMicrotask(() => stream.drain(state.reason ?? "manual"));
  return () => {
    state.streams.delete(stream);
  };
}

export function openStreamCount(): number {
  return state.streams.size;
}

/** Keep the process up (until the deadline) for work that outlives its request. */
export function trackBackgroundWork<T>(p: Promise<T>): Promise<T> {
  const tracked = p.finally(() => state.background.delete(tracked));
  state.background.add(tracked);
  tracked.catch(() => undefined);
  return p;
}

/** Run `run` when the process starts draining (in registration order). */
export function onShutdown(name: string, run: Hook["run"]): void {
  if (state.hooks.some((h) => h.name === name)) return;
  state.hooks.push({ name, run });
}

export interface DrainOptions {
  graceMs?: number;
  /** Called when everything finished or the deadline passed (the process exit). */
  exit?: (code: number) => void;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
  /**
   * After everything drained, wait this long before exit (default
   * SHUTDOWN_FLUSH_MS). A stream's last frames — the `event: reconnect` —
   * are only enqueued when its producer finishes; exiting in the same tick
   * dropped them before the socket wrote them (caught by the two-instance
   * smoke). Next's own SIGTERM handler still exits first once its HTTP
   * server has closed, which happens after every response is flushed.
   */
  flushMs?: number;
}

/** Flush window between "everything drained" and exit. */
export const SHUTDOWN_FLUSH_MS = 1_000;

/**
 * Start draining (idempotent). Resolves when every stream and tracked task
 * finished, or at the deadline — whichever comes first — then calls exit.
 */
export function beginDrain(reason: DrainReason, opts: DrainOptions = {}): Promise<void> {
  if (state.finished) return state.finished;
  const now = opts.now ?? Date.now;
  const graceMs = opts.graceMs ?? shutdownGraceMs();
  const log = opts.log ?? ((msg: string, fields?: Record<string, unknown>) => console.log(`[shutdown] ${msg}`, fields ?? ""));
  state.draining = true;
  state.reason = reason;
  state.startedAt = now();
  log("draining", { reason, graceMs, streams: state.streams.size, background: state.background.size });

  for (const s of [...state.streams]) {
    try {
      s.drain(reason);
    } catch {
      // A stream that fails to drain is force-closed by its own deadline.
    }
  }
  const hookRuns = state.hooks.map(async (h) => {
    try {
      await h.run(reason);
    } catch (err) {
      log("shutdown hook failed", { hook: h.name, error: err instanceof Error ? err.message : String(err) });
    }
  });

  const everything = Promise.allSettled([
    ...hookRuns,
    ...[...state.streams].map((s) => s.done),
    ...[...state.background],
  ]).then(() => "done" as const);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), graceMs);
  });

  state.finished = Promise.race([everything, deadline]).then((how) => {
    if (timer) clearTimeout(timer);
    log(how === "done" ? "drained" : "grace period over", {
      tookMs: now() - (state.startedAt ?? now()),
      openStreams: state.streams.size,
      background: state.background.size,
    });
    if (how === "done" && opts.exit) {
      const flushMs = Math.max(0, opts.flushMs ?? SHUTDOWN_FLUSH_MS);
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          opts.exit?.(0);
          resolve();
        }, flushMs),
      );
    }
    opts.exit?.(0);
  });
  return state.finished;
}

/**
 * Install the SIGTERM / SIGINT handlers once per process. Next's standalone
 * server installs its own (it closes the HTTP server and exits); this one
 * runs alongside it, drains streams and hooks, and exits at the deadline at
 * the latest. A second signal exits at once.
 */
export function installShutdownHandlers(opts: { exit?: (code: number) => void; graceMs?: number } = {}): void {
  if (state.installed) return;
  state.installed = true;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const onSignal = (signal: "SIGTERM" | "SIGINT") => {
    if (state.draining) {
      exit(signal === "SIGINT" ? 130 : 143);
      return;
    }
    void beginDrain(signal, { graceMs: opts.graceMs, exit });
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));
}

/** Test seam: back to a fresh, non-draining process state. */
export function __resetShutdownForTests(): void {
  state.draining = false;
  state.reason = null;
  state.startedAt = null;
  state.streams.clear();
  state.background.clear();
  state.hooks = [];
  state.finished = null;
}
