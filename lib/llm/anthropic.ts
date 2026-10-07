// Marketr — native Anthropic Messages API provider (Phase D, Direction B).
//
// This is a dedicated adapter, NOT an LLM_BASE_URL swap: Anthropic's API is
// the Messages API (system + messages + max_tokens), not OpenAI-style
// /chat/completions. Key comes from ANTHROPIC_API_KEY only.
// Security: the key lives in a private field and is never interpolated into
// errors, logs, or return values (see lib/llm/THREAT-MODEL-LLM.md T3).
// Phase 6: errors are classified LlmProviderError (lib/llm/errors.ts) so the
// router can fail over on 429 / 5xx / timeout / network and never on other
// 4xx. The SDK's own retry is bounded to ONE (it honours Retry-After) and the
// per-attempt timeout is 2 minutes, instead of the SDK defaults (2 retries ×
// 10 minutes), so a degraded vendor hands over to the failover promptly.
//
// Phase 7: chat() / chatStream() — the agent-grade API (lib/llm/types.ts),
// built against @anthropic-ai/sdk 0.128.0 and the Claude API docs:
//   - adaptive thinking + output_config.effort where the model supports them
//     (anthropicModelCaps). Claude Opus 5.5 / Fable 5.1 cannot turn thinking
//     off (thinking.disabled → 400); Sonnet 5.5 turns it off with
//     {type: "between_tools"} at effort high or below; Haiku 4.5 has neither
//     adaptive thinking nor effort. What could not be applied is reported in
//     meta.notes, never sent as a request that 400s.
//   - prompt caching (Phase 17 A1): a breakpoint on the last LOADED tool and
//     one on the last system block, both with the request's TTL (1h for
//     chat, 5m otherwise — cache_control.ttl, SDK CacheControlEphemeral);
//     optional automatic caching of the conversation tail (top-level
//     cache_control, 5m — a 1h marker before a 5m tail is the documented
//     order). Tools are sorted by name so the cached prefix is byte-stable;
//     deferred tools sort after loaded ones (they are not rendered into the
//     prefix and may not carry cache_control).
//   - tool search (Phase 17 A2): ChatToolDef.deferLoading → `defer_loading`
//     plus the server-side tool_search_tool_bm25_20251119 tool (SDK
//     ToolSearchToolBm25_20251119, non-beta), on the models the docs list.
//   - context editing (Phase 17 A3): clear_tool_uses_20250919 under beta
//     context-management-2025-06-27 (SDK BetaClearToolUses20250919Edit).
//   - service_tier (Phase 17 A4): "auto" | "standard_only" (SDK
//     MessageCreateParams.service_tier); the response's usage.service_tier is
//     reported back.
//   - timing (Phase 17 A1): ttftMs (first content delta) and durationMs.
//   - server tools web_search_20260209 / web_fetch_20260209 on models that
//     support them.
//   - forced tool_choice is NEVER sent to Claude Opus 5.5 / Sonnet 5.5 /
//     Fable 5.1 (400); it degrades to auto with a note.
//   - stop reasons refusal / max_tokens / pause_turn / context window are
//     surfaced as the response's stopReason (+ truncated), never swallowed;
//     tool calls of a cut-off or refused turn are marked invalid.
//   - streaming sets eager_input_streaming on client tools, so the API no
//     longer validates their input: every tool input is strictly re-parsed
//     from the streamed fragments and checked against its schema
//     (lib/llm/tool-input.ts) before it is handed back.
// NOTE: live path is implemented but untested from this sandbox — the sandbox
// has no Anthropic credentials and restricted egress. Exercise it on a real
// host with ANTHROPIC_API_KEY in .env before trusting it.

import Anthropic from "@anthropic-ai/sdk";
import { LlmProviderError, kindForStatus, type LlmErrorKind } from "./errors";
import { estimateCostMicroUsd, priceFor } from "./pricing";
import { checkToolUse } from "./tool-input";
import { assertModelSpendAllowed, recordChatUsage } from "./usage";
import type {
  ChatCacheTtl,
  ChatContentBlock,
  ChatEffort,
  ChatRequest,
  ChatResponse,
  ChatResponseMeta,
  ChatServerTool,
  ChatStopReason,
  ChatStreamEvent,
  ChatUsage,
  LlmGenerateOptions,
  LlmKeySource,
  LlmProvider,
} from "./types";

export const ANTHROPIC_TIMEOUT_MS = 120_000;

/** Phase 17 (A4): workloads no person waits on (never priority capacity). */
export const NON_INTERACTIVE_WORKLOADS: ReadonlySet<string> = new Set(["bulk", "background", "subagent"]);
export const ANTHROPIC_MAX_RETRIES = 1;

/** Map an SDK error to a classified, key-free LlmProviderError. */
export function classifyAnthropicError(err: unknown): LlmProviderError {
  const provider = "anthropic";
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new LlmProviderError({ provider, kind: "timeout", detail: "Anthropic API timeout" });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new LlmProviderError({ provider, kind: "network", detail: "Anthropic API connection error" });
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === "number" ? err.status : null;
    const kind: LlmErrorKind = status === null ? "server" : kindForStatus(status);
    return new LlmProviderError({
      provider,
      kind,
      status,
      detail: `Anthropic API error (HTTP ${status ?? "unknown"})`,
    });
  }
  // The SDK materializes a streamed tool input at content_block_stop with a
  // partial-JSON parser that throws SyntaxError on input it cannot repair;
  // MessageStream re-emits it as an AnthropicError whose cause is that error.
  if (err instanceof SyntaxError || (err instanceof Anthropic.AnthropicError && err.cause instanceof SyntaxError)) {
    return new LlmProviderError({
      provider,
      kind: "tool_input",
      detail: "a streamed tool input was not parseable JSON; re-issue the turn",
    });
  }
  // Unknown failure inside the SDK: report it sanitized; treat as network so a
  // configured failover still gets a chance (it is never a 4xx rejection).
  const msg = err instanceof Error ? err.message : "unknown error";
  return new LlmProviderError({ provider, kind: "network", detail: msg });
}

// ── model capabilities ──────────────────────────────────────────────────────

export interface AnthropicModelCaps {
  /** Accepts thinking: {type: "adaptive"}. */
  adaptiveThinking: boolean;
  /** How "thinking off" is expressed: a param, nothing (already off), or impossible. */
  thinkingOff: "disabled" | "between_tools" | "omit" | "impossible";
  /** Accepts output_config.effort. */
  effort: boolean;
  /** Accepts forced tool_choice (any / tool). */
  forcedToolChoice: boolean;
  /** Accepts web_search_20260209 / web_fetch_20260209. */
  serverTools: boolean;
  /** Phase 8: server-side compaction (beta compact-2026-01-12 / compact_20260112). */
  compaction?: boolean;
  /**
   * Phase 17 (A2): tool_search_tool_bm25_20251119 / defer_loading. Per the
   * tool-search-tool docs (model compatibility table, read 2026-10-06): every
   * current model from Haiku 4.5 up; Opus 4.1 and earlier do not.
   */
  toolSearch: boolean;
  /**
   * Phase 17 (A3): clear_tool_uses_20250919 under context-management-2025-06-27.
   * Per the context-editing docs (read 2026-10-06): all supported models.
   */
  contextEditing: boolean;
}

/** Per-model API surface, from the Claude API docs (models.md, error-codes.md,
 *  tool-use-concepts.md). Unknown models get the most conservative surface. */
export function anthropicModelCaps(model: string): AnthropicModelCaps {
  switch (model) {
    case "claude-opus-5-5":
      // Thinking always on; effort is the only depth control; forced tool_choice 400s.
      // Compaction beta: listed for Opus 5.5 (typescript/claude-api/README.md → Compaction).
      return { adaptiveThinking: true, thinkingOff: "impossible", effort: true, forcedToolChoice: false, serverTools: true, compaction: true, toolSearch: true, contextEditing: true };
    case "claude-fable-5-1":
      // As Opus 5.5. The compaction beta is documented for "Fable 5", not
      // named for 5.1 — not assumed (the loop compacts client-side instead).
      return { adaptiveThinking: true, thinkingOff: "impossible", effort: true, forcedToolChoice: false, serverTools: true, toolSearch: true, contextEditing: true };
    case "claude-sonnet-5-5":
      // disabled 400s; between_tools at effort <= high turns it off; forced 400s.
      return { adaptiveThinking: true, thinkingOff: "between_tools", effort: true, forcedToolChoice: false, serverTools: true, toolSearch: true, contextEditing: true };
    case "claude-opus-5":
      // Adaptive by default; disabled only at effort high or lower. Compaction beta listed.
      return { adaptiveThinking: true, thinkingOff: "disabled", effort: true, forcedToolChoice: true, serverTools: true, compaction: true, toolSearch: true, contextEditing: true };
    case "claude-sonnet-5":
      // Adaptive by default; disabled only at effort high or lower.
      return { adaptiveThinking: true, thinkingOff: "disabled", effort: true, forcedToolChoice: true, serverTools: true, toolSearch: true, contextEditing: true };
    case "claude-haiku-4-5":
      // No adaptive thinking, no effort (thinking is off unless budgeted).
      return { adaptiveThinking: false, thinkingOff: "omit", effort: false, forcedToolChoice: true, serverTools: false, toolSearch: true, contextEditing: true };
    default:
      return { adaptiveThinking: false, thinkingOff: "omit", effort: false, forcedToolChoice: false, serverTools: false, toolSearch: false, contextEditing: false };
  }
}

const EPHEMERAL = { type: "ephemeral" } as const;
/** SDK CacheControlEphemeral: { type: "ephemeral", ttl?: "5m" | "1h" } (resources/messages/messages.d.ts). */
function cacheControl(ttl: ChatCacheTtl | undefined): Anthropic.Messages.CacheControlEphemeral {
  return ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : EPHEMERAL;
}
const MAX_CACHE_BREAKPOINTS = 4;
const SERVER_TOOL_TYPES: Record<ChatServerTool, string> = {
  web_search: "web_search_20260209",
  web_fetch: "web_fetch_20260209",
};

/** Phase 17 (A2): the server-side tool search tool (SDK ToolSearchToolBm25_20251119). */
export const TOOL_SEARCH_TOOL = { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" } as const;

export interface BuiltAnthropicRequest {
  params: Anthropic.Messages.MessageCreateParamsNonStreaming;
  notes: string[];
  serverToolsSent: ChatServerTool[];
  /** Phase 8: the request uses the compaction beta (send via client.beta.messages). */
  compaction: boolean;
  /** Phase 17: the request carries any `betas` (send via client.beta.messages). */
  beta: boolean;
  /** Phase 17 (A2): deferred tools were offered through server-side tool search. */
  toolSearch: boolean;
  /** Phase 17 (A3): context editing was sent. */
  contextEditing: boolean;
  /** Phase 17: the effort actually sent (null = the model's default). */
  effort: ChatEffort | null;
}

/** Phase 8: the documented compaction beta (typescript/claude-api/README.md). */
export const COMPACTION_BETA = "compact-2026-01-12";
export const COMPACTION_EDIT = "compact_20260112";
/** Phase 17 (A3): the documented context-editing beta (SDK AnthropicBeta union, resources/beta/beta.d.ts). */
export const CONTEXT_EDITING_BETA = "context-management-2025-06-27";
export const CLEAR_TOOL_USES_EDIT = "clear_tool_uses_20250919";
/** Defaults of clear_tool_uses_20250919 per the context-editing docs (trigger 100k input tokens, keep 3). */
export const CONTEXT_EDITING_DEFAULTS = { triggerInputTokens: 100_000, keepToolUses: 3 } as const;

function toAnthropicContent(
  blocks: ChatContentBlock[],
  notes: string[],
  count: { breakpoints: number },
): Anthropic.Messages.ContentBlockParam[] {
  const out: Anthropic.Messages.ContentBlockParam[] = [];
  let dropped = 0;
  for (const b of blocks) {
    switch (b.type) {
      case "text":
        if (b.cache) count.breakpoints++;
        out.push({ type: "text", text: b.text, ...(b.cache ? { cache_control: EPHEMERAL } : {}) });
        break;
      case "tool_use":
        out.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
        break;
      case "tool_result":
        out.push({
          type: "tool_result",
          tool_use_id: b.toolUseId,
          content: typeof b.content === "string" ? b.content : b.content.map((t) => ({ type: "text" as const, text: t.text })),
          ...(b.isError ? { is_error: true } : {}),
        });
        break;
      case "image":
        // Phase 19A: the cursor's screenshot, for this call only.
        out.push({ type: "image", source: { type: "base64", media_type: b.mediaType, data: b.data } });
        break;
      case "opaque":
        // Thinking blocks (with signatures), server tool calls and results are
        // passed back unchanged — required for tool-use turns with thinking.
        if (b.provider === "anthropic") out.push(b.raw as Anthropic.Messages.ContentBlockParam);
        else dropped++;
        break;
    }
  }
  if (dropped) notes.push(`${dropped} ${dropped === 1 ? "block" : "blocks"} from another provider could not be sent to Anthropic and were dropped.`);
  return out;
}

/**
 * Build the Messages API request for one chat() turn. PURE (exported for
 * tests). Never produces a parameter the model is documented to reject.
 */
export function buildAnthropicParams(
  model: string,
  req: ChatRequest,
  opts: { stream: boolean; defaultEffort?: ChatEffort | null; betaAvailable?: boolean },
): BuiltAnthropicRequest {
  if (!Number.isInteger(req.maxTokens) || req.maxTokens < 1) {
    throw new LlmProviderError({ provider: "anthropic", kind: "client", detail: "maxTokens must be a positive integer" });
  }
  const caps = anthropicModelCaps(model);
  const notes: string[] = [];
  const count = { breakpoints: 0 };

  const ttl = req.cacheTtl;

  // System prompt → text blocks.
  const sysIn = typeof req.system === "string" ? (req.system ? [{ text: req.system }] : []) : (req.system ?? []);
  const system: Anthropic.Messages.TextBlockParam[] = sysIn.map((b) => {
    const cache = "cache" in b && b.cache === true;
    if (cache) count.breakpoints++;
    return { type: "text", text: b.text, ...(cache ? { cache_control: cacheControl(ttl) } : {}) };
  });

  // Tools: server tools first, then LOADED client tools sorted by name, then
  // deferred client tools sorted by name — so the last rendered tool block
  // (the tool breakpoint) is stable, and deferred tools (which the API keeps
  // out of the prefix and which may not carry cache_control) come after it.
  const serverToolsSent: ChatServerTool[] = [];
  const tools: Array<Record<string, unknown>> = [];
  const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const sortedClient = [...(req.tools ?? [])].sort(byName);
  const wantsToolSearch = req.toolSearch === true && sortedClient.some((t) => t.deferLoading);
  let toolSearch = false;
  if (wantsToolSearch) {
    if (caps.toolSearch) {
      // Must stay non-deferred itself; at least one other tool must be loaded
      // too (the API 400s when everything is deferred) — enforced below.
      tools.push({ ...TOOL_SEARCH_TOOL });
      toolSearch = true;
    } else {
      notes.push(`Tool search is not available on ${model}; deferred tools were sent as loaded tools.`);
    }
  }
  for (const s of [...new Set(req.serverTools ?? [])]) {
    if (caps.serverTools) {
      tools.push({ type: SERVER_TOOL_TYPES[s], name: s });
      serverToolsSent.push(s);
    } else {
      notes.push(`Server tool ${s} is not available on ${model}; not sent.`);
    }
  }
  const loadedClient = toolSearch ? sortedClient.filter((t) => !t.deferLoading) : sortedClient;
  const deferredClient = toolSearch ? sortedClient.filter((t) => t.deferLoading) : [];
  if (toolSearch && loadedClient.length === 0 && deferredClient.length > 0) {
    // Never send an all-deferred set: load the first one (byte-stable choice).
    loadedClient.push(deferredClient.shift()!);
    notes.push(`Every tool was deferred; ${loadedClient[0].name} was loaded so the request is valid.`);
  }
  const clientToolParam = (t: (typeof sortedClient)[number], deferred: boolean) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
    ...(t.strict ? { strict: true } : {}),
    // Streamed tool input arrives as generated; we validate it ourselves.
    ...(opts.stream ? { eager_input_streaming: true } : {}),
    ...(deferred ? { defer_loading: true } : {}),
  });
  for (const t of loadedClient) tools.push(clientToolParam(t, false));
  const lastLoadedIndex = tools.length - 1;
  for (const t of deferredClient) tools.push(clientToolParam(t, true));

  // cache (Phase 17 A1): a breakpoint on the last LOADED tool and one on the
  // last system block (render order is tools → system → messages, so the
  // tool entry survives a system-prompt change and the system entry covers
  // both). Both carry the request's TTL.
  if (req.cache) {
    if (loadedClient.length > 0) {
      tools[lastLoadedIndex].cache_control = cacheControl(ttl);
      count.breakpoints++;
    }
    if (system.length > 0) {
      const last = system[system.length - 1];
      if (!last.cache_control) {
        last.cache_control = cacheControl(ttl);
        count.breakpoints++;
      }
    }
  }
  const clientTools = sortedClient;

  // Messages. Empty messages (everything dropped) are skipped; consecutive
  // same-role turns are merged by the API.
  const messages: Anthropic.Messages.MessageParam[] = [];
  for (const m of req.messages) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    const content = toAnthropicContent(m.content, notes, count);
    if (content.length > 0) messages.push({ role: m.role, content });
  }

  if (req.cacheConversation) count.breakpoints++;
  if (count.breakpoints > MAX_CACHE_BREAKPOINTS) {
    throw new LlmProviderError({
      provider: "anthropic",
      kind: "client",
      detail: `${count.breakpoints} cache breakpoints requested; the API allows ${MAX_CACHE_BREAKPOINTS}`,
    });
  }

  const params: Record<string, unknown> = { model, max_tokens: req.maxTokens, messages };
  if (system.length > 0) params.system = system;
  if (tools.length > 0) params.tools = tools;
  // The conversation tail stays on the 5-minute TTL (steps are seconds
  // apart); a 1h explicit marker before a 5m automatic tail is the
  // documented order (prompt-caching.md § Automatic vs explicit).
  if (req.cacheConversation) params.cache_control = EPHEMERAL;
  // Phase 17 (A4): SDK MessageCreateParams.service_tier: 'auto' | 'standard_only'.
  if (req.serviceTier) params.service_tier = req.serviceTier;

  // tool_choice — never forced where the model rejects it.
  if (req.toolChoice && (clientTools.length > 0 || serverToolsSent.length > 0)) {
    const tc = req.toolChoice;
    if (tc === "auto") params.tool_choice = { type: "auto" };
    else if (tc === "none") params.tool_choice = { type: "none" };
    else if (caps.forcedToolChoice) {
      params.tool_choice = tc === "any" ? { type: "any" } : { type: "tool", name: tc.name };
    } else {
      notes.push(`Forced tool choice is rejected by ${model}; sent as auto — name the tool in the prompt instead.`);
    }
  }

  // Effort.
  const effort = req.effort ?? opts.defaultEffort ?? undefined;
  if (effort) {
    if (caps.effort) params.output_config = { effort };
    else notes.push(`Effort is not supported on ${model}; "${effort}" was not sent.`);
  }

  // Thinking.
  if (req.thinking === "adaptive") {
    if (caps.adaptiveThinking) params.thinking = { type: "adaptive" };
    else notes.push(`Adaptive thinking is not supported on ${model}; not sent.`);
  } else if (req.thinking === "off") {
    const atMax = effort === "max";
    switch (caps.thinkingOff) {
      case "impossible":
        notes.push(`Thinking cannot be turned off on ${model}; lower the effort to reduce it.`);
        break;
      case "between_tools":
        // SDK 0.128.0 types lag this documented value (Sonnet 5.5 only).
        if (atMax) notes.push(`Thinking can be turned off on ${model} only at effort high or below; left on.`);
        else params.thinking = { type: "between_tools" };
        break;
      case "disabled":
        if (atMax) notes.push(`Thinking can be turned off on ${model} only at effort high or below; left on.`);
        else params.thinking = { type: "disabled" };
        break;
      case "omit":
        break; // already off by default
    }
  }

  // Context editing (Phase 17 A3) + compaction (Phase 8): both ride on
  // context_management.edits over the beta endpoint. Shapes from the SDK:
  // BetaClearToolUses20250919Edit { trigger: BetaInputTokensTrigger, keep:
  // BetaToolUsesKeep, clear_at_least: BetaInputTokensClearAtLeast,
  // exclude_tools } and BetaCompact20260112Edit.
  const betas: string[] = [];
  const edits: Array<Record<string, unknown>> = [];
  let contextEditing = false;
  if (req.contextEditing) {
    if (caps.contextEditing && opts.betaAvailable !== false) {
      const ce = req.contextEditing;
      const edit: Record<string, unknown> = {
        type: CLEAR_TOOL_USES_EDIT,
        trigger: { type: "input_tokens", value: ce.triggerInputTokens ?? CONTEXT_EDITING_DEFAULTS.triggerInputTokens },
        keep: { type: "tool_uses", value: ce.keepToolUses ?? CONTEXT_EDITING_DEFAULTS.keepToolUses },
      };
      if (ce.clearAtLeastTokens) edit.clear_at_least = { type: "input_tokens", value: ce.clearAtLeastTokens };
      if (ce.excludeTools?.length) edit.exclude_tools = [...ce.excludeTools];
      edits.push(edit);
      betas.push(CONTEXT_EDITING_BETA);
      contextEditing = true;
    } else {
      notes.push(`Server-side context editing is not available on ${model}; not sent.`);
    }
  }
  let compaction = false;
  if (req.compaction) {
    if (caps.compaction && opts.betaAvailable !== false) {
      betas.push(COMPACTION_BETA);
      edits.push({ type: COMPACTION_EDIT });
      compaction = true;
    } else {
      notes.push(`Server-side compaction is not available on ${model}; not sent.`);
    }
  }
  if (betas.length > 0) {
    params.betas = betas;
    params.context_management = { edits };
  }

  return {
    params: params as unknown as Anthropic.Messages.MessageCreateParamsNonStreaming,
    notes,
    serverToolsSent,
    compaction,
    beta: betas.length > 0,
    toolSearch,
    contextEditing,
    effort: effort && caps.effort ? effort : null,
  };
}

// ── response mapping ────────────────────────────────────────────────────────

export function mapAnthropicStopReason(r: string | null | undefined): ChatStopReason {
  switch (r) {
    case "end_turn":
    case "tool_use":
    case "max_tokens":
    case "refusal":
    case "pause_turn":
    case "stop_sequence":
      return r;
    case "model_context_window_exceeded":
      return "context_window_exceeded";
    default:
      return "other";
  }
}

function mapUsage(u: Anthropic.Messages.Usage | null | undefined): ChatUsage {
  // SDK Usage.cache_creation: { ephemeral_1h_input_tokens, ephemeral_5m_input_tokens }.
  const oneHour = u?.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
    ...(oneHour > 0 ? { cacheWrite1hTokens: oneHour } : {}),
  };
}

/** Phase 17 (A3): the response's context_management.applied_edits (beta), as plain data. */
function mapContextEdits(msg: Anthropic.Messages.Message): ChatResponseMeta["contextEdits"] {
  const cm = (msg as unknown as { context_management?: { applied_edits?: unknown } | null }).context_management;
  if (!cm || !Array.isArray(cm.applied_edits)) return undefined;
  const out: NonNullable<ChatResponseMeta["contextEdits"]> = [];
  for (const e of cm.applied_edits as Array<Record<string, unknown>>) {
    if (!e || typeof e.type !== "string") continue;
    out.push({
      type: e.type,
      clearedInputTokens: typeof e.cleared_input_tokens === "number" ? e.cleared_input_tokens : 0,
      ...(typeof e.cleared_tool_uses === "number" ? { clearedToolUses: e.cleared_tool_uses } : {}),
    });
  }
  return out.length ? out : undefined;
}

/** Shallow plain copy (drops the SDK's non-enumerable stream bookkeeping). */
function plain(block: unknown): unknown {
  return block && typeof block === "object" ? { ...(block as Record<string, unknown>) } : block;
}

/**
 * Map a Messages API response to a ChatResponse. `toolJson` carries the raw
 * streamed input per content index (stream mode): it is strictly re-parsed
 * instead of trusting the SDK's tolerant parse.
 */
export function mapAnthropicMessage(
  msg: Anthropic.Messages.Message,
  ctx: {
    model: string;
    req: ChatRequest;
    notes: string[];
    serverToolsSent: ChatServerTool[];
    toolJson?: Map<number, string>;
    /** Phase 17: what the request carried / measured. */
    built?: Pick<BuiltAnthropicRequest, "compaction" | "toolSearch" | "contextEditing" | "effort">;
    timing?: { startedAt: number; firstDeltaAt: number | null; endedAt: number };
  },
): ChatResponse {
  const stopReason = mapAnthropicStopReason(msg.stop_reason);
  const content: ChatContentBlock[] = [];
  msg.content.forEach((block, i) => {
    switch (block.type) {
      case "text": {
        const cites = Array.isArray(block.citations) && block.citations.length > 0 ? block.citations : undefined;
        content.push({ type: "text", text: block.text, ...(cites ? { citations: cites } : {}) });
        break;
      }
      case "tool_use": {
        const rawJson = ctx.toolJson?.get(i);
        content.push(
          checkToolUse(
            { id: block.id, name: block.name, input: rawJson === undefined ? block.input : undefined, rawJson },
            ctx.req.tools,
            stopReason,
          ),
        );
        break;
      }
      case "thinking":
        content.push({ type: "opaque", provider: "anthropic", kind: "thinking", raw: plain(block), ...(block.thinking ? { text: block.thinking } : {}) });
        break;
      default:
        content.push({ type: "opaque", provider: "anthropic", kind: block.type, raw: plain(block) });
    }
  });
  const usage = mapUsage(msg.usage);
  const pricedModel = priceFor(ctx.model) ? ctx.model : msg.model;
  const sd = msg.stop_details;
  // SDK Usage.service_tier: 'standard' | 'priority' | 'batch' | null.
  const serviceTier = (msg.usage as { service_tier?: string | null } | null | undefined)?.service_tier ?? null;
  const meta: ChatResponseMeta = { serverToolsSent: ctx.serverToolsSent, notes: ctx.notes };
  if (ctx.built?.compaction) meta.compaction = "server";
  if (ctx.built?.toolSearch) meta.toolSearch = "server";
  const edits = mapContextEdits(msg);
  if (edits) meta.contextEdits = edits;
  const t = ctx.timing;
  return {
    id: msg.id ?? null,
    content,
    stopReason,
    stopDetails: sd ? { category: sd.category ?? null, explanation: sd.explanation ?? null } : null,
    truncated: stopReason === "max_tokens" || stopReason === "context_window_exceeded",
    usage,
    model: ctx.model,
    provider: "anthropic",
    costMicroUsd: estimateCostMicroUsd(pricedModel, usage, { serviceTier }),
    meta,
    ...(t ? { timing: { ttftMs: t.firstDeltaAt === null ? null : t.firstDeltaAt - t.startedAt, durationMs: t.endedAt - t.startedAt } } : {}),
    effort: ctx.built?.effort ?? null,
    serviceTier,
  };
}

// ── provider ────────────────────────────────────────────────────────────────

interface MessageStreamLike extends AsyncIterable<Anthropic.Messages.RawMessageStreamEvent> {
  finalMessage(): Promise<Anthropic.Messages.Message>;
  abort?(): void;
}

/**
 * Phase 17 (A4): the slice of the SDK's Message Batches resource the batch
 * path uses (client.messages.batches — SDK resources/messages/batches.d.ts:
 * create({ requests: [{ custom_id, params }] }), retrieve(id) →
 * processing_status 'in_progress' | 'canceling' | 'ended', results(id) →
 * JSONL of { custom_id, result: { type: 'succeeded', message } | errored |
 * canceled | expired }).
 */
export interface BatchesLike {
  create(params: { requests: Array<{ custom_id: string; params: Anthropic.Messages.MessageCreateParamsNonStreaming }> }): PromiseLike<{ id: string; processing_status: string }>;
  retrieve(id: string): PromiseLike<{ id: string; processing_status: string; request_counts?: Record<string, number> }>;
  results(id: string): PromiseLike<AsyncIterable<{ custom_id: string; result: { type: string; message?: Anthropic.Messages.Message; error?: unknown } }>>;
}

interface MessagesLike {
  create(
    params: Anthropic.Messages.MessageCreateParamsNonStreaming,
    options?: { signal?: AbortSignal },
  ): PromiseLike<Anthropic.Messages.Message>;
  stream(params: Anthropic.Messages.MessageStreamParams, options?: { signal?: AbortSignal }): MessageStreamLike;
  /** Phase 17 (A4): Message Batches (the real SDK client always has it). */
  batches?: BatchesLike;
}

/** The slice of the SDK client this adapter uses (a test seam). */
export interface AnthropicClientLike {
  messages: MessagesLike;
  /** Phase 8: beta endpoints (compaction). Same shapes; `betas` rides in params. */
  beta?: { messages: MessagesLike };
}

export interface AnthropicProviderOptions {
  /** Router workload (metering label). */
  workload?: string | null;
  /** Effort applied when a chat request names none (the workload's default). */
  defaultEffort?: ChatEffort | null;
  /** Test seam: a stubbed SDK client. */
  client?: AnthropicClientLike;
  /** Phase 15: whose key this is (metering). Default "platform". */
  keySource?: LlmKeySource;
}

export class AnthropicLlmProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly isLive = true;

  private readonly client: AnthropicClientLike;
  private readonly model: string;
  private readonly workload: string | null;
  private readonly defaultEffort: ChatEffort | null;
  /** Phase 15: "workspace" for a workspace's own key (0 credits). */
  readonly keySource: LlmKeySource;

  constructor(apiKey: string, model: string, options: AnthropicProviderOptions = {}) {
    // Key is passed to the SDK only; never stored in a loggable form.
    this.client =
      options.client ??
      (new Anthropic({
        apiKey,
        timeout: ANTHROPIC_TIMEOUT_MS,
        maxRetries: ANTHROPIC_MAX_RETRIES,
      }) as unknown as AnthropicClientLike);
    this.model = model;
    this.workload = options.workload ?? null;
    this.defaultEffort = options.defaultEffort ?? null;
    this.keySource = options.keySource ?? "platform";
  }

  isConfigured(): boolean {
    // The SDK holds the key; this provider exists only when a key was given.
    return true;
  }

  getModel(): string {
    return this.model;
  }

  getDefaultEffort(): ChatEffort | null {
    return this.defaultEffort;
  }

  /** Router workload (metering label). */
  getWorkload(): string | null {
    return this.workload;
  }

  // ── Phase 17 (A4): Message Batches ────────────────────────────────────────

  /** True when this client can send Message Batches (50% of standard prices). */
  supportsBatch(): boolean {
    return Boolean(this.client.messages.batches);
  }

  /**
   * Submit prompts as one Message Batch. Gated by the credit cap like any
   * call (assertModelSpendAllowed); never sent for a capped workspace.
   * The params are exactly generate()'s (no service_tier: a batch is its
   * own tier).
   */
  async submitBatch(
    requests: ReadonlyArray<{ customId: string; prompt: string; maxTokens: number }>,
    usage?: LlmGenerateOptions["usage"],
  ): Promise<{ providerBatchId: string; status: string }> {
    const batches = this.client.messages.batches;
    if (!batches) throw new LlmProviderError({ provider: this.name, kind: "client", detail: "this client has no Message Batches resource" });
    await assertModelSpendAllowed(usage, this.keySource, this.name);
    try {
      const b = await batches.create({
        requests: requests.map((r) => ({
          custom_id: r.customId,
          params: { model: this.model, max_tokens: r.maxTokens, messages: [{ role: "user", content: r.prompt }] },
        })),
      });
      return { providerBatchId: b.id, status: b.processing_status };
    } catch (err) {
      throw classifyAnthropicError(err);
    }
  }

  /** Poll a batch: ended once processing_status is "ended". */
  async batchStatus(providerBatchId: string): Promise<{ ended: boolean; status: string }> {
    const batches = this.client.messages.batches;
    if (!batches) throw new LlmProviderError({ provider: this.name, kind: "client", detail: "this client has no Message Batches resource" });
    try {
      const b = await batches.retrieve(providerBatchId);
      return { ended: b.processing_status === "ended", status: b.processing_status };
    } catch (err) {
      throw classifyAnthropicError(err);
    }
  }

  /**
   * An ended batch's results, one per request (any order — keyed by
   * customId). Each succeeded message's usage is recorded (llm_tokens, the
   * batch tier at 50%), idempotent per response id: a re-read after a worker
   * restart never charges twice.
   */
  async batchResults(
    providerBatchId: string,
    usage?: LlmGenerateOptions["usage"],
  ): Promise<Record<string, { text: string } | { error: string }>> {
    const batches = this.client.messages.batches;
    if (!batches) throw new LlmProviderError({ provider: this.name, kind: "client", detail: "this client has no Message Batches resource" });
    const out: Record<string, { text: string } | { error: string }> = {};
    let decoder: AsyncIterable<{ custom_id: string; result: { type: string; message?: Anthropic.Messages.Message; error?: unknown } }>;
    try {
      decoder = await batches.results(providerBatchId);
    } catch (err) {
      throw classifyAnthropicError(err);
    }
    for await (const line of decoder) {
      const r = line.result;
      if (r.type === "succeeded" && r.message) {
        const msg = r.message;
        const u = mapUsage(msg.usage);
        // Batch results report usage.service_tier "batch"; default to it.
        const serviceTier = (msg.usage as { service_tier?: string | null } | null)?.service_tier ?? "batch";
        if (usage) {
          await recordChatUsage({
            context: usage,
            workload: this.workload,
            provider: this.name,
            model: this.model,
            usage: u,
            costMicroUsd: estimateCostMicroUsd(priceFor(this.model) ? this.model : msg.model, u, { serviceTier }),
            responseId: msg.id ?? null,
            keySource: this.keySource,
            timing: null,
            effort: null,
            serviceTier,
          });
        }
        const text = msg.content
          .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("")
          .trim();
        out[line.custom_id] = text ? { text } : { error: `empty response (stop_reason ${msg.stop_reason ?? "unknown"})` };
      } else {
        const detail = r.type === "errored" ? `errored: ${JSON.stringify(r.error ?? {}).slice(0, 300)}` : r.type;
        out[line.custom_id] = { error: detail };
      }
    }
    return out;
  }

  /** Phase 17 (A2): tool search is server-side on the models the docs list. */
  supportsToolSearch(): boolean {
    return anthropicModelCaps(this.model).toolSearch;
  }

  async generate(prompt: string, opts?: LlmGenerateOptions): Promise<string> {
    const maxTokens = opts?.maxTokens ?? 4096;
    // Phase 15.2: a capped workspace is refused before anything is sent.
    await assertModelSpendAllowed(opts?.usage, this.keySource, this.name);
    let res: Anthropic.Messages.Message;
    const startedAt = Date.now();
    try {
      res = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
          // Phase 17 (A4): bulk / background / sub-agent work nobody waits
          // for never takes priority capacity (SDK service_tier: 'auto' |
          // 'standard_only'); copy (a person may be waiting on a draft) keeps
          // the API default.
          ...(NON_INTERACTIVE_WORKLOADS.has(this.workload ?? "") ? { service_tier: "standard_only" as const } : {}),
        },
        opts?.signal ? { signal: opts.signal } : undefined,
      );
    } catch (err) {
      // Phase 5: a stopped run surfaces as the abort, not a provider failure.
      if (opts?.signal?.aborted) throw opts.signal.reason ?? err;
      // Never include key material: provider, status and a sanitized cause.
      throw classifyAnthropicError(err);
    }
    // Phase 15.2: generate() is metered like chat() (tokens were spent even
    // when the text turns out empty, so record first).
    if (opts?.usage) {
      const usage = mapUsage(res.usage);
      const serviceTier = (res.usage as { service_tier?: string | null } | null)?.service_tier ?? null;
      await recordChatUsage({
        context: opts.usage,
        workload: this.workload,
        provider: this.name,
        model: this.model,
        usage,
        costMicroUsd: estimateCostMicroUsd(priceFor(this.model) ? this.model : res.model, usage, { serviceTier }),
        responseId: res.id ?? null,
        keySource: this.keySource,
        timing: { ttftMs: null, durationMs: Date.now() - startedAt },
        effort: null,
        serviceTier,
      });
    }

    const text = res.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) {
      throw new LlmProviderError({
        provider: "anthropic",
        kind: "empty",
        detail:
          res.stop_reason === "max_tokens"
            ? "empty response: the output-token cap was reached before any text — raise maxTokens"
            : res.stop_reason === "refusal"
              ? "the model declined this request (stop_reason: refusal)"
              : "LLM returned an empty response",
      });
    }
    return text;
  }

  private async record(req: ChatRequest, res: ChatResponse): Promise<void> {
    await recordChatUsage({
      context: req.usage,
      workload: this.workload,
      provider: this.name,
      model: this.model,
      usage: res.usage,
      costMicroUsd: res.costMicroUsd,
      responseId: res.id,
      keySource: this.keySource,
      timing: res.timing ?? null,
      effort: res.effort ?? null,
      serviceTier: res.serviceTier ?? null,
    });
  }

  /** The endpoint a built request goes to (beta when it carries betas: compaction / context editing). */
  private endpoint(built: BuiltAnthropicRequest): MessagesLike {
    return built.beta && this.client.beta ? this.client.beta.messages : this.client.messages;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    await assertModelSpendAllowed(req.usage, this.keySource, this.name);
    const built = buildAnthropicParams(this.model, req, {
      stream: false,
      defaultEffort: this.defaultEffort,
      betaAvailable: Boolean(this.client.beta),
    });
    let msg: Anthropic.Messages.Message;
    const startedAt = Date.now();
    try {
      msg = await this.endpoint(built).create(built.params, req.signal ? { signal: req.signal } : undefined);
    } catch (err) {
      if (req.signal?.aborted) throw req.signal.reason ?? err;
      throw classifyAnthropicError(err);
    }
    const res = mapAnthropicMessage(msg, {
      model: this.model,
      req,
      notes: built.notes,
      serverToolsSent: built.serverToolsSent,
      built,
      timing: { startedAt, firstDeltaAt: null, endedAt: Date.now() },
    });
    await this.record(req, res);
    return res;
  }

  async *chatStream(req: ChatRequest): AsyncGenerator<ChatStreamEvent> {
    await assertModelSpendAllowed(req.usage, this.keySource, this.name);
    const built = buildAnthropicParams(this.model, req, {
      stream: true,
      defaultEffort: this.defaultEffort,
      betaAvailable: Boolean(this.client.beta),
    });
    const toolJson = new Map<number, string>();
    const toolMeta = new Map<number, { id: string; name: string }>();
    let stream: MessageStreamLike | null = null;
    let msg: Anthropic.Messages.Message | null = null;
    const startedAt = Date.now();
    let firstDeltaAt: number | null = null;
    try {
      try {
        stream = this.endpoint(built).stream(
          built.params as unknown as Anthropic.Messages.MessageStreamParams,
          req.signal ? { signal: req.signal } : undefined,
        );
        for await (const ev of stream) {
          // Phase 17 (A1): time to the first content delta of any kind.
          if (firstDeltaAt === null && ev.type === "content_block_delta") firstDeltaAt = Date.now();
          if (ev.type === "content_block_start") {
            if (ev.content_block.type === "tool_use") {
              toolMeta.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name });
              toolJson.set(ev.index, "");
              yield { type: "tool_use_start", index: ev.index, id: ev.content_block.id, name: ev.content_block.name };
            }
          } else if (ev.type === "content_block_delta") {
            const d = ev.delta;
            if (d.type === "text_delta") yield { type: "text_delta", index: ev.index, text: d.text };
            else if (d.type === "thinking_delta") yield { type: "thinking_delta", index: ev.index, text: d.thinking };
            else if (d.type === "input_json_delta" && toolMeta.has(ev.index)) {
              toolJson.set(ev.index, (toolJson.get(ev.index) ?? "") + d.partial_json);
              yield { type: "tool_input_delta", index: ev.index, partialJson: d.partial_json };
            }
          } else if (ev.type === "content_block_stop") {
            const meta = toolMeta.get(ev.index);
            if (meta) {
              // Schema check now; the stop-reason check lands in `final`.
              const checked = checkToolUse({ ...meta, input: undefined, rawJson: toolJson.get(ev.index) ?? "" }, req.tools, null);
              yield {
                type: "tool_use_stop",
                index: ev.index,
                id: meta.id,
                name: meta.name,
                input: checked.input,
                ...(checked.invalid ? { invalid: checked.invalid } : {}),
              };
            }
          }
        }
        msg = await stream.finalMessage();
      } catch (err) {
        if (req.signal?.aborted) throw req.signal.reason ?? err;
        throw classifyAnthropicError(err);
      }
    } finally {
      // Consumer stopped early (or an error): release the HTTP stream.
      if (!msg) {
        try {
          stream?.abort?.();
        } catch {
          /* already closed */
        }
      }
    }
    const res = mapAnthropicMessage(msg, {
      model: this.model,
      req,
      notes: built.notes,
      serverToolsSent: built.serverToolsSent,
      toolJson,
      built,
      timing: { startedAt, firstDeltaAt, endedAt: Date.now() },
    });
    await this.record(req, res);
    yield { type: "message_stop", stopReason: res.stopReason, usage: res.usage };
    yield { type: "final", response: res };
  }
}
