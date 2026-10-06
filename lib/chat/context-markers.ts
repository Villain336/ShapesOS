// The markers around the per-turn workspace context block (Phase 17, A1):
// the runtime puts it in the first user message so the system prompt stays
// byte-stable for the prompt cache. Shared by the prompt builder
// (lib/chat/agent.ts) and the answer cache (lib/chat/answer-cache.ts), which
// must tell the context apart from the user's question.
export const CONTEXT_OPEN = "<workspace-context>";
export const CONTEXT_CLOSE = "</workspace-context>";
