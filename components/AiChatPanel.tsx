// Marketr — AI chat panel: transcript + floating composer.
// Thread state lives in the chat provider; the thread list renders as a
// contextual section of the single AppSidebar (desktop) or a collapsible
// (mobile). UI: vault components only. Phosphor duotone for feature icons.

"use client";

import { TrendingUp } from "lucide-react";
import PromptBar from "@/components/vault/primitives/PromptBar";
import { StreamText } from "@/components/vault/atoms/StreamText";
import ToolChips, { type ToolStep } from "@/components/vault/primitives/ToolChips";
import { LiveStatusLine } from "./chat/LiveStatusLine";
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
import AttachmentMenu from "./chat/AttachmentMenu";
import FeedbackButtons from "@/components/agents/FeedbackButtons";
import { AutoApproveRow, TaskBar } from "./chat/TaskControls";
import { DelegationCard } from "./chat/DelegationCard";

/** Pick a vault tool icon from the tool name. */
function stepIcon(tool: string): ToolStep["icon"] {
  const name = tool.toLowerCase();
  if (/read|lookup|rank|keyword|alert|competitor|fetch|search|list|help/.test(name)) return "read";
  if (/write|draft|create|report|content|update|edit|think/.test(name)) return "write";
  if (/run|audit|check|execute|apply|confirm/.test(name)) return "run";
  return "think";
}

/** Phase 17: the marker a cached answer carries (lib/chat/answer-cache.ts) — a label, not a tool chip. */
const CACHED_ANSWER_TOOL = "cached_answer";

/** Map the agent's tool-call records onto vault ToolChips steps. */
function toolSteps(calls: ChatToolCall[]): ToolStep[] {
  return calls.filter((c) => c.tool !== CACHED_ANSWER_TOOL).map((c) => ({
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

export default function AiChatPanel({ workspaceId }: { workspaceId: string }) {
  const { messages, sending, sendMessage, session, threadTask, liveStatus } = useChat();
  const canEdit = session?.canEdit ?? false;
  const mockMode = session?.mockMode ?? false;
  // Phase 5: the last assistant message's pending proposal, when a per-agent
  // rule could let it run without asking next time (server-marked).
  const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant")?.id;
  const autoOffer = (() => {
    const last = messages.find((m) => m.id === lastAssistantId);
    const call = last?.toolCalls?.find((c) => c.status === "pending_confirmation" && c.autoAction);
    return call?.autoAction ? { agentKey: call.agentKey ?? threadTask?.agentKey ?? "lead", action: call.autoAction } : null;
  })();

  return (
    <div className="flex h-full min-h-0">
      {/* Transcript + floating composer */}
      <div className="relative flex min-w-0 flex-1 flex-col bg-canvas">
        <MessageScrollerProvider autoScroll>
          <MessageScroller className="min-h-0 flex-1">
            <MessageScrollerViewport className="thin-scroll">
              <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 px-4 pb-48 pt-8">
                {messages.length === 0 && !sending ? (
                  <div className="flex flex-col items-center pt-16 text-center">
                    <span className="flex size-12 items-center justify-center rounded-sm bg-ink text-paper">
                      <TrendingUp className="size-6" />
                    </span>
                    <h2 className="mt-4 text-xl font-heading stretch-heading tracking-heading text-ink">
                      Ask ShapesOS to do the work
                    </h2>
                    <p className="mt-2 max-w-[52ch] text-md leading-relaxed text-muted">
                      Rank lookups, keyword research, content drafts, audits, reports, autopilot
                      approvals — grounded in this project’s data.
                    </p>
                    <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5">
                      <span className="text-[12px] text-muted">Try:</span>
                      {["/rankings", "/keywords", "/alerts", "/help"].map((c) => (
                        <code
                          key={c}
                          className="rounded-key bg-paper px-1.5 py-0.5 font-mono text-[12px] text-ink shadow-hairline"
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
                              {m.toolCalls?.some((c) => c.tool === CACHED_ANSWER_TOOL) ? (
                                <p className="mt-1 text-[12px] text-muted">Cached answer — reused from a recent identical question</p>
                              ) : null}
                              {m.toolCalls && toolSteps(m.toolCalls).length > 0 && (
                                <div className="mt-2">
                                  <ToolChips
                                    steps={toolSteps(m.toolCalls)}
                                    diffs={[]}
                                    labels={toolLabels(toolSteps(m.toolCalls).length)}
                                  />
                                </div>
                              )}
                              {/* Phase 16: "Working with N sub-agents" — one card per plan the lead started. */}
                              {(m.toolCalls ?? [])
                                .filter((c) => c.delegation)
                                .map((c) => (
                                  <DelegationCard
                                    key={c.delegation!.planId}
                                    runId={c.delegation!.parentRunId}
                                    planId={c.delegation!.planId}
                                    tasks={c.delegation!.tasks}
                                    goal={c.delegation!.goal}
                                  />
                                ))}
                              {m.id === lastAssistantId && autoOffer && canEdit ? (
                                <AutoApproveRow agentKey={autoOffer.agentKey} action={autoOffer.action} />
                              ) : null}
                              {/* Phase 13B: explicit feedback affordance on agent outputs */}
                              <div className="mt-1 flex justify-end">
                                <FeedbackButtons
                                  agentId="business-strategist"
                                  workspaceId={workspaceId}
                                />
                              </div>
                            </Bubble>
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    );
                  })
                )}
                {/* Phase 17: the real state of the turn (Sending → Working →
                    Thinking → Running <tool>), not a canned animation. */}
                {sending && liveStatus ? (
                  <MessageScrollerItem messageId="live-status" className="msg-enter">
                    <Message align="start">
                      <MessageContent>
                        <LiveStatusLine status={liveStatus} />
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>
                ) : null}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton size="icon" variant="secondary" style={{ bottom: "7rem" }} />
          </MessageScroller>
        </MessageScrollerProvider>

        {/* Floating composer */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0">
          <div className="mx-auto w-full max-w-3xl px-4 pb-4">
            <div className="pointer-events-auto">
              {canEdit ? <TaskBar working={sending} /> : null}
              {canEdit ? (
                <div className="rounded-xl bg-paper p-2 shadow-raised">
                  <AttachmentMenu />
                  <PromptBar
                    demo={false}
                    placeholder="Ask ShapesOS…  (try /keywords /rankings /alerts /competitors /draft <topic> /help)"
                    onSend={(text) => void sendMessage(text)}
                  />
                </div>
              ) : (
                <div className="rounded-xl bg-paper px-4 py-3 text-center text-[13px] text-muted shadow-raised">
                  You need the editor role to chat with ShapesOS.
                </div>
              )}
              {mockMode && canEdit && (
                <p className="mt-2 text-center text-[12px] text-muted">
                  Mock mode — the assistant runs a rule-based demo. Type{" "}
                  <code className="rounded-key bg-paper px-1 font-mono shadow-hairline">/help</code>{" "}
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
