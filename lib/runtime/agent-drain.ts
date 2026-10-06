// ShapesOS — Deploy PR (WS=state): what a draining process does with the
// agent work it is running (registered as a shutdown hook by
// instrumentation.ts in the web app and by scripts/worker.mts).
//
//   * worker jobs (the in-app worker on a web replica, or the worker
//     process): AgentWorker.handBack() — stop claiming, let jobs finish for
//     SHUTDOWN_HANDOFF_MS, then hand the rest back to the queue at once;
//   * inline chat turns (running inside a POST /api/agents/chat request):
//     the agent loop already hands them to the worker at their next step
//     boundary while the server drains (lib/agents/loop.ts); the ones still
//     mid model call after SHUTDOWN_HANDOFF_MS are aborted as a lease loss,
//     which makes runTrackedAgentTurn save the step and enqueue the turn.
//     With AGENT_WORKER=off there is no worker to take them, so they are
//     left to finish within the grace period instead.

import { abortAllRunsWith, LeaseLostError, liveRunCount } from "@/lib/agents/runs/abort";
import { inlineBudgetMs } from "@/lib/agents/queue/config";
import type { AgentWorker } from "@/lib/agents/queue/worker";
import { shutdownHandoffMs } from "./shutdown";

export interface AgentDrainDeps {
  worker: Pick<AgentWorker, "handBack" | "runIds"> | null;
  handoffMs?: number;
  /** null = no hand-off possible (AGENT_WORKER=off). */
  inlineHandoff?: boolean;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export async function drainAgentWork(deps: AgentDrainDeps): Promise<{ abortedInline: string[] }> {
  const handoffMs = deps.handoffMs ?? shutdownHandoffMs();
  const log = deps.log ?? ((m: string, f?: Record<string, unknown>) => console.log(`[shutdown] ${m}`, f ?? ""));
  const workerDone = deps.worker ? deps.worker.handBack(handoffMs) : Promise.resolve(null);
  let abortedInline: string[] = [];
  const canHandOff = deps.inlineHandoff ?? inlineBudgetMs() !== null;
  if (canHandOff) {
    // Give inline turns until the hand-off window to reach a step boundary.
    const until = Date.now() + handoffMs;
    while (Date.now() < until && liveRunCount(deps.worker?.runIds() ?? new Set()) > 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
    abortedInline = abortAllRunsWith(() => new LeaseLostError("Handed off: this server is shutting down"), deps.worker?.runIds() ?? new Set());
    if (abortedInline.length) log("handed inline agent turns to the worker", { runs: abortedInline.length });
  }
  await workerDone;
  return { abortedInline };
}
