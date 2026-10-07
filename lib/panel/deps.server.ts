// ShapesOS — Phase 19B (WS=panel): the panel's system boundaries, injectable.
// Commercial layer (entitlement dress_rehearsal). See lib/panel/README.md.
//
// Everything outside the panel's own code is reached through PanelDeps: the
// model (the ShapesOS router), the embedder (local MiniLM), the SSRF guard,
// the browser (the existing Playwright recorder) and the job queue
// (agent_jobs). Production uses defaultPanelDeps; tests use testPanelDeps,
// which swaps in the labelled FAKE model and lets them inject a fake
// embedder — never a fake of the panel's own modules.

import { HttpError } from "@/lib/api/errors";
import { assertSafeUrl } from "@/lib/safe-url";
import { PanelLedger } from "./budget";
import { createFakePanelProvider, fakeModelAllowed, FAKE_MODEL_PRICED_AS } from "./fake-model";
import type { EmbedFn } from "./memory";
import { RouterPanelModel, type PanelModel } from "./model";
import type { OpenWalkPage } from "./browser.server";
import { miniLmEmbed } from "./store.server";

/** The workload every panel call runs on (claude-haiku-4-5 by default: a cheap model that role-plays and calls tools well). */
export const PANEL_WORKLOAD = "copy" as const;

export interface PricingModel {
  model: string;
  kind: "live" | "fake";
}

export interface PanelDeps {
  /** The model a run is priced on (no call is made). Throws 503 when no model is configured. */
  pricingModel(workspaceId: string): Promise<PricingModel>;
  /** The run's model, capped by `ledger` and metered for the workspace. */
  modelFor(workspaceId: string, ledger: PanelLedger, actorId: string | null): Promise<PanelModel>;
  embed: EmbedFn;
  /** SSRF guard for url targets (throws on private / internal hosts). */
  checkUrl: (url: string) => Promise<unknown>;
  /** Opens a browser page for one persona's walk. */
  openPage: OpenWalkPage;
  /** Queues the run on the agent worker; returns the job id. */
  enqueueRun(workspaceId: string, panelRunId: string): Promise<string>;
  /** Simulated reading time between steps (off in tests). */
  humanTiming: boolean;
}

export const NO_MODEL_MESSAGE = "No AI model is configured for Dress Rehearsal. Add an Anthropic or OpenAI key in Settings → Providers, then try again.";

const fakeModel = (ledger: PanelLedger): PanelModel => new RouterPanelModel(createFakePanelProvider(), FAKE_MODEL_PRICED_AS, ledger, { kind: "fake" });

async function defaultOpenPage(...args: Parameters<OpenWalkPage>): ReturnType<OpenWalkPage> {
  const { openRecordedWalkPage } = await import("./browser.server");
  return openRecordedWalkPage(...args);
}

export const defaultPanelDeps: PanelDeps = {
  async pricingModel(workspaceId) {
    if (fakeModelAllowed()) return { model: FAKE_MODEL_PRICED_AS, kind: "fake" };
    const { resolveWorkloadForWorkspace } = await import("@/lib/llm/workspace");
    const r = await resolveWorkloadForWorkspace(PANEL_WORKLOAD, workspaceId);
    if (!r.provider.isLive) throw new HttpError(503, NO_MODEL_MESSAGE, { code: "no_model" });
    return { model: r.requestedModel, kind: "live" };
  },
  async modelFor(workspaceId, ledger, actorId) {
    if (fakeModelAllowed()) return fakeModel(ledger);
    const { getLlmProviderForWorkspace, resolveWorkloadForWorkspace } = await import("@/lib/llm/workspace");
    const r = await resolveWorkloadForWorkspace(PANEL_WORKLOAD, workspaceId);
    if (!r.provider.isLive) throw new HttpError(503, NO_MODEL_MESSAGE, { code: "no_model" });
    const provider = await getLlmProviderForWorkspace(PANEL_WORKLOAD, { workspaceId, actorId, billing: "tokens" });
    return new RouterPanelModel(provider, r.requestedModel, ledger, { kind: "live" });
  },
  embed: miniLmEmbed,
  checkUrl: (url) => assertSafeUrl(url),
  openPage: defaultOpenPage,
  async enqueueRun(workspaceId, panelRunId) {
    const { enqueueAgentJob } = await import("@/lib/agents/queue/store");
    // One attempt (+1 so a second claim after a crash can mark the run interrupted instead of spending again).
    const job = await enqueueAgentJob({ workspaceId, kind: "panel_run", payload: { workspaceId, panelRunId }, maxAttempts: 2 });
    return job.id;
  },
  humanTiming: true,
};

/** Test deps: the labelled FAKE model, no human timing; everything else injectable. */
export function testPanelDeps(over: Partial<PanelDeps> = {}): PanelDeps {
  return {
    ...defaultPanelDeps,
    pricingModel: async () => ({ model: FAKE_MODEL_PRICED_AS, kind: "fake" }),
    modelFor: async (_ws, ledger) => fakeModel(ledger),
    enqueueRun: async () => "test-job",
    humanTiming: false,
    ...over,
  };
}
