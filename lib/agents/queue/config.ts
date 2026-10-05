// ShapesOS — Phase 8: agent queue / worker settings (PURE; env read at call time).
//
//   AGENT_WORKER                 internal (default) | external | off
//       internal — the app server runs the worker loop itself
//                  (instrumentation.ts), so queued work always runs, even
//                  with one container and in `next dev`;
//       external — a separate worker process runs it (compose `worker`
//                  service: `npx tsx scripts/worker.mts`); the app only
//                  enqueues;
//       off      — no queue for chat: every turn runs inside its request.
//   AGENT_INLINE_BUDGET_SECONDS  45 — a chat turn still working after this
//                  hands off to the worker at its next step boundary
//                  (0 = enqueue every turn before its first step).
//   AGENT_WORKER_CONCURRENCY     6  — jobs one worker runs at once (Phase 16:
//                  raised from 2 so one worker can run a plan's sub-agents
//                  side by side — up to the 6 live sub-agents a workspace may
//                  have by default; agent jobs mostly wait on model calls).
//   AGENT_WORKER_POLL_MS         1000 — idle poll interval.
//   AGENT_JOB_LEASE_SECONDS      60 — a running job whose lease passes is
//                  presumed orphaned and claimed again.
//   AGENT_JOB_HEARTBEAT_SECONDS  10 — how often a worker extends its lease.
//   AGENT_JOB_MAX_ATTEMPTS       3  — claims before a job is dead-lettered.

export type AgentWorkerMode = "internal" | "external" | "off";

/** process.env or any plain map (tests). */
export type EnvLike = Record<string, string | undefined>;

function num(v: string | undefined): number | null {
  const t = (v ?? "").trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function agentWorkerMode(env: EnvLike = process.env): AgentWorkerMode {
  const m = (env.AGENT_WORKER ?? "").trim().toLowerCase();
  if (m === "external" || m === "off") return m;
  return "internal";
}

/** Inline time a chat turn gets before it hands off (ms); null = never hand off. */
export function inlineBudgetMs(env: EnvLike = process.env): number | null {
  if (agentWorkerMode(env) === "off") return null;
  const s = num(env.AGENT_INLINE_BUDGET_SECONDS);
  return Math.round((s ?? 45) * 1000);
}

export interface AgentWorkerConfig {
  concurrency: number;
  pollMs: number;
  leaseMs: number;
  heartbeatMs: number;
  maxAttempts: number;
}

export function agentWorkerConfig(env: EnvLike = process.env): AgentWorkerConfig {
  const leaseMs = Math.max(5_000, Math.round((num(env.AGENT_JOB_LEASE_SECONDS) ?? 60) * 1000));
  const heartbeatMs = Math.max(1_000, Math.round((num(env.AGENT_JOB_HEARTBEAT_SECONDS) ?? 10) * 1000));
  return {
    concurrency: Math.max(1, Math.min(32, Math.floor(num(env.AGENT_WORKER_CONCURRENCY) ?? 6))),
    pollMs: Math.max(100, Math.floor(num(env.AGENT_WORKER_POLL_MS) ?? 1000)),
    leaseMs,
    // A heartbeat must land well inside the lease.
    heartbeatMs: Math.min(heartbeatMs, Math.floor(leaseMs / 3)),
    maxAttempts: Math.max(1, Math.floor(num(env.AGENT_JOB_MAX_ATTEMPTS) ?? 3)),
  };
}

export interface WorkerStartDecision {
  start: boolean;
  reason?: string;
}

/** Should this process run the in-app worker loop? (instrumentation.ts) */
export function inAppWorkerDecision(env: EnvLike = process.env): WorkerStartDecision {
  if (env.NEXT_RUNTIME && env.NEXT_RUNTIME !== "nodejs") return { start: false, reason: "not the Node.js runtime" };
  if (env.NEXT_PHASE === "phase-production-build") return { start: false, reason: "next build" };
  if (env.NODE_ENV === "test" || env.NODE_TEST_CONTEXT) return { start: false, reason: "test run" };
  const mode = agentWorkerMode(env);
  if (mode !== "internal") return { start: false, reason: `AGENT_WORKER=${mode}` };
  if (!(env.DATABASE_URL ?? "").trim()) return { start: false, reason: "DATABASE_URL is unset" };
  return { start: true };
}
