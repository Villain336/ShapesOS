// Marketr — Phase 16 slice 2: CopilotKit shell for the assistant surface.
//
// Binds the shared MarketrAgentShell to the assistant's live session: the
// active aiChatThread id (so the AG-UI run lands on the same thread the
// user is looking at) and the project id (so a first send without a thread
// creates one on the current project instead of guessing).

"use client";

import { useChat } from "@/components/chat/ChatContext";
import { MarketrAgentShell } from "./MarketrAgentShell";

export function AssistantAgentShell() {
  const { session, activeId } = useChat();
  return (
    <MarketrAgentShell
      variant="sidebar"
      threadId={activeId}
      projectId={session?.projectId ?? null}
      copilotThreadId="marketr-assistant"
    />
  );
}
