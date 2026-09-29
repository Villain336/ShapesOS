// Marketr mobile — AG-UI → /api/agents/chat bridge (pure logic, no React).
//
// Direct port of the web shell's components/agents/agui-bridge.ts (Phase 16
// slice 2). The Slice 1 route (app/api/agents/chat/route.ts) takes
// { threadId, content, state? } and streams AG-UI SSE events; CopilotKit's
// HttpAgent (from @ag-ui/client) instead POSTs a RunAgentInput
// { threadId, runId, messages, … }. This module translates between the two so
// a locally-registered HttpAgent can drive the backend without
// @copilotkit/runtime — the same bridge the web shell uses, parameterized by
// base URL + auth headers instead of the browser's ambient cookies.
//
// Pure on purpose: every function here is unit-testable without a device.

/** Maximum user content forwarded to the agent (matches the route's cap). */
export const MAX_BRIDGE_CONTENT = 4000;

/** Extract plain text from an AG-UI message content field (string or parts). */
export function aguiMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          // AG-UI content parts: { type: "text", text: "…" } / { type: "binary", … }
          if (typeof p.text === "string") return p.text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

/** Text of the newest user message in a RunAgentInput message list. */
export function lastUserText(messages: readonly unknown[] | undefined): string {
  if (!messages) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown } | null | undefined;
    if (m && typeof m === "object" && m.role === "user") {
      return aguiMessageText(m.content);
    }
  }
  return "";
}

/** Build the POST /api/agents/chat body from a resolved thread id + input messages. */
export function buildAguiChatBody(
  threadId: string,
  messages: readonly unknown[] | undefined,
  /** CoAgents state the UI carries into the run (agent.setState writes). */
  state?: Record<string, unknown>,
): { threadId: string; content: string; state?: Record<string, unknown> } {
  const content = lastUserText(messages).slice(0, MAX_BRIDGE_CONTENT);
  if (!content.trim()) throw new Error("marketr: no user message to send");
  return state && Object.keys(state).length > 0 ? { threadId, content, state } : { threadId, content };
}

/**
 * Surface HTTP errors from /api/agents/chat as thrown Errors (auth, missing
 * thread, bad body) instead of letting the SSE parser choke on a JSON error
 * payload. Returns the response untouched when ok.
 */
export async function throwIfAguiChatError(res: Response): Promise<Response> {
  if (res.ok) return res;
  let detail = "unknown error";
  try {
    const body = (await res.json()) as { error?: string };
    if (body && typeof body.error === "string" && body.error) detail = body.error;
  } catch {
    // Non-JSON error body — keep the generic detail.
  }
  throw new Error(`marketr: /api/agents/chat failed (${res.status}): ${detail}`);
}

export interface AuthedFetch {
  baseUrl: string;
  authHeaders: () => Record<string, string>;
}

/**
 * Resolve (and cache upstream) a Marketr aiChatThread id for the shell.
 * Mirrors the web bridge: uses `projectId` when given, otherwise picks the
 * workspace's first project via GET /api/projects, then POST /api/chat/threads.
 * Returns null when no usable project exists.
 */
export async function ensureChatThread(
  { baseUrl, authHeaders }: AuthedFetch,
  projectId: string | null,
): Promise<string | null> {
  const headers = { ...authHeaders(), "content-type": "application/json" };
  let pid = projectId;
  if (!pid) {
    try {
      const r = await fetch(`${baseUrl}/api/projects`, { headers });
      if (!r.ok) return null;
      const j = (await r.json()) as { projects?: Array<{ id: string }> };
      pid = j?.projects?.[0]?.id ?? null;
    } catch {
      return null;
    }
  }
  if (!pid) return null;
  try {
    const r = await fetch(`${baseUrl}/api/chat/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId: pid }),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { thread?: { id: string } };
    return j?.thread?.id ?? null;
  } catch {
    return null;
  }
}
