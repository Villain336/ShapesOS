// Marketr — swappable LLM provider interface.
// The content engine and (later) the fix agent depend ONLY on these types
// + getLlmProvider(). The default is an OpenAI-compatible chat-completions
// endpoint (LLM_BASE_URL), so OpenAI, Anthropic-via-proxy, Ollama, etc.
// work without touching callers. MockLlmProvider fills in when no key is set.

export interface LlmProvider {
  /** Stable provider key, e.g. "openai-compatible" | "mock". */
  readonly name: string;
  /** True only when backed by a real LLM API. */
  readonly isLive: boolean;
  /** Whether the provider has everything it needs to serve real completions. */
  isConfigured(): boolean;
  /** Generate a completion for a full prompt. */
  generate(prompt: string): Promise<string>;
}
