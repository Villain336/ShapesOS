// Marketr — AI chat panel: transcript + floating composer.
// Thread state lives in the chat provider; the thread list renders as a
// contextual section of the single AppSidebar (desktop) or a collapsible
// (mobile). UI: vault components only. Phosphor duotone for feature icons.

"use client";

import { TrendUp } from "@phosphor-icons/react";
import PromptBar from "@/components/vault/primitives/PromptBar";
import { StreamText } from "@/components/vault/atoms/StreamText";
import ThinkingState from "@/components/vault/primitives/ThinkingState";
import ToolChips, { type ToolStep } from "@/components/vault/primitives/ToolChips";
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
} from "@/components/vault/shadcn/message-scroller";
import {
  Message,
  MessageContent,
} from "@/components/vault/shadcn/message";
import { Bubble, BubbleContent } from "@/components/vault/shadcn/bubble";
import type { ChatToolCall } from "@/lib/chat/agent";
import { useChat } from "./chat/ChatContext";

/** Pick a vault tool icon from the tool name. */
function stepIcon(tool: string): ToolStep["icon"] {
  const name = tool.toLowerCase();
  if (/read|lookup|rank|keyword|alert|competitor|fetch|search|list|help/.test(name)) return "read";
  if (/write|draft|create|report|content|update|edit|think/.test(name)) return "write";
  if (/run|audit|check|execute|apply|confirm/.test(name)) return "run";
  return "think";
}

/** Map the agent's tool-call records onto vault ToolChips steps. */
function toolSteps(calls: ChatToolCall[]): ToolStep[] {
  return calls.map((c) => ({
    icon: stepIcon(c.tool),
    label: c.tool,
    chip: c.status.replace(/_/g, " "),
    mono: false,
    detailMono: false,
    detail: [{ text: c.resultSummary ?? "No summary available" }],
  }));
}

function toolLabels(count: number) {
  return {
    header: `${count} tool call${count === 1 ? "" : "s"}`,
    more: "",
  };
}

export default function AiChatPanel() {
  const { messages, sending, sendMessage, session } = useChat();
  const canEdit = session?.canEdit ?? false;
  const mockMode = session?.mockMode ?? false;

  return (
    <div className="flex h-full min-h-0">
      {/* Transcript + floating composer */}
      <div className="relative flex min-w-0 flex-1 flex-col bg-page">
        <MessageScrollerProvider autoScroll>
          <MessageScroller className="min-h-0 flex-1">
            <MessageScrollerViewport className="thin-scroll">
              <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 px-4 pb-48 pt-8">
                {messages.length === 0 && !sending ? (
                  <div className="flex flex-col items-center pt-16 text-center">
                    <span className="flex size-12 items-center justify-center rounded-full bg-ink text-page">
                      <TrendUp className="size-6" weight="duotone" />
                    </span>
                    <h2 className="display-serif mt-4 text-[24px] font-medium text-ink">
                      Ask Marketr to do the work
                    </h2>
                    <p className="mt-2 max-w-[52ch] text-[13.5px] leading-relaxed text-ink-2">
                      Rank lookups, keyword research, content drafts, audits, reports, autopilot
                      approvals — grounded in this project’s data.
                    </p>
                    <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5">
                      <span className="text-[12px] text-ink-3">Try:</span>
                      {["/rankings", "/keywords", "/alerts", "/help"].map((c) => (
                        <code
                          key={c}
                          className="rounded-chip bg-surface px-1.5 py-0.5 font-mono text-[12px] text-ink-2 shadow-hairline"
                        >
                          {c}
                        </code>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((m) => {
                    if (m.role === "user") {
                      return (
                        <MessageScrollerItem
                          key={m.id}
                          messageId={m.id}
                          scrollAnchor
                          className="msg-enter"
                        >
                          <Message align="end">
                            <MessageContent>
                              <Bubble variant="secondary" align="end">
                                <BubbleContent>
                                  <p className="whitespace-pre-wrap">{m.content}</p>
                                </BubbleContent>
                              </Bubble>
                            </MessageContent>
                          </Message>
                        </MessageScrollerItem>
                      );
                    }
                    if (m.role === "tool") {
                      const calls = m.toolCalls ?? [];
                      return (
                        <MessageScrollerItem key={m.id} messageId={m.id} className="msg-enter">
                          <Message align="start">
                            <MessageContent>
                              <ToolChips steps={toolSteps(calls)} diffs={[]} labels={toolLabels(calls.length)} />
                            </MessageContent>
                          </Message>
                        </MessageScrollerItem>
                      );
                    }
                    return (
                      <MessageScrollerItem key={m.id} messageId={m.id} className="msg-enter">
                        <Message align="start">
                          <MessageContent>
                            <Bubble variant="ghost" align="start">
                              <BubbleContent>
                                <div className="whitespace-pre-wrap">
                                  <StreamText text={m.content} caret={false} />
                                </div>
                              </BubbleContent>
                              {m.toolCalls && m.toolCalls.length > 0 && (
                                <div className="mt-2">
                                  <ToolChips
                                    steps={toolSteps(m.toolCalls)}
                                    diffs={[]}
                                    labels={toolLabels(m.toolCalls.length)}
                                  />
                                </div>
                              )}
                            </Bubble>
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    );
                  })
                )}
                {sending && (
                  <MessageScrollerItem messageId="thinking" className="msg-enter">
                    <Message align="start">
                      <MessageContent>
                        <ThinkingState
                          variant="Steps"
                          active="Working"
                          done="Done"
                          rows={[
                            { primary: "Reading project data" },
                            { primary: "Running tools" },
                            { primary: "Drafting reply" },
                          ]}
                        />
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton size="icon" variant="secondary" style={{ bottom: "7rem" }} />
          </MessageScroller>
        </MessageScrollerProvider>

        {/* Floating composer */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0">
          <div className="mx-auto w-full max-w-3xl px-4 pb-4">
            <div className="pointer-events-auto">
              {canEdit ? (
                <div className="material-float rounded-[14px] p-2 shadow-float-lg ring-1 ring-line">
                  <PromptBar
                    demo={false}
                    placeholder="Ask Marketr…  (try /keywords /rankings /alerts /competitors /draft <topic> /help)"
                    onSend={(text) => void sendMessage(text)}
                  />
                </div>
              ) : (
                <div className="rounded-[14px] bg-surface px-4 py-3 text-center text-[13px] text-ink-2 shadow-float-md ring-1 ring-line">
                  You need the editor role to chat with the AI assistant.
                </div>
              )}
              {mockMode && canEdit && (
                <p className="mt-2 text-center text-[12px] text-ink-3">
                  Mock mode — the assistant runs a rule-based demo. Type{" "}
                  <code className="rounded-chip bg-surface px-1 font-mono shadow-hairline">/help</code>{" "}
                  to see commands.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
