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
}

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

export type ChatContentBlock = ChatTextBlock | ChatToolUseBlock | ChatToolResultBlock | ChatOpaqueBlock;

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
}

export interface ChatSystemBlock {
  text: string;
  /** Put a cache breakpoint after this block. */
  cache?: boolean;
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
}

export interface ChatRequest {
  system?: string | ChatSystemBlock[];
  messages: ChatMessage[];
  tools?: ChatToolDef[];
  maxTokens: number;
  /** Defaults to the workload's effort (router), else the model's default. */
  effort?: ChatEffort;
  thinking?: ChatThinking;
  /** Cache the system prompt and the tool list (one breakpoint covers both). */
  cache?: boolean;
  /** Also cache the growing conversation tail (Anthropic automatic caching). */
  cacheConversation?: boolean;
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
  cacheWriteTokens: number;
}

export interface ChatResponseMeta {
  /** Server tools actually sent with the request. */
  serverToolsSent: ChatServerTool[];
  /** Request features that were adjusted or not applied, in plain words. */
  notes: string[];
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
}
