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

/** Agent id the shell registers under the CopilotKit provider. */
const MARKETR_AGENT_ID = "marketr-agent";

/** react-ui chat labels (header title, input placeholder, initial message). */
const CHAT_LABELS = {
  title: "Marketr Agent",
  placeholder: "Ask the Marketr agent…",
  initial: "How can the Marketr agent help?",
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
          if (!tid) throw new Error("Marketr agent: no chat thread available for this workspace");
          let messages: unknown[] | undefined;
          try {
            messages = (JSON.parse(String(requestInit.body ?? "{}")) as { messages?: unknown[] }).messages;
          } catch {
            messages = undefined;
          }
          const body = buildAguiChatBody(tid, messages);
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
          <CopilotSidebar defaultOpen={false} labels={CHAT_LABELS} />
        ) : (
          <CopilotChat labels={CHAT_LABELS} />
        )}
      </CopilotKit>
    </div>
  );
}
