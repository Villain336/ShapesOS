// ShapesOS — Phase 19B (WS=engine): the town's system boundaries, injectable.
// Commercial layer (entitlement dress_rehearsal). Architecture: lib/sim/engine.ts.
//
// The model at decision points is the panel's (lib/panel/deps.server.ts
// defaultPanelDeps: the ShapesOS router on the cheap "copy" workload,
// workspace-bound so every call is spend-gated and metered via meter()),
// capped by the run's PanelLedger. Where the panel allows its labelled fake
// (PANEL_FAKE_MODEL=1, never in production) the town uses its OWN fake
// (lib/sim/fake-model.ts — the panel's fake only knows the page-walk tools).
// "deep" runs use the Message Batches path when the workspace's model is an
// Anthropic one with a Batch API (lib/llm/batch.ts batchProviderOf).

import { defaultPanelDeps, PANEL_WORKLOAD, type PricingModel } from "@/lib/panel/deps.server";
import { fakeModelAllowed, FAKE_MODEL_PRICED_AS } from "@/lib/panel/fake-model";
import type { PanelLedger } from "@/lib/panel/budget";
import type { PanelModel } from "@/lib/panel/model";
import type { ChatBatchProvider } from "./batch";
import { fakeTownModel } from "./fake-model";

export const TOWN_RUN_JOB_KIND = "town_run";

export interface SimDeps {
  pricingModel(workspaceId: string): Promise<PricingModel>;
  modelFor(workspaceId: string, ledger: PanelLedger, actorId: string | null): Promise<PanelModel>;
  /** The Message Batches provider for a deep run, or null (then deep runs direct). */
  batchProviderFor(workspaceId: string): Promise<ChatBatchProvider | null>;
  /** Queues the run on the agent worker; returns the job id. */
  enqueueRun(workspaceId: string, simRunId: string): Promise<string>;
  figmaToken(): string;
  fetch: typeof fetch;
}

export const defaultSimDeps: SimDeps = {
  async pricingModel(workspaceId) {
    if (fakeModelAllowed()) return { model: FAKE_MODEL_PRICED_AS, kind: "fake" };
    return defaultPanelDeps.pricingModel(workspaceId);
  },
  async modelFor(workspaceId, ledger, actorId) {
    if (fakeModelAllowed()) return fakeTownModel(ledger);
    return defaultPanelDeps.modelFor(workspaceId, ledger, actorId);
  },
  async batchProviderFor(workspaceId) {
    if (fakeModelAllowed()) return null;
    const [{ getLlmProviderForWorkspace }, { batchProviderOf, batchEnabled }] = await Promise.all([import("@/lib/llm/workspace"), import("@/lib/llm/batch")]);
    if (!batchEnabled()) return null;
    const provider = await getLlmProviderForWorkspace(PANEL_WORKLOAD, { workspaceId, actorId: null, billing: "tokens" });
    return batchProviderOf(provider);
  },
  async enqueueRun(workspaceId, simRunId) {
    const { enqueueAgentJob } = await import("@/lib/agents/queue/store");
    // Two claims at most: a second claim after a crash marks the run interrupted instead of spending again.
    const job = await enqueueAgentJob({ workspaceId, kind: TOWN_RUN_JOB_KIND, payload: { workspaceId, simRunId }, maxAttempts: 2 });
    return job.id;
  },
  figmaToken: () => process.env.FIGMA_TOKEN ?? "",
  fetch: (...args) => fetch(...args),
};

/** Test deps: the labelled FAKE town model, no batch provider; the queue is real unless overridden. */
export function testSimDeps(over: Partial<SimDeps> = {}): SimDeps {
  return {
    ...defaultSimDeps,
    pricingModel: async () => ({ model: FAKE_MODEL_PRICED_AS, kind: "fake" }),
    modelFor: async (_ws, ledger) => fakeTownModel(ledger),
    batchProviderFor: async () => null,
    ...over,
  };
}
