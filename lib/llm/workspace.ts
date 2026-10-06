// ShapesOS — Phase 15.1/15.2: the workspace-aware LLM entry point.
//
//   const llm = await getLlmProviderForWorkspace("copy", { workspaceId, actorId });
//   await llm.generate(prompt)          // gated + metered for that workspace
//
// 1. Loads the workspace's own model keys from the vault (cached briefly)
//    and resolves the workload with them (router: a workspace key replaces
//    the platform key for its family; every allow-list still applies).
// 2. Binds the metering context: chat()/chatStream() requests and generate()
//    calls that carry no `usage` get this workspace's, so the call is
//    checked against the credit cap BEFORE it is sent and its tokens are
//    recorded after (lib/llm/usage.ts). A platform-key call is charged
//    1.5× its cost; a workspace-key call is recorded at 0 credits.
// 3. `billing: "included"` is for calls inside a value-priced action
//    (ai_article, content_brief, …): recorded, never charged twice.
//
// If the vault cannot be read the platform key is used (and charged) — the
// call never silently runs on nobody's account.

import { resolveWorkload, type LlmWorkload, type ResolvedWorkload } from "./router";
import { loadWorkspaceModelKeys } from "./workspace-keys";
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  ChatUsageContext,
  LlmGenerateOptions,
  LlmKeySource,
  LlmProvider,
} from "./types";

/** A provider that fills in this workspace's metering context. */
export class WorkspaceBoundLlmProvider implements LlmProvider {
  constructor(
    readonly inner: LlmProvider,
    private readonly context: ChatUsageContext,
    /** Whose key serves the primary (null on mock). */
    readonly keySource: LlmKeySource | null,
  ) {}

  get name(): string {
    return this.inner.name;
  }

  get isLive(): boolean {
    return this.inner.isLive;
  }

  isConfigured(): boolean {
    return this.inner.isConfigured();
  }

  generate(prompt: string, opts?: LlmGenerateOptions): Promise<string> {
    return this.inner.generate(prompt, { ...opts, usage: opts?.usage ?? this.context });
  }

  chat(req: ChatRequest): Promise<ChatResponse> {
    return this.inner.chat({ ...req, usage: req.usage ?? this.context });
  }

  chatStream(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
    return this.inner.chatStream({ ...req, usage: req.usage ?? this.context });
  }

  /** Phase 17 (A2): the inner provider's answer. */
  supportsToolSearch(): boolean {
    return this.inner.supportsToolSearch?.() ?? false;
  }
}

/** Resolve a workload for a workspace (its own keys first). */
export async function resolveWorkloadForWorkspace(workload: LlmWorkload, workspaceId: string): Promise<ResolvedWorkload> {
  let workspaceKeys = {};
  try {
    workspaceKeys = await loadWorkspaceModelKeys(workspaceId);
  } catch (err) {
    console.warn(
      `[llm-router] could not read workspace ${workspaceId}'s model keys (${
        err instanceof Error ? err.message : String(err)
      }) — using the platform key`,
    );
  }
  return resolveWorkload(workload, { workspaceKeys });
}

/**
 * The provider for a workload in a workspace, bound to its metering context.
 * Pass `billing: "included"` when a value-priced action already charges
 * for the model work.
 */
export async function getLlmProviderForWorkspace(
  workload: LlmWorkload,
  context: ChatUsageContext,
): Promise<WorkspaceBoundLlmProvider> {
  const r = await resolveWorkloadForWorkspace(workload, context.workspaceId);
  return new WorkspaceBoundLlmProvider(r.provider, context, r.keySource);
}

/**
 * Phase 15.1: meter() fields for a VALUE-priced AI action (ai_article,
 * content_brief, content_refresh, prospect_research) whose model work ran on
 * the given providers. When every live provider used was the workspace's
 * own key, the action costs 0 credits (BYOK uses no AI credits) and the list
 * price is recorded as saved; otherwise the table price applies unchanged.
 */
export function valueActionMeterFields(
  listCredits: number,
  providers: ReadonlyArray<Pick<WorkspaceBoundLlmProvider, "isLive" | "keySource">>,
): { credits?: number; keySource: LlmKeySource; waivedCredits: number } {
  const live = providers.filter((p) => p.isLive);
  if (live.length > 0 && live.every((p) => p.keySource === "workspace")) {
    return { credits: 0, keySource: "workspace", waivedCredits: listCredits };
  }
  if (live.length > 0 && live.every((p) => p.keySource === "self_host")) {
    return { credits: 0, keySource: "self_host", waivedCredits: 0 };
  }
  return { keySource: "platform", waivedCredits: 0 };
}
