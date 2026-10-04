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
//   5. Single-key mode (Phase 6): a workload whose model comes from the
//      DEFAULT (not env) and whose provider key is missing uses the other
//      family's default for that workload when that family's key is set.
//      Explicit env choices are never overridden (they still fall back to
//      mock, loudly). Not applied with LLM_SELF_HOST=1.
//   6. Failover (Phase 6): a live workload is wrapped in FailoverLlmProvider
//      with the other family's allowed default for the workload, when that
//      family's key is set — on retryable errors only (429/5xx/timeout/
//      network), never on abort or other 4xx. The fallback passes the same
//      block-list + ZDR allow-list. Off with LLM_FAILOVER=0 or self-host.
//
// Legacy: plain LLM_MODEL / LLM_API_KEY / LLM_BASE_URL are still honored as a
// bulk-workload override (with a deprecation warning) when none of the
// LLM_MODEL_* vars are set, so existing deployments don't change behavior.

import { AnthropicLlmProvider } from "./anthropic";
import { OpenAiCompatibleLlmProvider } from "./openai";
import { MockLlmProvider } from "./mock";
import { FailoverLlmProvider } from "./failover";
import type { LlmProvider } from "./types";

export type LlmWorkload = "copy" | "bulk" | "background";

export const WORKLOAD_DEFAULTS: Record<LlmWorkload, string> = {
  copy: "claude-haiku-4-5",
  bulk: "gpt-5-nano",
  background: "gpt-5-nano:flex",
};

export type LlmFamily = "anthropic" | "openai";

/** Each family's default per workload: what single-key mode routes to, and
 *  what failover tries. Every entry must be on its family's ZDR allow-list
 *  (asserted by scripts/verify-llm-routing.mts). */
export const FAMILY_WORKLOAD_DEFAULTS: Record<LlmFamily, Record<LlmWorkload, string>> = {
  anthropic: {
    copy: "claude-haiku-4-5",
    bulk: "claude-haiku-4-5",
    background: "claude-haiku-4-5",
  },
  openai: {
    copy: "gpt-5.4-nano",
    bulk: "gpt-5-nano",
    background: "gpt-5-nano:flex",
  },
};

const FAMILY_KEY_ENV: Record<LlmFamily, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "LLM_API_KEY/OPENAI_API_KEY",
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

/** OpenAI image models (Images API, /v1/images/*) that may be used. Kept
 *  SEPARATE from the text allow-lists: images skip text routing entirely
 *  (lib/images/openai.ts is the only caller), and an image model can never
 *  be selected for a text workload (familyOf() says "openai", but it is not
 *  on OPENAI_ZDR_MODELS). Source: OpenAI "Your data" guide, /v1/images —
 *  "Image generation is Zero Data Retention compatible when using
 *  gpt-image-2.5-sunburst, gpt-image-2.5-sunburst-2026-09-08,
 *  gpt-image-2.5-flare, gpt-image-2.5-flare-2026-09-08, gpt-image-2,
 *  gpt-image-1.5, gpt-image-1, and gpt-image-1-mini" (checked 2026-10-04).
 *  The dated gpt-image-2-2026-04-21 snapshot is not named there, so it is
 *  not listed. */
export const OPENAI_IMAGE_ZDR_MODELS = [
  "gpt-image-2",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5-sunburst-2026-09-08",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-flare-2026-09-08",
  "gpt-image-1.5",
  "gpt-image-1",
  "gpt-image-1-mini",
] as const;

/** The image model used when LLM_IMAGE_MODEL is unset (owner decision
 *  2026-10-04: ChatGPT's image model across the OS). */
export const DEFAULT_IMAGE_MODEL = "gpt-image-2";

/** True when an image model passes the block-list and the image allow-list. */
export function isAllowedImageModel(model: string): boolean {
  if (BLOCKED_MODEL_PATTERN.test(model) || SELF_HOST_MODEL_PATTERN.test(model)) return false;
  return (OPENAI_IMAGE_ZDR_MODELS as readonly string[]).includes(model);
}

/** Unconditionally blocked model families (T1). Checked before provider
 *  mapping; a match always falls back to mock, loudly. */
const BLOCKED_MODEL_PATTERN = /deepseek|gemini/i;

/** Qwen-class models: blocked for hosted cloud endpoints (retention terms
 *  unverified) unless the operator explicitly opts into self-host. */
const SELF_HOST_MODEL_PATTERN = /qwen/i;

/** Resolve the model string for a workload without constructing a provider
 *  (env / legacy / default only — single-key mode is applied in
 *  resolveWorkload, because it depends on which keys exist).
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

function failoverEnabled(): boolean {
  return (process.env.LLM_FAILOVER ?? "").trim() !== "0";
}

/** First non-empty trimmed value. An empty LLM_API_KEY="" (as copied from
 *  .env.example) must not mask OPENAI_API_KEY — `??` did exactly that. */
function firstSet(...values: Array<string | undefined>): string {
  for (const v of values) {
    const t = (v ?? "").trim();
    if (t) return t;
  }
  return "";
}

type EnvLike = Record<string, string | undefined>;

/** The OpenAI key, resolved the one way every OpenAI caller uses (text
 *  routing, images): LLM_API_KEY when non-empty, else OPENAI_API_KEY.
 *  Returns "" when neither is set. Never log the result. */
export function openAiApiKey(env: EnvLike = process.env): string {
  return firstSet(env.LLM_API_KEY, env.OPENAI_API_KEY);
}

/** The OpenAI(-compatible) base URL, without a trailing slash. */
export function openAiBaseUrl(env: EnvLike = process.env): string {
  return firstSet(env.OPENAI_BASE_URL, env.LLM_BASE_URL, "https://api.openai.com/v1").replace(/\/+$/, "");
}

function readKeys(): Record<LlmFamily, string> {
  return {
    openai: openAiApiKey(),
    anthropic: firstSet(process.env.ANTHROPIC_API_KEY),
  };
}

/** Model family by name; null for anything else (self-host names, unknown). */
export function familyOf(model: string): LlmFamily | null {
  if (/^claude-/i.test(model)) return "anthropic";
  if (/^gpt-/i.test(model)) return "openai";
  return null;
}

function otherFamily(f: LlmFamily): LlmFamily {
  return f === "anthropic" ? "openai" : "anthropic";
}

/** True when a hosted model passes the block-list AND its family's ZDR
 *  allow-list — the bar every substituted or fallback model must clear. */
export function isRoutableHostedModel(model: string): boolean {
  if (BLOCKED_MODEL_PATTERN.test(model) || SELF_HOST_MODEL_PATTERN.test(model)) return false;
  const fam = familyOf(model);
  if (fam === "anthropic") return (ANTHROPIC_ZDR_MODELS as readonly string[]).includes(model);
  if (fam === "openai") return (OPENAI_ZDR_MODELS as readonly string[]).includes(model);
  return false;
}

/** Per-attempt timeout override for the OpenAI-compatible adapter (ms). */
function openAiTimeoutOverride(): number | undefined {
  const n = Number((process.env.LLM_TIMEOUT_MS ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

function openAiCompatible(
  apiKey: string,
  model: string,
): OpenAiCompatibleLlmProvider {
  return new OpenAiCompatibleLlmProvider(apiKey, model, openAiBaseUrl(), {
    selfHost: isSelfHost(),
    timeoutMs: openAiTimeoutOverride(),
  });
}

/** Build the live provider for an allow-listed hosted model (failover use). */
function hostedProvider(model: string, keys: Record<LlmFamily, string>): LlmProvider | null {
  if (!isRoutableHostedModel(model)) return null;
  const fam = familyOf(model);
  if (fam === "anthropic" && keys.anthropic) return new AnthropicLlmProvider(keys.anthropic, model);
  if (fam === "openai" && keys.openai) return openAiCompatible(keys.openai, model);
  return null;
}

export interface ResolvedWorkload {
  workload: LlmWorkload;
  /** The model that is routed: env/default, or the single-key substitute. */
  requestedModel: string;
  /** Where the model string came from. */
  source: "env" | "legacy" | "default";
  /** The provider that will serve it — "mock" on any fallback. */
  provider: LlmProvider;
  /** Why mock was chosen, when it was. Never contains key material. */
  fallbackReason: string | null;
  /** Single-key mode: the default this workload would have used, and why it
   *  was swapped for the other family's default. Null when not applied. */
  singleKey: { from: string; reason: string } | null;
  /** The configured failover model (other family), when one is armed. */
  failoverModel: string | null;
}

function toMock(
  workload: LlmWorkload,
  requestedModel: string,
  source: "env" | "legacy" | "default",
  reason: string,
  singleKey: ResolvedWorkload["singleKey"] = null,
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
    singleKey,
    failoverModel: null,
  };
}

/** Resolve the primary (no failover wrapping). */
function resolvePrimary(workload: LlmWorkload, keys: Record<LlmFamily, string>): ResolvedWorkload {
  const resolved = resolveWorkloadModel(workload);
  const source = resolved.source;
  let model = resolved.model;
  let singleKey: ResolvedWorkload["singleKey"] = null;
  const openAiKey = keys.openai;
  const anthropicKey = keys.anthropic;

  // Single-key mode: only for DEFAULT choices, never env/legacy ones, and
  // never under self-host (the OpenAI-compatible endpoint is then local and
  // the operator names models explicitly — lib/llm/SELF-HOST.md).
  if (source === "default" && !isSelfHost()) {
    const fam = familyOf(model);
    if (fam && !keys[fam]) {
      const other = otherFamily(fam);
      const substitute = FAMILY_WORKLOAD_DEFAULTS[other][workload];
      if (keys[other] && isRoutableHostedModel(substitute)) {
        singleKey = {
          from: model,
          reason: `${FAMILY_KEY_ENV[fam]} is not set; single-key mode routes this workload to the ${other} default`,
        };
        model = substitute;
      }
    }
  }

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
      return toMock(workload, model, source, "ANTHROPIC_API_KEY is not set");
    }
    return {
      workload,
      requestedModel: model,
      source,
      provider: new AnthropicLlmProvider(anthropicKey, model),
      fallbackReason: null,
      singleKey,
      failoverModel: null,
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
      singleKey,
      failoverModel: null,
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

/** The other family's allowed default for a live primary, when its key is
 *  set. Null when failover is off, self-hosted, or nothing qualifies. */
export function failoverModelFor(
  workload: LlmWorkload,
  primaryModel: string,
): string | null {
  if (!failoverEnabled() || isSelfHost()) return null;
  const fam = familyOf(primaryModel);
  if (!fam) return null;
  const candidate = FAMILY_WORKLOAD_DEFAULTS[otherFamily(fam)][workload];
  if (!isRoutableHostedModel(candidate)) return null; // blocked/unlisted: never
  const keys = readKeys();
  return keys[otherFamily(fam)] ? candidate : null;
}

export function resolveWorkload(workload: LlmWorkload): ResolvedWorkload {
  const keys = readKeys();
  const primary = resolvePrimary(workload, keys);
  if (!primary.provider.isLive) return primary;
  const fbModel = failoverModelFor(workload, primary.requestedModel);
  const fallback = fbModel ? hostedProvider(fbModel, keys) : null;
  if (!fbModel || !fallback) return primary;
  return {
    ...primary,
    failoverModel: fbModel,
    provider: new FailoverLlmProvider(primary.provider, fallback, {
      workload,
      primaryModel: primary.requestedModel,
      fallbackModel: fbModel,
    }),
  };
}

/** Primary API: the provider for a workload. */
export function getLlmProviderFor(workload: LlmWorkload): LlmProvider {
  return resolveWorkload(workload).provider;
}

export interface LlmWorkloadStatus {
  name: string;
  isLive: boolean;
  configured: boolean;
  /** The model actually routed (after single-key substitution). */
  model: string;
  source: "env" | "legacy" | "default";
  /** Why this workload is on mock; null when live. */
  fallback: string | null;
  /** Single-key mode explanation; null when not applied. */
  singleKey: string | null;
  /** Configured failover model (other family); null when none is armed. */
  failover: string | null;
}

/** Per-workload status for Settings → Providers and API responses.
 *  Never includes key material — only booleans and model names (T3). */
export function llmRoutingStatus(): Record<LlmWorkload, LlmWorkloadStatus> {
  const out = {} as Record<LlmWorkload, LlmWorkloadStatus>;
  for (const w of ["copy", "bulk", "background"] as const) {
    const r = resolveWorkload(w);
    out[w] = {
      name: r.provider.name,
      isLive: r.provider.isLive,
      configured: r.provider.isConfigured(),
      model: r.requestedModel,
      source: r.source,
      fallback: r.fallbackReason,
      singleKey: r.singleKey
        ? `Default "${r.singleKey.from}" swapped: ${r.singleKey.reason}.`
        : null,
      failover: r.failoverModel,
    };
  }
  return out;
}
