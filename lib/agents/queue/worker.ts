// ShapesOS — Phase 8: the agent worker.
//
// Polls agent_jobs, claims due jobs (SKIP LOCKED — any number of workers can
// run side by side), runs each through its handler (handlers.ts) and
// heartbeats while it works:
//
//   * every heartbeatMs the lease is extended; if that fails because another
//     worker took the job (our lease had expired), the local work is aborted
//     with LeaseLostError — the run is NOT finished here, its new owner
//     continues from the saved transcript;
//   * the same tick checks the job's run for a Stop request and aborts an
//     in-flight model call in this process at once;
//   * a handler error requeues the job with backoff while attempts remain,
//     then dead-letters it; an orphaned job (its worker died) is claimed
//     again when its lease passes, and dead-lettered by the reaper once it
//     has used its attempts (its run is then finished `failed`).
//
// Started by scripts/worker.mts (compose `worker` service, AGENT_WORKER=
// external on the app) or inside the app server (AGENT_WORKER=internal,
// instrumentation.ts).

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { agentWorkerConfig, type AgentWorkerConfig } from "./config";
import {
  claimAgentJobs,
  completeAgentJob,
  discoverDueWorkspaces,
  failAgentJob,
  heartbeatAgentJob,
  reapExpiredJobs,
  releaseAgentJob,
  type ClaimedAgentJob,
} from "./store";
import { defaultAgentJobHandlers, type AgentJobHandler } from "./handlers";
import { LeaseLostError, abortRun, abortRunWith } from "@/lib/agents/runs/abort";

export interface AgentWorkerLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const consoleLog: AgentWorkerLogger = {
  info: (m, f) => console.log(`[agent-worker] ${m}`, f ?? ""),
  warn: (m, f) => console.warn(`[agent-worker] ${m}`, f ?? ""),
  error: (m, f) => console.error(`[agent-worker] ${m}`, f ?? ""),
};

export interface AgentWorkerOptions extends Partial<AgentWorkerConfig> {
  workerId?: string;
  handlers?: Record<string, AgentJobHandler>;
  log?: AgentWorkerLogger;
  /** Test seam: is the job's run asked to stop? */
  isRunCancelRequested?: (workspaceId: string, runId: string) => Promise<boolean>;
  /**
   * Phase 16 (deleg): claim only these job kinds (default every kind) — the
   * delegation-only worker AGENT_WORKER=off starts (lib/agents/delegation/local-worker.ts).
   */
  kinds?: readonly string[];
}

export interface JobOutcome {
  jobId: string;
  status: "succeeded" | "queued" | "dead" | "lease_lost";
  error?: string;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AgentWorker {
  readonly workerId: string;
  private readonly cfg: AgentWorkerConfig;
  private readonly handlers: Record<string, AgentJobHandler>;
  private readonly log: AgentWorkerLogger;
  private readonly isRunCancelRequested: (workspaceId: string, runId: string) => Promise<boolean>;
  private readonly active = new Map<string, Promise<JobOutcome>>();
  /** Deploy PR: the running jobs' abort handles (hand-back on shutdown). */
  private readonly running = new Map<string, { job: ClaimedAgentJob; ac: AbortController }>();
  private readonly kinds: readonly string[] | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private ticking = false;

  constructor(opts: AgentWorkerOptions = {}) {
    const base = agentWorkerConfig();
    this.cfg = {
      concurrency: opts.concurrency ?? base.concurrency,
      pollMs: opts.pollMs ?? base.pollMs,
      leaseMs: opts.leaseMs ?? base.leaseMs,
      heartbeatMs: opts.heartbeatMs ?? base.heartbeatMs,
      maxAttempts: opts.maxAttempts ?? base.maxAttempts,
    };
    this.workerId = opts.workerId ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.handlers = opts.handlers ?? defaultAgentJobHandlers;
    this.kinds = opts.kinds?.length ? [...opts.kinds] : null;
    this.log = opts.log ?? consoleLog;
    this.isRunCancelRequested =
      opts.isRunCancelRequested ??
      (async (ws, runId) => (await import("@/lib/agents/runs/service")).isAgentRunCancelRequested(ws, runId));
  }

  get config(): Readonly<AgentWorkerConfig> {
    return this.cfg;
  }

  get busy(): number {
    return this.active.size;
  }

  start(): void {
    if (this.timer || this.stopping) return;
    this.log.info("started", { workerId: this.workerId, concurrency: this.cfg.concurrency });
    const loop = async () => {
      if (this.stopping) return;
      const claimed = await this.tick().catch((err) => {
        this.log.warn("tick failed", { error: errMessage(err) });
        return 0;
      });
      if (this.stopping) return;
      // Busy with free slots and work found: poll again soon; idle: wait.
      this.timer = setTimeout(loop, claimed > 0 && this.active.size < this.cfg.concurrency ? 50 : this.cfg.pollMs);
    };
    this.timer = setTimeout(loop, 0);
  }

  /** Stop claiming; wait for running jobs (they keep heartbeating until done). */
  async stop(): Promise<void> {
    this.stopClaiming();
    await Promise.allSettled([...this.active.values()]);
    this.log.info("stopped", { workerId: this.workerId });
  }

  /** The agent runs this worker's jobs are working on right now. */
  runIds(): Set<string> {
    const ids = new Set<string>();
    for (const { job } of this.running.values()) if (job.runId) ids.add(job.runId);
    return ids;
  }

  /** Stop claiming new jobs; running ones carry on. */
  stopClaiming(): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Deploy PR (graceful shutdown): stop claiming, give running jobs up to
   * `graceMs` to finish, then hand the rest back — each one's run is aborted
   * as a lease loss (the agent loop saves its transcript and stops WITHOUT
   * finishing the run) and the job is re-queued at once without charging the
   * attempt, so another worker continues it immediately instead of after the
   * lease expires.
   */
  async handBack(graceMs: number): Promise<{ finished: number; handedBack: number }> {
    this.stopClaiming();
    const before = this.active.size;
    if (before === 0) return { finished: 0, handedBack: 0 };
    await Promise.race([
      Promise.allSettled([...this.active.values()]),
      new Promise((r) => setTimeout(r, Math.max(0, graceMs))),
    ]);
    const left = [...this.running.values()];
    for (const { job, ac } of left) {
      ac.abort(new LeaseLostError("Handed back: this worker is shutting down"));
      if (job.runId) abortRunWith(job.runId, new LeaseLostError("Handed back: this worker is shutting down"));
    }
    await Promise.allSettled([...this.active.values()]);
    let handedBack = 0;
    for (const { job } of left) {
      if (await releaseAgentJob(job.workspaceId, job.id, this.workerId).catch(() => false)) handedBack++;
    }
    this.log.info("handed back running jobs on shutdown", { workerId: this.workerId, handedBack, finished: before - left.length });
    return { finished: before - left.length, handedBack };
  }

  /**
   * One poll: reap dead jobs, then claim into the free slots and start them.
   * Returns how many jobs it started (they run in the background; see drain()).
   */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      let free = this.cfg.concurrency - this.active.size;
      if (free <= 0) return 0;
      const workspaces = await discoverDueWorkspaces(50, this.kinds);
      let started = 0;
      for (const ws of workspaces) {
        if (free <= 0) break;
        await this.reap(ws);
        const jobs = await claimAgentJobs(ws, this.workerId, this.cfg.leaseMs, free, this.kinds);
        for (const job of jobs) {
          const p = this.execute(job).finally(() => this.active.delete(job.id));
          this.active.set(job.id, p);
          free--;
          started++;
        }
      }
      return started;
    } finally {
      this.ticking = false;
    }
  }

  /** Wait for every job this worker is running (tests, shutdown). */
  async drain(): Promise<JobOutcome[]> {
    const out: JobOutcome[] = [];
    while (this.active.size > 0) {
      const settled = await Promise.allSettled([...this.active.values()]);
      for (const s of settled) if (s.status === "fulfilled") out.push(s.value);
    }
    return out;
  }

  private async reap(workspaceId: string): Promise<void> {
    const dead = await reapExpiredJobs(workspaceId).catch(() => []);
    for (const d of dead) {
      this.log.warn("job dead-lettered: lease expired on its last attempt", { jobId: d.id, kind: d.kind });
      if (d.runId) {
        const { finishAgentRun, getAgentRun } = await import("@/lib/agents/runs/service");
        const run = await getAgentRun(workspaceId, d.runId).catch(() => null);
        if (run && (run.status === "running" || run.status === "queued")) {
          await finishAgentRun(workspaceId, d.runId, "failed").catch(() => undefined);
        }
        // Phase 16 (deleg): a delegated child that died with its worker is a
        // failed task — its parent must hear about it (or it waits forever).
        if (d.kind === "subagent_run") {
          const { settleDeadChild } = await import("@/lib/chat/delegation");
          await settleDeadChild(workspaceId, d.runId, "Its worker stopped responding on every attempt.").catch(() => undefined);
        }
      }
    }
  }

  /** Run one claimed job under a heartbeat. */
  async execute(job: ClaimedAgentJob): Promise<JobOutcome> {
    const handler = this.handlers[job.kind];
    if (!handler) {
      const status = await failAgentJob(job.workspaceId, job.id, this.workerId, `No handler for job kind "${job.kind}".`, { retryable: false });
      return { jobId: job.id, status: status ?? "lease_lost", error: "no handler" };
    }
    const ac = new AbortController();
    this.running.set(job.id, { job, ac });
    let beating = false;
    const beat = async () => {
      if (beating || ac.signal.aborted) return;
      beating = true;
      try {
        const ok = await heartbeatAgentJob(job.workspaceId, job.id, this.workerId, this.cfg.leaseMs);
        if (!ok) {
          this.log.warn("lease lost; stopping local work", { jobId: job.id });
          ac.abort(new LeaseLostError());
          return;
        }
        if (job.runId && (await this.isRunCancelRequested(job.workspaceId, job.runId).catch(() => false))) {
          // Stop from anywhere: end an in-flight model call here at once.
          abortRun(job.runId);
        }
      } catch (err) {
        // A transient DB error: keep working; the lease still has time.
        this.log.warn("heartbeat failed", { jobId: job.id, error: errMessage(err) });
      } finally {
        beating = false;
      }
    };
    const hb = setInterval(() => void beat(), this.cfg.heartbeatMs);
    try {
      const result = await handler(job, { signal: ac.signal, workerId: this.workerId, lastAttempt: job.attempts >= job.maxAttempts });
      if (ac.signal.aborted) return { jobId: job.id, status: "lease_lost" };
      const ok = await completeAgentJob(job.workspaceId, job.id, this.workerId, result ?? null);
      return { jobId: job.id, status: ok ? "succeeded" : "lease_lost" };
    } catch (err) {
      if (ac.signal.aborted || (err as { name?: unknown })?.name === "LeaseLostError") {
        return { jobId: job.id, status: "lease_lost" };
      }
      const message = errMessage(err);
      this.log.error("job failed", { jobId: job.id, kind: job.kind, attempt: job.attempts, error: message });
      const status = await failAgentJob(job.workspaceId, job.id, this.workerId, message).catch(() => null);
      return { jobId: job.id, status: status ?? "lease_lost", error: message };
    } finally {
      clearInterval(hb);
      this.running.delete(job.id);
    }
  }
}

let inApp: AgentWorker | null = null;

/** Start the in-app worker when the environment allows it (instrumentation.ts). */
export async function startAgentWorkerFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<AgentWorker | null> {
  if (inApp) return inApp;
  const { inAppWorkerDecision } = await import("./config");
  const decision = inAppWorkerDecision(env);
  if (!decision.start) {
    consoleLog.info("in-app agent worker off", { reason: decision.reason });
    return null;
  }
  inApp = new AgentWorker();
  inApp.start();
  return inApp;
}
