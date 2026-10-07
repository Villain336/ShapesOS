// Marketr — swappable LLM provider interface.
// The content engine and (later) the fix agent depend ONLY on these types
// + getLlmProvider(). The default is an OpenAI-compatible chat-completions
// endpoint (LLM_BASE_URL), so OpenAI, Anthropic-via-proxy, Ollama, etc.
// work without touching callers. MockLlmProvider fills in when no key is set.
//
// Phase 7 adds the agent-grade API next to generate(): chat() takes a system
// prompt, a transcript of content blocks and native tool definitions, and
// returns content blocks with a stop reason and token usage; chatStream()
// yields the same response as typed events. generate() stays for every
// existing caller. The shapes are provider-neutral: the Anthropic adapter
// maps them to the Messages API, the OpenAI adapter to the Responses API.

export interface LlmGenerateOptions {
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * Phase 15.2: metering context. With it, generate() is gated by the
   * workspace's credit cap before the call and its token usage is recorded
   * (and charged) like chat(). Without it nothing is metered.
   */
  usage?: ChatUsageContext;
}

/**
 * Phase 15: whose key a live provider holds. "platform" = ShapesOS's env key
 * (charged in credits); "workspace" = the workspace's own key (BYOK, 0
 * credits); "self_host" = a local OpenAI-compatible model (0 credits).
 */
export type LlmKeySource = "platform" | "workspace" | "self_host";

// ── chat(): request ─────────────────────────────────────────────────────────

/** Reasoning depth. Anthropic: output_config.effort; OpenAI: reasoning.effort. */
export type ChatEffort = "low" | "medium" | "high" | "max";

/** "adaptive" asks for model-decided thinking; "off" asks for none where the
 *  model allows it (some models cannot turn thinking off — the response's
 *  meta.notes says so instead of failing the call). */
export type ChatThinking = "adaptive" | "off";

/** Provider-run tools. Anthropic only; other providers report them as not sent. */
export type ChatServerTool = "web_search" | "web_fetch";

export interface ChatTextBlock {
  type: "text";
  text: string;
  /** Request side: put a cache breakpoint after this block (Anthropic). */
  cache?: boolean;
  /** Response side: provider citations (web search), passed through as data. */
  citations?: unknown[];
}

export interface ChatToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * Response side: set when the input must NOT be run — it failed its
   * tool's JSON schema, was not parseable JSON, or the turn was cut off
   * (max_tokens / refusal). Answer it with invalidToolResult(block).
   */
  invalid?: string;
}

export interface ChatToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string | ChatTextBlock[];
  isError?: boolean;
}

/**
 * A provider-native block that must be echoed back verbatim on the next turn
 * (Anthropic thinking / redacted_thinking with signatures, server_tool_use,
 * web_search_tool_result, web_fetch_tool_result …). Sent back only to the
 * provider that produced it; another provider drops it (meta.notes says so).
 */
export interface ChatOpaqueBlock {
  type: "opaque";
  provider: string;
  /** The native block type, e.g. "thinking", "server_tool_use". */
  kind: string;
  raw: unknown;
  /** Human-readable text when the block has some (e.g. summarized thinking). */
  text?: string;
}

/**
 * Phase 19A (WS=server): an image in a USER turn (request side only) — the
 * agentic cursor's screenshots. Base64 bytes, sent to the provider for this
 * one call: callers must never persist a message that carries one (the
 * cursor keeps its transcript in memory and stores only a text summary).
 * Anthropic: an `image` block with a base64 source; OpenAI Responses: an
 * `input_image` data URL. A provider without vision drops it and says so in
 * meta.notes.
 */
export interface ChatImageBlock {
  type: "image";
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  /** Base64 (no data: prefix). */
  data: string;
}

export type ChatContentBlock = ChatTextBlock | ChatToolUseBlock | ChatToolResultBlock | ChatOpaqueBlock | ChatImageBlock;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string | ChatContentBlock[];
}

/** JSON Schema for a tool's input (an object schema). */
export interface ChatJsonSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

export interface ChatToolDef {
  name: string;
  /** Say WHEN to call it, not only what it does. */
  description: string;
  inputSchema: ChatJsonSchema;
  /** Anthropic strict tool use (schema must set additionalProperties: false). */
  strict?: boolean;
  /**
   * Phase 17 (A2): not loaded into the model's context up front — the model
   * finds it with tool search (Anthropic `defer_loading`, server-side). A
   * provider without tool search gets the tool through the loop's client-side
   * search_tools fallback instead (lib/agents/loop.ts), never silently
   * dropped.
   */
  deferLoading?: boolean;
}

/** Phase 17: prompt-cache time-to-live (Anthropic cache_control.ttl). */
export type ChatCacheTtl = "5m" | "1h";

export interface ChatSystemBlock {
  text: string;
  /** Put a cache breakpoint after this block. */
  cache?: boolean;
}

/**
 * Phase 17 (A3): server-side context editing — the provider clears old
 * tool results itself once the input passes `triggerInputTokens`, keeping
 * the last `keepToolUses` (Anthropic clear_tool_uses_20250919, beta
 * context-management-2025-06-27). Where it is not offered, nothing is sent
 * and meta.notes says so.
 */
export interface ChatContextEditing {
  /** Input tokens of one call above which old tool results are cleared (default 100000). */
  triggerInputTokens?: number;
  /** Most recent tool uses whose results are kept (default 3). */
  keepToolUses?: number;
  /** Only clear when at least this many tokens go (the cache write must be worth it). */
  clearAtLeastTokens?: number;
  /** Tool names whose results are never cleared. */
  excludeTools?: string[];
}

/** Phase 17 (A1): wall-clock of one model call, measured by the adapter. */
export interface ChatTiming {
  /** Time to the first streamed content delta (null on a non-streaming call). */
  ttftMs: number | null;
  /** Request start → final message. */
  durationMs: number;
}

/**
 * Where a call's usage is recorded (lib/llm/usage.ts → lib/metering). Without
 * it nothing is metered (and nothing can be: metering is per workspace).
 */
export interface ChatUsageContext {
  workspaceId: string;
  projectId?: string | null;
  /** Null = system / scheduler actor. */
  actorId?: string | null;
  /** AgentRun id: also appends a `usage` event (tokens + estimated cost) to the run. */
  runId?: string | null;
  agentKey?: string | null;
  /**
   * Phase 15.2: "tokens" (default) charges the call at 1.5× its provider
   * cost; "included" records it at 0 credits because a value-priced action
   * (ai_article, content_brief, …) already charges for the work.
   */
  billing?: "tokens" | "included";
}

export interface ChatRequest {
  system?: string | ChatSystemBlock[];
  messages: ChatMessage[];
  tools?: ChatToolDef[];
  maxTokens: number;
  /** Defaults to the workload's effort (router), else the model's default. */
  effort?: ChatEffort;
  thinking?: ChatThinking;
  /**
   * Cache the static prefix: a breakpoint on the last loaded tool AND on the
   * last system block (Phase 17 A1 — the tools survive a system-prompt
   * change; the API renders tools → system → messages).
   */
  cache?: boolean;
  /**
   * Phase 17 (A1): how long the static prefix stays cached. "1h" for chat
   * (people pause longer than 5 minutes; cache writes then cost 2× input
   * instead of 1.25×), "5m" (default) for sub-agents and background work.
   */
  cacheTtl?: ChatCacheTtl;
  /** Also cache the growing conversation tail (Anthropic automatic caching). */
  cacheConversation?: boolean;
  /**
   * Phase 17 (A2): offer tool search so tools marked deferLoading are found
   * on demand (Anthropic tool_search_tool_bm25_20251119). Ignored by
   * providers without it (the loop falls back to client-side search).
   */
  toolSearch?: boolean;
  /** Phase 17 (A3): server-side clearing of old tool results. */
  contextEditing?: ChatContextEditing;
  /**
   * Phase 17 (A4): Anthropic service_tier. "standard_only" keeps background
   * work off any priority capacity the org pays for; "auto" (the API default)
   * for people waiting. (Batch work goes through lib/llm/batch.ts instead.)
   */
  serviceTier?: "auto" | "standard_only";
  serverTools?: ChatServerTool[];
  /**
   * "auto" (default) | "none" | forced. Forced tool choice is NEVER sent to a
   * model that rejects it (Claude 5.5 / Fable 5.1 return 400): it is sent as
   * "auto" and meta.notes says so.
   */
  toolChoice?: "auto" | "none" | "any" | { name: string };
  signal?: AbortSignal;
  /** Metering context; see ChatUsageContext. */
  usage?: ChatUsageContext;
  /**
   * Phase 8: ask for server-side context compaction where the model offers it
   * (Anthropic compaction beta). Where it is not offered nothing is sent and
   * meta.compaction stays unset — the caller compacts client-side instead.
   */
  compaction?: boolean;
}

// ── chat(): response ────────────────────────────────────────────────────────

export type ChatStopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "refusal"
  | "pause_turn"
  | "stop_sequence"
  | "context_window_exceeded"
  | "other";

export interface ChatUsage {
  /** Uncached input tokens (full price). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Every cache write (5-minute and 1-hour entries together). */
  cacheWriteTokens: number;
  /** Phase 17: the part of cacheWriteTokens that created 1-hour entries (billed 2× input, not 1.25×). */
  cacheWrite1hTokens?: number;
}

export interface ChatResponseMeta {
  /** Server tools actually sent with the request. */
  serverToolsSent: ChatServerTool[];
  /** Request features that were adjusted or not applied, in plain words. */
  notes: string[];
  /** Phase 8: "server" when the provider compacts the context itself. */
  compaction?: "server";
  /** Phase 17 (A2): "server" when deferred tools were offered through the provider's tool search. */
  toolSearch?: "server";
  /** Phase 17 (A3): what server-side context editing cleared on this call. */
  contextEdits?: Array<{ type: string; clearedInputTokens: number; clearedToolUses?: number }>;
}

export interface ChatResponse {
  /** Provider message / response id (null for mock). */
  id: string | null;
  content: ChatContentBlock[];
  stopReason: ChatStopReason;
  /** Refusal detail when the provider gives one. */
  stopDetails: { category: string | null; explanation: string | null } | null;
  /** True when the output was cut off (max_tokens / context window): never silent. */
  truncated: boolean;
  usage: ChatUsage;
  model: string;
  provider: string;
  /** Estimated cost in micro-USD (lib/llm/pricing.ts); null when a price is unknown. */
  costMicroUsd: number | null;
  meta: ChatResponseMeta;
  /** Phase 17 (A1): measured by the adapter (recorded on the usage event). */
  timing?: ChatTiming;
  /** Phase 17: the effort actually sent (null = the model's default). */
  effort?: ChatEffort | null;
  /** Phase 17 (A4): the service tier the provider reports ("standard" | "priority" | "batch"). */
  serviceTier?: string | null;
}

// ── chatStream(): events ────────────────────────────────────────────────────

export type ChatStreamEvent =
  | { type: "text_delta"; index: number; text: string }
  | { type: "thinking_delta"; index: number; text: string }
  | { type: "tool_use_start"; index: number; id: string; name: string }
  | { type: "tool_input_delta"; index: number; partialJson: string }
  | {
      type: "tool_use_stop";
      index: number;
      id: string;
      name: string;
      input: Record<string, unknown>;
      /** Set when the input must not be run (see ChatToolUseBlock.invalid). */
      invalid?: string;
    }
  | { type: "message_stop"; stopReason: ChatStopReason; usage: ChatUsage }
  /** Always the last event: the complete response (same shape as chat()). */
  | { type: "final"; response: ChatResponse };

// ── provider ────────────────────────────────────────────────────────────────

export interface LlmProvider {
  /** Stable provider key, e.g. "openai-compatible" | "mock". */
  readonly name: string;
  /** True only when backed by a real LLM API. */
  readonly isLive: boolean;
  /** Whether the provider has everything it needs to serve real completions. */
  isConfigured(): boolean;
  /**
   * Generate a completion for a full prompt.
   * opts.maxTokens caps output tokens (cost-blowout guard, T4). Adapters
   * apply their own default when omitted; the router publishes suggested
   * ceilings per workload (WORKLOAD_MAX_TOKENS).
   * opts.signal (Phase 5) aborts an in-flight request when a run is stopped.
   */
  generate(prompt: string, opts?: LlmGenerateOptions): Promise<string>;
  /**
   * Phase 7: one model turn with native tools. Throws LlmProviderError on
   * provider failure (same classification as generate()); a refusal or a
   * max_tokens cut-off is NOT an error — it is the response's stopReason.
   */
  chat(req: ChatRequest): Promise<ChatResponse>;
  /** Phase 7: chat() as a stream of typed events; the last event is `final`. */
  chatStream(req: ChatRequest): AsyncIterable<ChatStreamEvent>;
  /**
   * Phase 17 (A2): true when this provider (for its model) runs tool search
   * itself, so ChatToolDef.deferLoading is honoured server-side. Absent or
   * false → the agent loop offers deferred tools through its own
   * search_tools tool instead.
   */
  supportsToolSearch?(): boolean;
}
