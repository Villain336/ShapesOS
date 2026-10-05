// Marketr — Phase 16 slice 2: CopilotKit chat shell.
//
// SHELL ONLY (per Tico's locked decision (a)): no generative components
// (slice 3), no CoAgents shared state (slice 4). The shell is a CopilotKit
// sidebar / inline chat whose agent is a locally-registered @ag-ui/client
// HttpAgent bridged to the Slice 1 backend (POST /api/agents/chat →
// AG-UI SSE events) via components/agents/agui-bridge.ts — no
// @copilotkit/runtime required.
//
// Theming: scoped overrides in ./copilot-shell.css map CopilotKit's CSS
// variables onto Marketr's --brand-* vars. Never CopilotKit default chrome.

"use client";

import { useEffect, useMemo, useRef } from "react";
import { CopilotKit } from "@copilotkit/react-core";
import { CopilotSidebar, CopilotChat } from "@copilotkit/react-ui";
import { HttpAgent } from "@ag-ui/client";
import "@copilotkit/react-ui/styles.css";
import "./copilot-shell.css";
import { buildAguiChatBody, ensureChatThread, throwIfAguiChatError } from "./agui-bridge";
import { GenerativeComponentHost } from "@/lib/agents/components/use-generative-components";
import { SharedStateDock, SharedStatePanel } from "./shared-state/widgets";

/** Agent id the shell registers under the CopilotKit provider. */
export const MARKETR_AGENT_ID = "marketr-agent";

/** react-ui chat labels (header title, input placeholder, initial message). */
const CHAT_LABELS = {
  title: "ShapesOS Agent",
  placeholder: "Ask the ShapesOS agent…",
  initial: "How can the ShapesOS agent help?",
};

export interface MarketrAgentShellProps {
  /** "sidebar" = floating toggle + slide-over; "inline" = embedded chat panel. */
  variant: "sidebar" | "inline";
  /** Existing Marketr aiChatThread id; null = created lazily on first send. */
  threadId?: string | null;
  /** Project used when a thread must be created; null = workspace's first project. */
  projectId?: string | null;
  /** CopilotKit-local thread key (scopes the shell's own message store). */
  copilotThreadId?: string;
}

export function MarketrAgentShell({
  variant,
  threadId = null,
  projectId = null,
  copilotThreadId,
}: MarketrAgentShellProps) {
  // Resolved Marketr thread id, cached across sends. When the caller hands us
  // a thread (assistant surface) we follow prop changes; otherwise the first
  // send creates one and it sticks for the mount lifetime.
  const threadRef = useRef<string | null>(threadId);
  useEffect(() => {
    if (threadId) threadRef.current = threadId;
  }, [threadId]);

  const agent = useMemo(
    () =>
      new HttpAgent({
        url: "/api/agents/chat",
        fetch: async (_url, requestInit) => {
          if (!threadRef.current) {
            threadRef.current = await ensureChatThread(projectId);
          }
          const tid = threadRef.current;
          if (!tid) throw new Error("ShapesOS agent: no chat thread available for this workspace");
          let messages: unknown[] | undefined;
          let state: Record<string, unknown> | undefined;
          try {
            const parsed = JSON.parse(String(requestInit.body ?? "{}")) as {
              messages?: unknown[];
              state?: Record<string, unknown>;
            };
            messages = parsed.messages;
            // Phase 16 slice 4: forward the CoAgents UI state (UI→agent)
            // with the run — the backend diffs/applies it in the adapter.
            state = parsed.state;
          } catch {
            messages = undefined;
          }
          const body = buildAguiChatBody(tid, messages, state);
          const res = await fetch("/api/agents/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: requestInit.signal ?? undefined,
          });
          return throwIfAguiChatError(res);
        },
      }),
    [projectId],
  );

  return (
    <div className="marketr-copilot-shell" data-testid="marketr-copilot-shell">
      <CopilotKit
        selfManagedAgents={{ [MARKETR_AGENT_ID]: agent }}
        // v1 `agent` prop names the agent for the chat config (the v1 bridge
        // defaults it to "default", which would shadow the v2 agentId).
        agent={MARKETR_AGENT_ID}
        agentId={MARKETR_AGENT_ID}
        // v1 `threadId` scopes this shell's own message store (react-ui chat
        // components do not take threadId directly).
        threadId={copilotThreadId ?? "marketr-agent"}
        enableInspector={false}
        onError={(event) => {
          // Provider-level surface: the chat also renders run errors inline.
          console.error(`[marketr-agent] ${event.type}:`, event.error);
        }}
      >
        {variant === "sidebar" ? (
          <>
            <CopilotSidebar defaultOpen={false} labels={CHAT_LABELS} />
            {/* Phase 16 slice 4: shared-state dock (mission / approvals /
                calendar) for the sidebar agent surface. */}
            <SharedStateDock />
          </>
        ) : (
          <div className="flex flex-col gap-2">
            {/* Phase 16 slice 4: shared-state panel above the inline chat. */}
            <SharedStatePanel />
            <CopilotChat labels={CHAT_LABELS} />
          </div>
        )}
        {/* Phase 16 slice 3: allowlisted generative components (approval card
            first, per locked decision (a)) register for the agent to emit. */}
        <GenerativeComponentHost />
      </CopilotKit>
    </div>
  );
}
