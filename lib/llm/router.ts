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
//   7. Agent workloads (Phase 7) — the models the agent runtime uses:
//        LLM_MODEL_LEAD       (default "claude-opus-5-5", effort medium) — lead agent, planner
//        LLM_MODEL_SUBAGENT   (default "claude-sonnet-5-5")              — other sub-agents
//        LLM_MODEL_CODE       (default "claude-opus-5-5", effort high)   — code agent
//        LLM_MODEL_CODE_MAX   (default "claude-fable-5-1")               — code agent escalation
//      Single-key OpenAI-only runs all four on gpt-5.5; failover goes to
//      gpt-5.5 (or claude-sonnet-5-5 the other way). AGENT_WORKLOADS maps
//      agent keys (lib/agents/grants.ts) to workloads.
//   9. Per-workspace model keys (Phase 15.1): resolveWorkload(w, {
//      workspaceKeys }) uses a workspace's own Anthropic / OpenAI key in place
//      of the env key for that family (lib/llm/workspace-keys.ts loads them
//      from the vault). Every safety rule above applies unchanged — the
//      block-list, the ZDR allow-lists, the retention opt-in — because the
//      key changes who pays, never which models are routable. A workspace
//      OpenAI key always goes to api.openai.com (never an operator base URL
//      or a self-host endpoint) and is ignored under LLM_SELF_HOST=1.
//      Providers carry keySource ("workspace" → 0 credits, lib/llm/usage.ts).
//   8. Covered (30-day-retention) models (Phase 7): Anthropic's Fable 5.x
//      requires 30-day retention — a ZDR org gets HTTP 400 on every request —
//      so it is NOT on the ZDR allow-list. It routes only when the operator
//      opts in with LLM_ALLOW_RETENTION_MODELS=1 (accepting that retention).
//      Without the opt-in, a DEFAULT choice of it is swapped for the
//      strongest ZDR-eligible model (claude-opus-5-5 at effort max) and the
//      swap is shown in status; an explicit env choice falls back to mock.
//
// Legacy: plain LLM_MODEL / LLM_API_KEY / LLM_BASE_URL are still honored as a
// bulk-workload override (with a deprecation warning) when none of the
// LLM_MODEL_* vars are set, so existing deployments don't change behavior.

import { AnthropicLlmProvider } from "./anthropic";
import { OpenAiCompatibleLlmProvider } from "./openai";
import { MockLlmProvider } from "./mock";
import { FailoverLlmProvider } from "./failover";
import type { ChatEffort, LlmKeySource, LlmProvider } from "./types";
import type { AgentKey } from "@/lib/agents/grants";

export type LlmWorkload = "copy" | "bulk" | "background" | "lead" | "subagent" | "code" | "code_max";

/** Every workload, in display order (Settings → Providers). */
export const LLM_WORKLOADS: readonly LlmWorkload[] = ["copy", "bulk", "background", "lead", "subagent", "code", "code_max"];

/** The Phase 7 agent-runtime workloads. */
export const AGENT_LLM_WORKLOADS: readonly LlmWorkload[] = ["lead", "subagent", "code", "code_max"];

export const WORKLOAD_DEFAULTS: Record<LlmWorkload, string> = {
  copy: "claude-haiku-4-5",
  bulk: "gpt-5-nano",
  background: "gpt-5-nano:flex",
  lead: "claude-opus-5-5",
  subagent: "claude-sonnet-5-5",
  code: "claude-opus-5-5",
  code_max: "claude-fable-5-1",
};

/** Effort applied to chat() calls that name none. Unset = the model's default. */
export const WORKLOAD_EFFORT: Readonly<Partial<Record<LlmWorkload, ChatEffort>>> = {
  lead: "medium",
  code: "high",
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
    // Agent workloads already default to Anthropic; these entries are what an
    // OpenAI primary (an LLM_MODEL_* override) fails over to.
    lead: "claude-sonnet-5-5",
    subagent: "claude-sonnet-5-5",
    code: "claude-sonnet-5-5",
    code_max: "claude-sonnet-5-5",
  },
  openai: {
    copy: "gpt-5.4-nano",
    bulk: "gpt-5-nano",
    background: "gpt-5-nano:flex",
    lead: "gpt-5.5",
    subagent: "gpt-5.5",
    code: "gpt-5.5",
    code_max: "gpt-5.5",
  },
};

const FAMILY_KEY_ENV: Record<LlmFamily, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "LLM_API_KEY/OPENAI_API_KEY",
};

export const WORKLOAD_ENV: Record<LlmWorkload, string> = {
  copy: "LLM_MODEL_COPY",
  bulk: "LLM_MODEL_BULK",
  background: "LLM_MODEL_BACKGROUND",
  lead: "LLM_MODEL_LEAD",
  subagent: "LLM_MODEL_SUBAGENT",
  code: "LLM_MODEL_CODE",
  code_max: "LLM_MODEL_CODE_MAX",
};

/** Suggested output-token ceilings per workload (T4 cost-blowout guard). */
export const WORKLOAD_MAX_TOKENS: Record<LlmWorkload, number> = {
  copy: 4096,
  bulk: 2048,
  background: 2048,
  lead: 16384,
  subagent: 8192,
  code: 32768,
  code_max: 65536,
};

/**
 * Which workload each agent runs on (Phase 8 consumes this). The lead and the
 * planner plan (lead); the operator ("actor") in build mode writes code
 * (code); every other sub-agent is a subagent. code_max is reached only by an
 * explicit escalation from the code workload, never by an agent key.
 */
export const AGENT_WORKLOADS: Readonly<Record<AgentKey, LlmWorkload>> = {
  lead: "lead",
  planner: "lead",
  researcher: "subagent",
  drafter: "subagent",
  analyst: "subagent",
  scheduler: "subagent",
  actor: "subagent",
};

export function workloadForAgent(agentKey: AgentKey, opts: { mode?: "build" | "default" } = {}): LlmWorkload {
  if (agentKey === "actor" && opts.mode === "build") return "code";
  return AGENT_WORKLOADS[agentKey];
}

/** ZDR-eligible models per provider. OpenAI ZDR itself is a process step
 *  (approval for Tico), but only ZDR-eligible models are routable — code can
 *  never select a model outside this list for hosted use. */
export const ANTHROPIC_ZDR_MODELS = [
  "claude-haiku-4-5",
  "claude-sonnet-5",
  "claude-opus-5",
  // Phase 7. Not "covered" models (only Fable/Mythos mandate retention), per
  // the Claude API docs (models.md) as read 2026-10-04.
  "claude-opus-5-5",
  "claude-sonnet-5-5",
] as const;

/** Anthropic "covered" models: 30-day retention is REQUIRED (ZDR orgs get
 *  HTTP 400). Routable only with LLM_ALLOW_RETENTION_MODELS=1. */
export const ANTHROPIC_RETENTION_MODELS = ["claude-fable-5-1"] as const;

/** A default choice of a retention model, without the opt-in, runs here instead. */
const RETENTION_SUBSTITUTES: Readonly<Record<string, { model: string; effort: ChatEffort }>> = {
  "claude-fable-5-1": { model: "claude-opus-5-5", effort: "max" },
};

export const OPENAI_ZDR_MODELS = [
  "gpt-5-nano",
  "gpt-5.4-nano",
  "gpt-5-nano:flex",
  // Phase 7 failover / single-key model for the agent workloads. ZDR
  // eligibility per the Phase 7 plan (third-party sources; re-check with
  // OpenAI when the ZDR request is filed — SELF-HOST.md).
  "gpt-5.5",
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

/** LLM_ALLOW_RETENTION_MODELS=1: the operator accepts 30-day retention. */
export function retentionModelsAllowed(): boolean {
  return (process.env.LLM_ALLOW_RETENTION_MODELS ?? "").trim() === "1";
}

function isRetentionModel(model: string): boolean {
  return (ANTHROPIC_RETENTION_MODELS as readonly string[]).includes(model);
}

function isAllowedAnthropicModel(model: string): boolean {
  return (
    (ANTHROPIC_ZDR_MODELS as readonly string[]).includes(model) || (isRetentionModel(model) && retentionModelsAllowed())
  );
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

/** Phase 15.1: a workspace's own model keys (never logged, never returned). */
export type WorkspaceModelKeys = Partial<Record<LlmFamily, string>>;

/** The official OpenAI endpoint — where a workspace's own key is sent. */
export const OPENAI_OFFICIAL_BASE_URL = "https://api.openai.com/v1";

interface KeySet {
  keys: Record<LlmFamily, string>;
  source: Record<LlmFamily, LlmKeySource>;
}

function readKeys(workspaceKeys: WorkspaceModelKeys = {}): KeySet {
  const ws = {
    anthropic: firstSet(workspaceKeys.anthropic),
    // Self-host routes the OpenAI family to a local endpoint: a workspace's
    // OpenAI key has nowhere safe to go there, so it is not used.
    openai: isSelfHost() ? "" : firstSet(workspaceKeys.openai),
  };
  return {
    keys: {
      openai: ws.openai || openAiApiKey(),
      anthropic: ws.anthropic || firstSet(process.env.ANTHROPIC_API_KEY),
    },
    source: {
      anthropic: ws.anthropic ? "workspace" : "platform",
      openai: ws.openai ? "workspace" : isSelfHost() ? "self_host" : "platform",
    },
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
  if (fam === "anthropic") return isAllowedAnthropicModel(model);
  if (fam === "openai") return (OPENAI_ZDR_MODELS as readonly string[]).includes(model);
  return false;
}

/** Per-attempt timeout override for the OpenAI-compatible adapter (ms). */
function openAiTimeoutOverride(): number | undefined {
  const n = Number((process.env.LLM_TIMEOUT_MS ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

interface ChatDefaults {
  workload: LlmWorkload;
  defaultEffort: ChatEffort | null;
}

function openAiCompatible(
  apiKey: string,
  model: string,
  chat: ChatDefaults,
  keySource: LlmKeySource,
): OpenAiCompatibleLlmProvider {
  const own = keySource === "workspace";
  return new OpenAiCompatibleLlmProvider(apiKey, model, own ? OPENAI_OFFICIAL_BASE_URL : openAiBaseUrl(), {
    selfHost: own ? false : isSelfHost(),
    timeoutMs: openAiTimeoutOverride(),
    workload: chat.workload,
    defaultEffort: chat.defaultEffort,
    keySource,
  });
}

/** Build the live provider for an allow-listed hosted model (failover use). */
function hostedProvider(model: string, ks: KeySet, chat: ChatDefaults): LlmProvider | null {
  if (!isRoutableHostedModel(model)) return null;
  const fam = familyOf(model);
  if (fam === "anthropic" && ks.keys.anthropic) {
    return new AnthropicLlmProvider(ks.keys.anthropic, model, { ...chat, keySource: ks.source.anthropic });
  }
  if (fam === "openai" && ks.keys.openai) return openAiCompatible(ks.keys.openai, model, chat, ks.source.openai);
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
  /** Effort applied to chat() calls that name none (null = model default). */
  effort: ChatEffort | null;
  /** Covered-model swap: the 30-day-retention default and why it was not
   *  used. Null when not applied. */
  retention: { from: string; reason: string } | null;
  /** Phase 15.1: whose key serves the primary; null on mock. */
  keySource: LlmKeySource | null;
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
    effort: WORKLOAD_EFFORT[workload] ?? null,
    retention: null,
    keySource: null,
  };
}

/** Resolve the primary (no failover wrapping). */
function resolvePrimary(workload: LlmWorkload, ks: KeySet): ResolvedWorkload {
  const keys = ks.keys;
  const resolved = resolveWorkloadModel(workload);
  const source = resolved.source;
  let model = resolved.model;
  let singleKey: ResolvedWorkload["singleKey"] = null;
  let retention: ResolvedWorkload["retention"] = null;
  let effort: ChatEffort | null = WORKLOAD_EFFORT[workload] ?? null;
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

  // Covered (30-day-retention) models need the explicit opt-in (T1/T6).
  if (isRetentionModel(model) && !retentionModelsAllowed()) {
    const sub = RETENTION_SUBSTITUTES[model];
    if (source === "default" && sub) {
      retention = {
        from: model,
        reason: `${model} requires 30-day data retention (not zero-retention); set LLM_ALLOW_RETENTION_MODELS=1 to use it`,
      };
      model = sub.model;
      effort = sub.effort;
    } else {
      return toMock(
        workload,
        model,
        source,
        "requires 30-day data retention (a covered model, not zero-retention); set LLM_ALLOW_RETENTION_MODELS=1 to accept that, or choose a ZDR-eligible model",
      );
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
    if (!grandfathered && !isAllowedAnthropicModel(model)) {
      return toMock(
        workload,
        model,
        source,
        "not a ZDR-eligible Anthropic model; refusing to route client data to it",
      );
    }
    if (!anthropicKey) {
      return { ...toMock(workload, model, source, "ANTHROPIC_API_KEY is not set"), retention, effort };
    }
    return {
      workload,
      requestedModel: model,
      source,
      provider: new AnthropicLlmProvider(anthropicKey, model, { workload, defaultEffort: effort, keySource: ks.source.anthropic }),
      fallbackReason: null,
      singleKey,
      failoverModel: null,
      effort,
      retention,
      keySource: ks.source.anthropic,
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
      provider: openAiCompatible(openAiKey, model, { workload, defaultEffort: effort }, ks.source.openai),
      fallbackReason: null,
      singleKey,
      failoverModel: null,
      effort,
      retention,
      keySource: ks.source.openai,
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
  workspaceKeys: WorkspaceModelKeys = {},
): string | null {
  if (!failoverEnabled() || isSelfHost()) return null;
  const fam = familyOf(primaryModel);
  if (!fam) return null;
  const candidate = FAMILY_WORKLOAD_DEFAULTS[otherFamily(fam)][workload];
  if (!isRoutableHostedModel(candidate)) return null; // blocked/unlisted: never
  const { keys } = readKeys(workspaceKeys);
  return keys[otherFamily(fam)] ? candidate : null;
}

export interface ResolveOptions {
  /** Phase 15.1: the workspace's own model keys (lib/llm/workspace-keys.ts). */
  workspaceKeys?: WorkspaceModelKeys;
}

export function resolveWorkload(workload: LlmWorkload, opts: ResolveOptions = {}): ResolvedWorkload {
  const ks = readKeys(opts.workspaceKeys);
  const primary = resolvePrimary(workload, ks);
  if (!primary.provider.isLive) return primary;
  const fbModel = failoverModelFor(workload, primary.requestedModel, opts.workspaceKeys);
  const fallback = fbModel
    ? hostedProvider(fbModel, ks, { workload, defaultEffort: WORKLOAD_EFFORT[workload] ?? null })
    : null;
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
  /** Effort applied to chat() calls that name none; null = model default. */
  effort: ChatEffort | null;
  /** Covered-model swap explanation; null when not applied. */
  retention: string | null;
  /** Phase 15.1: whose key serves the workload; null on mock. */
  keySource: LlmKeySource | null;
}

/** Per-workload status for Settings → Providers and API responses.
 *  Never includes key material — only booleans and model names (T3). */
export function llmRoutingStatus(opts: ResolveOptions = {}): Record<LlmWorkload, LlmWorkloadStatus> {
  const out = {} as Record<LlmWorkload, LlmWorkloadStatus>;
  for (const w of LLM_WORKLOADS) {
    const r = resolveWorkload(w, opts);
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
      effort: r.effort,
      retention: r.retention ? `Default "${r.retention.from}" swapped: ${r.retention.reason}.` : null,
      keySource: r.keySource,
    };
  }
  return out;
}
