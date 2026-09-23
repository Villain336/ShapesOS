// Marketr — Direction B workload router (Phase D).
//
// Three workloads, three models, one config surface:
//   LLM_MODEL_COPY       (default "claude-haiku-4-5") — client-facing copy
//   LLM_MODEL_BULK       (default "gpt-5-nano")        — agent loop, skill runs, summaries
//   LLM_MODEL_BACKGROUND (default "gpt-5-nano:flex")  — digests, decay checks
//
// Safety model (see lib/llm/THREAT-MODEL-LLM.md):
//   1. Hard block-list (deepseek|gemini) — always rejected, falls back to mock.
//      DeepSeek: no ZDR, China-hosted. Gemini-flash: intro pricing doubles
//      2027-01-01 — never anchor to it.
//   2. Per-provider ZDR allow-lists — only ZDR-eligible models are routable.
//      Anything else (unknown strings included) fails closed to mock.
//   3. Qwen-class models are rejected for hosted cloud use (Model Studio
//      retention terms unverified) but permitted for explicit self-host
//      (LLM_SELF_HOST=1 with a local OpenAI-compatible endpoint), where no
//      client data leaves the operator's box. See lib/llm/SELF-HOST.md.
//   4. Env vars are read at call time (never cached at import) so tests and
//      long-lived servers always see current config.
//
// Legacy: plain LLM_MODEL / LLM_API_KEY / LLM_BASE_URL are still honored as a
// bulk-workload override (with a deprecation warning) when none of the
// LLM_MODEL_* vars are set, so existing deployments don't change behavior.

import { AnthropicLlmProvider } from "./anthropic";
import { OpenAiCompatibleLlmProvider } from "./openai";
import { MockLlmProvider } from "./mock";
import type { LlmProvider } from "./types";

export type LlmWorkload = "copy" | "bulk" | "background";

export const WORKLOAD_DEFAULTS: Record<LlmWorkload, string> = {
  copy: "claude-haiku-4-5",
  bulk: "gpt-5-nano",
  background: "gpt-5-nano:flex",
};

const WORKLOAD_ENV: Record<LlmWorkload, string> = {
  copy: "LLM_MODEL_COPY",
  bulk: "LLM_MODEL_BULK",
  background: "LLM_MODEL_BACKGROUND",
};

/** Suggested output-token ceilings per workload (T4 cost-blowout guard). */
export const WORKLOAD_MAX_TOKENS: Record<LlmWorkload, number> = {
  copy: 4096,
  bulk: 2048,
  background: 2048,
};

/** ZDR-eligible models per provider. OpenAI ZDR itself is a process step
 *  (approval for Tico), but only ZDR-eligible models are routable — code can
 *  never select a model outside this list for hosted use. */
export const ANTHROPIC_ZDR_MODELS = [
  "claude-haiku-4-5",
  "claude-sonnet-5",
  "claude-opus-5",
] as const;

export const OPENAI_ZDR_MODELS = [
  "gpt-5-nano",
  "gpt-5.4-nano",
  "gpt-5-nano:flex",
] as const;

/** Unconditionally blocked model families (T1). Checked before provider
 *  mapping; a match always falls back to mock, loudly. */
const BLOCKED_MODEL_PATTERN = /deepseek|gemini/i;

/** Qwen-class models: blocked for hosted cloud endpoints (retention terms
 *  unverified) unless the operator explicitly opts into self-host. */
const SELF_HOST_MODEL_PATTERN = /qwen/i;

export interface ResolvedWorkload {
  workload: LlmWorkload;
  /** The model string that was requested (env or default). */
  requestedModel: string;
  /** Where the model string came from. */
  source: "env" | "legacy" | "default";
  /** The provider that will serve it — "mock" on any fallback. */
  provider: LlmProvider;
  /** Why mock was chosen, when it was. Never contains key material. */
  fallbackReason: string | null;
}

/** Resolve the model string for a workload without constructing a provider.
 *  Exported for tests and for llmStatus(). */
export function resolveWorkloadModel(
  workload: LlmWorkload,
): { model: string; source: "env" | "legacy" | "default" } {
  const fromEnv = (process.env[WORKLOAD_ENV[workload]] ?? "").trim();
  if (fromEnv) return { model: fromEnv, source: "env" };

  // Legacy back-compat: a bare LLM_MODEL overrides the bulk workload only,
  // so an old env file can't silently redirect copy traffic (T2).
  if (workload === "bulk") {
    const legacy = (process.env.LLM_MODEL ?? "").trim();
    if (legacy) return { model: legacy, source: "legacy" };
  }
  return { model: WORKLOAD_DEFAULTS[workload], source: "default" };
}

function isSelfHost(): boolean {
  return (process.env.LLM_SELF_HOST ?? "").trim() === "1";
}

function openAiCompatible(
  apiKey: string,
  model: string,
): OpenAiCompatibleLlmProvider {
  const baseUrl = (
    process.env.OPENAI_BASE_URL ??
    process.env.LLM_BASE_URL ??
    "https://api.openai.com/v1"
  ).trim();
  return new OpenAiCompatibleLlmProvider(apiKey, model, baseUrl);
}

function toMock(
  workload: LlmWorkload,
  requestedModel: string,
  source: "env" | "legacy" | "default",
  reason: string,
): ResolvedWorkload {
  // Loud on purpose: a silent fallback is how mock/live confusion starts (T7).
  console.warn(
    `[llm-router] workload=${workload} model="${requestedModel}" → mock. ${reason}`,
  );
  return {
    workload,
    requestedModel,
    source,
    provider: new MockLlmProvider(),
    fallbackReason: reason,
  };
}

export function resolveWorkload(workload: LlmWorkload): ResolvedWorkload {
  const { model, source } = resolveWorkloadModel(workload);
  const openAiKey = (
    process.env.LLM_API_KEY ??
    process.env.OPENAI_API_KEY ??
    ""
  ).trim();
  const anthropicKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();

  // T1: killed/disqualified families can never be selected via config.
  if (BLOCKED_MODEL_PATTERN.test(model)) {
    return toMock(
      workload,
      model,
      source,
      "model family is blocked (no ZDR / disqualified pricing); refusing to route client data to it",
    );
  }

  // Qwen-class models: self-host only (T1). Without the explicit opt-in the
  // request would hit Alibaba's cloud with unverified retention terms.
  if (SELF_HOST_MODEL_PATTERN.test(model) && !isSelfHost()) {
    return toMock(
      workload,
      model,
      source,
      "Qwen-class models require explicit self-host (LLM_SELF_HOST=1 with a local endpoint); cloud use is blocked pending retention-terms review",
    );
  }

  // Legacy back-compat: a bare LLM_MODEL was the pre-D config surface and is
  // honored as an explicit operator choice for the bulk workload — it skips
  // the ZDR allow-list (grandfathered) but NOT the hard block-list above.
  // A deprecation warning points at LLM_MODEL_BULK. (T2)
  const grandfathered = source === "legacy";
  if (grandfathered) {
    console.warn(
      `[llm-router] workload=${workload}: LLM_MODEL is deprecated; set LLM_MODEL_BULK to a ZDR-eligible model instead. Honoring "${model}" for now.`,
    );
  }

  // Anthropic family → native Messages API adapter (never a base-URL swap).
  if (/^claude-/i.test(model)) {
    if (
      !grandfathered &&
      !(ANTHROPIC_ZDR_MODELS as readonly string[]).includes(model)
    ) {
      return toMock(
        workload,
        model,
        source,
        "not a ZDR-eligible Anthropic model; refusing to route client data to it",
      );
    }
    if (!anthropicKey) {
      return toMock(
        workload,
        model,
        source,
        "ANTHROPIC_API_KEY is not set",
      );
    }
    return {
      workload,
      requestedModel: model,
      source,
      provider: new AnthropicLlmProvider(anthropicKey, model),
      fallbackReason: null,
    };
  }

  // OpenAI family → OpenAI-compatible adapter (also serves self-hosted
  // OpenAI-compatible endpoints such as vLLM when LLM_SELF_HOST=1).
  if (/^gpt-/i.test(model) || isSelfHost()) {
    if (
      !grandfathered &&
      !isSelfHost() &&
      !(OPENAI_ZDR_MODELS as readonly string[]).includes(model)
    ) {
      return toMock(
        workload,
        model,
        source,
        "not a ZDR-eligible OpenAI model; refusing to route client data to it",
      );
    }
    if (!openAiKey) {
      return toMock(
        workload,
        model,
        source,
        "LLM_API_KEY/OPENAI_API_KEY is not set",
      );
    }
    return {
      workload,
      requestedModel: model,
      source,
      provider: openAiCompatible(openAiKey, model),
      fallbackReason: null,
    };
  }

  // Unknown model strings fail closed to mock — never a guessed provider (T1).
  return toMock(
    workload,
    model,
    source,
    "unknown model; refusing to guess a provider",
  );
}

/** Primary API: the provider for a workload. */
export function getLlmProviderFor(workload: LlmWorkload): LlmProvider {
  return resolveWorkload(workload).provider;
}

/** Per-workload status for Settings → Providers and API responses.
 *  Never includes key material — only booleans and model names (T3). */
export function llmRoutingStatus(): Record<
  LlmWorkload,
  {
    name: string;
    isLive: boolean;
    configured: boolean;
    model: string;
    source: "env" | "legacy" | "default";
    fallback: string | null;
  }
> {
  const out = {} as ReturnType<typeof llmRoutingStatus>;
  for (const w of ["copy", "bulk", "background"] as const) {
    const r = resolveWorkload(w);
    out[w] = {
      name: r.provider.name,
      isLive: r.provider.isLive,
      configured: r.provider.isConfigured(),
      model: r.requestedModel,
      source: r.source,
      fallback: r.fallbackReason,
    };
  }
  return out;
}
