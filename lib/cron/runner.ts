// ShapesOS — in-app cron runner (Phase 6 runtime).
//
// Drives the schedule table in lib/cron/jobs.ts from inside the app server,
// so a self-hosted install runs its sweeps without an external crontab.
// Started from instrumentation.ts; see cronRunnerDecision() for when.
//
// How a tick works (every TICK_MS, on every replica):
//   1. The store (lib/cron/store.ts) opens a short transaction and calls
//      pg_try_advisory_xact_lock. Only the replica that gets the lock goes
//      on; the others skip this tick. Inside the lock it reads the latest
//      cron_runs row per job, decides which jobs are due (planTick, below),
//      inserts a "running" row for each and commits — which releases the
//      lock. The claim rows, not the lock, carry "this job is running" to the
//      other replicas, so the lock is held for milliseconds, never for the
//      length of a job.
//   2. The claiming replica runs its claimed jobs: a random start jitter,
//      then an HTTP POST to its own origin (http://127.0.0.1:$PORT by
//      default) with the job's bearer secret — so lib/cron/gate.ts and the
//      route handler run exactly as they do for an external cron.
//   3. Each run ends ok (2xx), failed (non-2xx or a network error) or timeout
//      (no answer within the job's timeoutMs), recorded on its cron_runs row
//      and logged as one structured line.
//
// Why a per-tick transaction lock rather than a session lock held by a
// leader: Prisma pools its connections, so a session-level advisory lock
// would land on an arbitrary pooled connection and could be "released" by
// someone else's query on it; holding it would need a dedicated pg client
// (a new dependency). A transaction-scoped lock is released by COMMIT on the
// same connection, needs nothing new, can never be orphaned by a crashed
// replica, and the claim rows make the decision durable: a restart or a
// failover to another replica never re-fires a slot that already ran.
//
// No overlap: a job with a "running" row (or running in this process) is not
// claimed again until that run finishes or its timeout plus a grace period
// has passed (a replica that died mid-run). Timeout caveat: aborting the HTTP
// call stops the runner waiting, but the route handler on the server side
// may still finish its work; every sweep is written to be idempotent (claims,
// SKIP LOCKED, per-row guards), so a late finish is harmless.
//
// Missed slots (downtime): a job fires once on the first tick after the slot
// and then waits for its next future slot — the same "fire once, never
// replay every window" rule as the scheduler tick.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { nextRunAfter } from "@/lib/scheduler/cron";
import { log as defaultLog, type Logger } from "@/lib/observability/log";

/** The part of the structured logger the runner uses. */
export type RunnerLogger = Pick<Logger, "debug" | "info" | "warn" | "error">;
import { CRON_JOBS, jobMaxJitterMs, jobSchedule, jobSecretEnv, type CronJob } from "./jobs";

export { CRON_JOBS, type CronJob } from "./jobs";

/** How often every replica tries for the tick lock. */
export const TICK_MS = 15_000;
/** Delay before the first tick, so the HTTP server is listening. */
export const FIRST_TICK_DELAY_MS = 10_000;
/** Extra time past a job's timeout before a "running" row counts as abandoned. */
export const STALE_GRACE_MS = 2 * 60_000;
/** Bytes of a failed response kept as the run's error excerpt. */
const ERROR_EXCERPT_BYTES = 2_048;
const ERROR_MAX_CHARS = 500;

export type CronRunStatus = "running" | "ok" | "failed" | "timeout";

/** The latest cron_runs row for a job, as the planner sees it. */
export interface LastRun {
  runId: string;
  scheduledFor: Date;
  startedAt: Date;
  status: CronRunStatus;
}

export interface ClaimedRun {
  runId: string;
  job: CronJob;
  scheduledFor: Date;
}

export interface RunResult {
  status: Exclude<CronRunStatus, "running">;
  httpStatus: number | null;
  durationMs: number;
  error: string | null;
}

export interface ClaimArgs {
  jobs: readonly CronJob[];
  now: Date;
  /** When this runner started — the "last slot" for jobs that never ran. */
  baseline: Date;
  /** Jobs running in this process right now (never claimed again). */
  localRunning: ReadonlySet<string>;
}

/** Persistence + cluster-wide lock. lib/cron/store.ts is the Postgres one. */
export interface CronStore {
  /** Claim due jobs under the tick lock; null when another replica holds it. */
  claimDue(args: ClaimArgs): Promise<ClaimedRun[] | null>;
  finish(runId: string, result: RunResult, finishedAt: Date): Promise<void>;
}

export interface CallResult {
  status: number;
  /** A short excerpt of the body (used only for failed runs). */
  excerpt: string;
}

/** Performs one job's HTTP call. Must honour `signal`. */
export type JobCaller = (job: CronJob, opts: { signal: AbortSignal }) => Promise<CallResult>;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    // Never keep a process (a script, a test) alive just for the runner.
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

// ---------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;

/** The UTC minute a run started in — recorded as the slot it covers. */
export function slotFor(now: Date): Date {
  return new Date(Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS);
}

/** True when the job's next slot after `last` is at or before `now`. */
export function isJobDue(job: CronJob, last: Date, now: Date): boolean {
  return nextRunAfter(jobSchedule(job), last).getTime() <= now.getTime();
}

export interface TickPlan {
  /** Jobs to claim this tick. */
  due: CronJob[];
  /** "running" rows whose runner is gone (past timeout + grace). */
  stale: string[];
}

/**
 * Decide what a tick claims. Pure: the store calls it inside the lock with
 * the latest row per job.
 */
export function planTick(
  jobs: readonly CronJob[],
  latest: ReadonlyMap<string, LastRun>,
  now: Date,
  baseline: Date,
  localRunning: ReadonlySet<string> = new Set(),
): TickPlan {
  const due: CronJob[] = [];
  const stale: string[] = [];
  for (const job of jobs) {
    if (localRunning.has(job.key)) continue;
    const last = latest.get(job.key);
    if (last?.status === "running") {
      const abandonedAt = last.startedAt.getTime() + job.timeoutMs + STALE_GRACE_MS;
      if (now.getTime() < abandonedAt) continue; // still running somewhere
      stale.push(last.runId);
    }
    if (isJobDue(job, last?.scheduledFor ?? baseline, now)) due.push(job);
  }
  return { due, stale };
}

// ---------------------------------------------------------------------------
// When to start (pure)
// ---------------------------------------------------------------------------

export type RunnerDecision =
  | { start: true; origin: string }
  | { start: false; reason: string; level: "debug" | "info" | "warn" };

/**
 * Should this process run the in-app cron runner?
 *
 *   CRON_RUNNER=internal   run it (needs CRON_SECRET).
 *   CRON_RUNNER=external   don't: an outside scheduler calls the routes.
 *   CRON_RUNNER=off        don't (nothing schedules the sweeps).
 *   unset                  internal on a production server (`next start`,
 *                          the Docker image, compose), off in `next dev`.
 *
 * Never during `next build`, in tests, or outside the Node.js runtime. With
 * CRON_SECRET unset the runner stays off and says so once — it never invents
 * a secret. CRON_RUNNER_ORIGIN overrides where it sends the calls (default
 * http://127.0.0.1:$PORT, PORT default 3000).
 */
export function cronRunnerDecision(env: NodeJS.ProcessEnv = process.env): RunnerDecision {
  if (env.NEXT_RUNTIME && env.NEXT_RUNTIME !== "nodejs") {
    return { start: false, reason: "not the Node.js runtime", level: "debug" };
  }
  if (env.NEXT_PHASE === "phase-production-build") {
    return { start: false, reason: "next build", level: "debug" };
  }
  if (env.NODE_ENV === "test" || env.NODE_TEST_CONTEXT) {
    return { start: false, reason: "test run", level: "debug" };
  }
  const mode = (env.CRON_RUNNER ?? "").trim().toLowerCase();
  if (mode === "external" || mode === "off") {
    return { start: false, reason: `CRON_RUNNER=${mode}`, level: "info" };
  }
  if (mode !== "" && mode !== "internal") {
    return { start: false, reason: `unknown CRON_RUNNER value "${mode.slice(0, 32)}" (use internal, external or off)`, level: "warn" };
  }
  if (mode === "" && env.NODE_ENV !== "production") {
    return { start: false, reason: "CRON_RUNNER unset outside production (set CRON_RUNNER=internal to run sweeps in dev)", level: "info" };
  }
  if (!(env.CRON_SECRET ?? "").trim()) {
    return {
      start: false,
      reason: "CRON_SECRET is unset, so the cron routes refuse every scheduled call; set it (openssl rand -hex 32) to run scheduled sweeps",
      level: "warn",
    };
  }
  const rawOrigin = (env.CRON_RUNNER_ORIGIN ?? "").trim();
  if (rawOrigin) {
    try {
      const u = new URL(rawOrigin);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol");
      return { start: true, origin: u.origin };
    } catch {
      return { start: false, reason: "CRON_RUNNER_ORIGIN is not an http(s) URL", level: "warn" };
    }
  }
  const port = Number((env.PORT ?? "").trim() || "3000");
  const safePort = Number.isInteger(port) && port > 0 && port < 65536 ? port : 3000;
  return { start: true, origin: `http://127.0.0.1:${safePort}` };
}

// ---------------------------------------------------------------------------
// The HTTP call
// ---------------------------------------------------------------------------

/**
 * POST to a route on our own origin with the job's bearer secret. node:http
 * rather than fetch: undici's default 300s headers timeout would cut off the
 * long sweeps (crawls, LLM passes) that answer only when done; the job
 * timeout is enforced by the runner through `signal` instead.
 */
export function httpCaller(origin: string, env: NodeJS.ProcessEnv = process.env): JobCaller {
  return (job, { signal }) =>
    new Promise<CallResult>((resolve, reject) => {
      const secret = (env[jobSecretEnv(job)] ?? "").trim();
      const url = new URL(job.path, origin);
      const body = "{}";
      const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method: "POST",
          signal,
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            "user-agent": "ShapesOS-CronRunner/1.0",
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            if (size < ERROR_EXCERPT_BYTES) {
              chunks.push(c);
              size += c.length;
            }
          });
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              excerpt: Buffer.concat(chunks).subarray(0, ERROR_EXCERPT_BYTES).toString("utf8"),
            }),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end(body);
    });
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export interface CronRunnerOptions {
  store: CronStore;
  call: JobCaller;
  jobs?: readonly CronJob[];
  clock?: Clock;
  /** [0, 1) — start jitter. */
  random?: () => number;
  logger?: RunnerLogger;
  tickMs?: number;
  firstTickDelayMs?: number;
  /** Env the job secrets are read from (jobs whose secret is unset are skipped). */
  env?: NodeJS.ProcessEnv;
}

export interface TickOutcome {
  /** False when another replica held the lock (or a tick was already running). */
  leader: boolean;
  claimed: string[];
}

function clip(s: string, n = ERROR_MAX_CHARS): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export class CronRunner {
  private readonly store: CronStore;
  private readonly call: JobCaller;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly log: RunnerLogger;
  private readonly tickMs: number;
  private readonly firstTickDelayMs: number;
  private readonly jobs: readonly CronJob[];
  private readonly baseline: Date;
  private readonly running = new Map<string, Promise<void>>();
  private ticking = false;
  private timer: unknown = null;
  private stopped = true;

  constructor(opts: CronRunnerOptions) {
    this.store = opts.store;
    this.call = opts.call;
    this.clock = opts.clock ?? realClock;
    this.random = opts.random ?? Math.random;
    this.log = opts.logger ?? defaultLog;
    this.tickMs = opts.tickMs ?? TICK_MS;
    this.firstTickDelayMs = opts.firstTickDelayMs ?? FIRST_TICK_DELAY_MS;
    this.baseline = new Date(this.clock.now());
    const env = opts.env ?? process.env;
    const all = opts.jobs ?? CRON_JOBS;
    const skipped = all.filter((j) => !(env[jobSecretEnv(j)] ?? "").trim());
    for (const j of skipped) {
      // Logged once, at construction: the job never runs until the secret is set.
      this.log.warn("cron job skipped: its bearer secret is unset", { job: j.key, secretEnv: jobSecretEnv(j) });
    }
    this.jobs = all.filter((j) => !skipped.includes(j));
  }

  /** Job keys this runner schedules (secrets present). */
  get scheduledJobs(): string[] {
    return this.jobs.map((j) => j.key);
  }

  /** Jobs running in this process right now. */
  get inFlight(): string[] {
    return [...this.running.keys()];
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(this.firstTickDelayMs);
  }

  /** Stop ticking. Runs already started finish on their own. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  /** Wait for every in-flight run (tests, graceful shutdown). */
  async drain(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running.values()]);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.tick()
        .catch((err) => this.log.error("cron tick failed", { err: err instanceof Error ? err.message : String(err) }))
        .finally(() => this.schedule(this.tickMs));
    }, ms);
  }

  /** One tick: claim under the lock, then start the claimed runs. */
  async tick(): Promise<TickOutcome> {
    if (this.ticking) return { leader: false, claimed: [] };
    this.ticking = true;
    try {
      const claimed = await this.store.claimDue({
        jobs: this.jobs,
        now: new Date(this.clock.now()),
        baseline: this.baseline,
        localRunning: new Set(this.running.keys()),
      });
      if (claimed === null) return { leader: false, claimed: [] };
      for (const c of claimed) {
        const p = this.execute(c).finally(() => this.running.delete(c.job.key));
        this.running.set(c.job.key, p);
      }
      return { leader: true, claimed: claimed.map((c) => c.job.key) };
    } finally {
      this.ticking = false;
    }
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => this.clock.setTimeout(resolve, ms));
  }

  private async execute(c: ClaimedRun): Promise<void> {
    const { job } = c;
    await this.sleep(Math.floor(this.random() * jobMaxJitterMs(job)));
    const started = this.clock.now();
    const ac = new AbortController();
    let timer: unknown = null;
    const timedOut = new Promise<{ kind: "timeout" }>((resolve) => {
      timer = this.clock.setTimeout(() => {
        ac.abort();
        resolve({ kind: "timeout" });
      }, job.timeoutMs);
    });
    let result: RunResult;
    try {
      const outcome = await Promise.race([
        this.call(job, { signal: ac.signal }).then((r) => ({ kind: "done" as const, r })),
        timedOut,
      ]);
      const durationMs = Math.max(0, this.clock.now() - started);
      if (outcome.kind === "timeout") {
        result = { status: "timeout", httpStatus: null, durationMs, error: `No answer within ${Math.round(job.timeoutMs / 1000)}s` };
      } else if (outcome.r.status >= 200 && outcome.r.status < 300) {
        result = { status: "ok", httpStatus: outcome.r.status, durationMs, error: null };
      } else {
        const excerpt = outcome.r.excerpt.trim();
        result = {
          status: "failed",
          httpStatus: outcome.r.status,
          durationMs,
          error: clip(`HTTP ${outcome.r.status}${excerpt ? `: ${excerpt}` : ""}`),
        };
      }
    } catch (err) {
      const durationMs = Math.max(0, this.clock.now() - started);
      result = {
        status: ac.signal.aborted ? "timeout" : "failed",
        httpStatus: null,
        durationMs,
        error: clip(err instanceof Error ? err.message : String(err)),
      };
    } finally {
      if (timer !== null) this.clock.clearTimeout(timer);
    }

    const fields = { job: job.key, runId: c.runId, status: result.status, httpStatus: result.httpStatus, durationMs: result.durationMs };
    if (result.status === "ok") this.log.info("cron job finished", fields);
    else this.log.warn("cron job did not succeed", { ...fields, error: result.error });

    try {
      await this.store.finish(c.runId, result, new Date(this.clock.now()));
    } catch (err) {
      this.log.error("cron run could not be recorded", { job: job.key, runId: c.runId, err: err instanceof Error ? err.message : String(err) });
    }
  }
}

// ---------------------------------------------------------------------------
// Process entry point (instrumentation.ts)
// ---------------------------------------------------------------------------

let instance: CronRunner | null = null;

/** Start the runner once per process when the environment allows it. */
export async function startCronRunnerFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<CronRunner | null> {
  if (instance) return instance;
  const decision = cronRunnerDecision(env);
  if (!decision.start) {
    defaultLog[decision.level]("in-app cron runner off", { reason: decision.reason });
    return null;
  }
  const { prismaCronStore } = await import("./store");
  instance = new CronRunner({ store: prismaCronStore(), call: httpCaller(decision.origin, env), env });
  instance.start();
  defaultLog.info("in-app cron runner started", { jobs: instance.scheduledJobs.length, tickMs: TICK_MS });
  return instance;
}
