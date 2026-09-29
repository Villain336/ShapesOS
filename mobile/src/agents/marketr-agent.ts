// Marketr mobile — the agent, wired to the SAME AG-UI backend as the web.
//
// Mirrors components/agents/MarketrAgentShell.tsx (Phase 16 slice 2): a
// locally-registered HttpAgent from @ag-ui/client whose custom `fetch`
// rewrites the AG-UI RunAgentInput into the Slice 1 route's body shape
// { threadId, content, state? } (see ./api/agui-bridge.ts). No
// @copilotkit/runtime, no separate mobile agent logic — one agent, every
// frontend.
//
// The only mobile-specific deltas vs the web shell:
//   - base URL is explicit (config.ts), not relative
//   - the session cookie is attached manually (React Native has no cookie
//     jar; see src/auth/session.ts)

import { HttpAgent } from "@ag-ui/client";
import {
  buildAguiChatBody,
  ensureChatThread,
  throwIfAguiChatError,
  type AuthedFetch,
} from "../api/agui-bridge";

/** Agent id — matches the web shell's MARKETR_AGENT_ID. */
export const MARKETR_AGENT_ID = "marketr-agent";

export interface CreateMarketrAgentOptions extends AuthedFetch {
  /** Existing Marketr aiChatThread id; null = resolved lazily on first send. */
  threadId?: string | null;
  /** Project used when a thread must be created; null = workspace's first project. */
  projectId?: string | null;
}

export function createMarketrAgent({
  baseUrl,
  authHeaders,
  threadId = null,
  projectId = null,
}: CreateMarketrAgentOptions): HttpAgent {
  let resolvedThreadId: string | null = threadId;
  const authed: AuthedFetch = { baseUrl, authHeaders };

  return new HttpAgent({
    url: `${baseUrl}/api/agents/chat`,
    // The provider-level headers carry the session cookie; the custom fetch
    // below re-applies them on the rewritten request.
    headers: { ...authHeaders() },
    fetch: async (_url, requestInit) => {
      if (!resolvedThreadId) {
        resolvedThreadId = await ensureChatThread(authed, projectId);
      }
      const tid = resolvedThreadId;
      if (!tid) throw new Error("marketr: no chat thread available for this workspace");
      let messages: unknown[] | undefined;
      let state: Record<string, unknown> | undefined;
      try {
        const parsed = JSON.parse(String(requestInit.body ?? "{}")) as {
          messages?: unknown[];
          state?: Record<string, unknown>;
        };
        messages = parsed.messages;
        // CoAgents shared state (UI→agent) rides with the run, exactly as on web.
        state = parsed.state;
      } catch {
        messages = undefined;
      }
      const body = buildAguiChatBody(tid, messages, state);
      const res = await fetch(`${baseUrl}/api/agents/chat`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal: requestInit.signal ?? undefined,
      });
      return throwIfAguiChatError(res);
    },
  });
}
