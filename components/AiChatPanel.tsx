// Marketr — AI chat panel: ChatGPT-style shell.
// 264px thread rail left, centered max-w-3xl transcript on
// MessageScroller/Message/Bubble primitives, floating composer.
// UI: vault components only. Phosphor duotone for feature icons.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Robot,
  ChatCentered,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import { Button } from "@/components/vault/atoms/Button";
import { EmptyState } from "@/components/vault/EmptyState";
import GlideMenu from "@/components/vault/primitives/GlideMenu";
import LoadingState from "@/components/vault/primitives/LoadingState";
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
import { cn } from "@/lib/utils";
import type { ChatToolCall } from "@/lib/chat/agent";

interface Thread {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

interface ChatMessage {
  id: string;
  role: string;
  content: string;
  toolCalls: ChatToolCall[] | null;
  createdAt: string;
}

/** Pick a vault tool icon from the tool name. */
function stepIcon(tool: string): ToolStep["icon"] {
  const name = tool.toLowerCase();
  if (/read|lookup|rank|keyword|alert|competitor|fetch|search|list|help/.test(name)) return "read";
  if (/write|draft|create|report|content|update|edit/.test(name)) return "write";
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

export default function AiChatPanel({
  projectId,
  canEdit,
  mockMode,
}: {
  projectId: string;
  canEdit: boolean;
  mockMode: boolean;
}) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadThreads = useCallback(async () => {
    const res = await fetch(`/api/chat/threads?projectId=${projectId}`);
    if (!res.ok) return;
    const data = await res.json();
    setThreads(data.threads ?? []);
    setLoading(false);
    return data.threads as Thread[];
  }, [projectId]);

  const openThread = useCallback(async (id: string) => {
    setActiveId(id);
    const res = await fetch(`/api/chat/threads/${id}`);
    if (!res.ok) return;
    const data = await res.json();
    setMessages(data.messages ?? []);
  }, []);

  useEffect(() => {
    loadThreads().then((list) => {
      if (list?.length) openThread(list[0].id);
      else setLoading(false);
    });
  }, [loadThreads, openThread]);

  const newThread = useCallback(async () => {
    const res = await fetch("/api/chat/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const t = data.thread as Thread;
    setThreads((prev) => [t, ...prev]);
    setActiveId(t.id);
    setMessages([]);
  }, [projectId]);

  const deleteThread = useCallback(
    async (id: string) => {
      const res = await fetch(`/api/chat/threads/${id}`, { method: "DELETE" });
      if (!res.ok) return;
      setThreads((prev) => prev.filter((t) => t.id !== id));
      if (activeId === id) {
        const rest = threads.filter((t) => t.id !== id);
        if (rest.length) openThread(rest[0].id);
        else {
          setActiveId(null);
          setMessages([]);
        }
      }
    },
    [activeId, openThread, threads],
  );

  const sendMessage = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || sending || !canEdit) return;
      let threadId = activeId;
      if (!threadId) {
        const res = await fetch("/api/chat/threads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId }),
        });
        if (!res.ok) return;
        const data = await res.json();
        threadId = data.thread.id as string;
        setThreads((prev) => [data.thread, ...prev]);
        setActiveId(threadId);
      }
      const optimistic: ChatMessage = {
        id: `tmp-${Date.now()}`,
        role: "user",
        content: text,
        toolCalls: null,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, optimistic]);
      setSending(true);
      try {
        const res = await fetch(`/api/chat/threads/${threadId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: text }),
        });
        const data = await res.json();
        if (!res.ok) {
          setMessages((prev) => [
            ...prev.filter((m) => m.id !== optimistic.id),
            {
              id: `err-${Date.now()}`,
              role: "assistant",
              content: `Something went wrong: ${data.error ?? "unknown error"}`,
              toolCalls: null,
              createdAt: new Date().toISOString(),
            },
          ]);
          return;
        }
        // Re-fetch the thread for the authoritative message list (includes tool rows).
        const threadRes = await fetch(`/api/chat/threads/${threadId}`);
        if (threadRes.ok) {
          const tdata = await threadRes.json();
          setMessages(tdata.messages ?? []);
        }
        if (data.threadTitle) {
          setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, title: data.threadTitle } : t)));
        }
      } finally {
        setSending(false);
      }
    },
    [activeId, canEdit, projectId, sending],
  );

  return (
    <div className="flex h-full min-h-0">
      {/* Thread rail — 264px */}
      <aside className="flex w-[264px] shrink-0 flex-col border-r border-line bg-surface" aria-label="Chat threads">
        <div className="border-b border-line p-3">
          <Button variant="accent" size="md" className="w-full" onClick={newThread}>
            <Plus className="size-4" />
            New chat
          </Button>
        </div>
        <GlideMenu
          className="thin-scroll flex-1 overflow-y-auto p-2"
          highlightClassName="inset-x-2 rounded-full bg-hover"
        >
          {loading ? (
            <div className="px-2 py-3">
              <LoadingState label="Loading chats" />
            </div>
          ) : threads.length === 0 ? (
            <EmptyState
              icon={<ChatCentered className="size-4" weight="duotone" />}
              title="No chats yet"
              description="Start a new chat above to begin."
              className="px-2 py-6"
            />
          ) : (
            threads.map((t) => (
              <div
                key={t.id}
                data-menu-row
                className="group relative mb-0.5 flex items-center rounded-full"
              >
                <Button
                  variant="quiet"
                  onClick={() => openThread(t.id)}
                  aria-current={t.id === activeId ? "true" : undefined}
                  className={cn(
                    "min-w-0 flex-1 justify-start gap-2 rounded-full px-3 py-2 text-left text-[13px] font-normal hover:bg-transparent",
                    t.id === activeId && "bg-accent-tint font-medium",
                  )}
                >
                  <ChatCentered className="size-[15px] shrink-0 text-ink-3" weight="duotone" />
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                </Button>
                <Button
                  variant="quiet"
                  size="xs"
                  onClick={() => deleteThread(t.id)}
                  title="Delete chat"
                  aria-label={`Delete chat ${t.title}`}
                  className="mr-1 hidden shrink-0 text-ink-3 hover:text-red group-hover:inline-flex"
                >
                  <Trash className="size-3.5" />
                </Button>
              </div>
            ))
          )}
        </GlideMenu>
        <div className="border-t border-line p-3 text-[12px] text-ink-3">
          {mockMode ? "Mock mode — rule-based demo" : "Live AI agent"}
        </div>
      </aside>

      {/* Transcript + floating composer */}
      <div className="relative flex min-w-0 flex-1 flex-col bg-page">
        <MessageScrollerProvider autoScroll>
          <MessageScroller className="min-h-0 flex-1">
            <MessageScrollerViewport className="thin-scroll">
              <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 px-4 pb-48 pt-8">
                {messages.length === 0 && !sending ? (
                  <div className="flex flex-col items-center pt-16 text-center">
                    <span className="flex size-12 items-center justify-center rounded-full bg-ink text-page">
                      <Robot className="size-6" weight="duotone" />
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
