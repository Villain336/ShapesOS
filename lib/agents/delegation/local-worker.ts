// ShapesOS — Phase 16: delegated work when no agent worker runs.
//
// Delegated sub-agents are agent jobs (`subagent_run`, `delegation_tick`,
// `delegation_join`) so they run side by side and survive restarts. With
// AGENT_WORKER=internal (default) or external, the normal worker runs them.
// With AGENT_WORKER=off ("no queue for chat: every turn runs inside its
// request") nothing would — so this process starts a small worker that
// claims ONLY those three kinds (never a handed-off chat turn or a mission),
// the first time a delegation job is queued. Never in tests or builds (the
// same rules as the in-app worker, lib/agents/queue/config.ts).

import { agentWorkerMode, type EnvLike } from "@/lib/agents/queue/config";

export const DELEGATION_JOB_KINDS = ["subagent_run", "delegation_tick", "delegation_join"] as const;

export function localDelegationWorkerDecision(env: EnvLike = process.env): { start: boolean; reason?: string } {
  if (agentWorkerMode(env) !== "off") return { start: false, reason: "a worker runs agent jobs" };
  if (env.NEXT_RUNTIME && env.NEXT_RUNTIME !== "nodejs") return { start: false, reason: "not the Node.js runtime" };
  if (env.NEXT_PHASE === "phase-production-build") return { start: false, reason: "next build" };
  if (env.NODE_ENV === "test" || env.NODE_TEST_CONTEXT) return { start: false, reason: "test run" };
  if (!(env.DATABASE_URL ?? "").trim()) return { start: false, reason: "DATABASE_URL is unset" };
  return { start: true };
}

let local: import("@/lib/agents/queue/worker").AgentWorker | null = null;
let starting = false;

/** Start (once) the delegation-only worker when AGENT_WORKER=off. Never throws. */
export function kickLocalDelegationWorker(env: EnvLike = process.env): void {
  if (local || starting || !localDelegationWorkerDecision(env).start) return;
  starting = true;
  void import("@/lib/agents/queue/worker")
    .then(({ AgentWorker }) => {
      local = new AgentWorker({ kinds: [...DELEGATION_JOB_KINDS] });
      local.start();
    })
    .catch(() => undefined)
    .finally(() => {
      starting = false;
    });
}
