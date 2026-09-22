// Marketr — AI chat panel (redesign §3a): ChatGPT-style full-page chat.
// Thread rail left, messages center, composer bottom. Light theme.
// UI: vault components only (PromptBar, ThinkingState, ToolChips, StreamText,
// GlideMenu, Button, Card, EmptyState, LoadingState).

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, MessageSquare, Plus, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/vault/atoms/Button";
import { Card } from "@/components/vault/Card";
import { EmptyState } from "@/components/vault/EmptyState";
import GlideMenu from "@/components/vault/primitives/GlideMenu";
import LoadingState from "@/components/vault/primitives/LoadingState";
import PromptBar from "@/components/vault/primitives/PromptBar";
import { StreamText } from "@/components/vault/atoms/StreamText";
import ThinkingState from "@/components/vault/primitives/ThinkingState";
import ToolChips, { type ToolStep } from "@/components/vault/primitives/ToolChips";
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
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => scrollToBottom(), [messages, scrollToBottom]);

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
    <Card className="flex h-[calc(100vh-220px)] min-h-[480px] overflow-hidden">
      {/* Thread rail */}
      <div className="flex w-64 shrink-0 flex-col border-r border-line bg-inset">
        <div className="border-b border-line p-3">
          <Button variant="accent" size="md" className="w-full" onClick={newThread}>
            <Plus size={16} strokeWidth={2} />
            New chat
          </Button>
        </div>
        <GlideMenu
          className="flex-1 overflow-y-auto p-2"
          highlightClassName="inset-x-2 rounded-control bg-hover"
        >
          {loading ? (
            <div className="px-2 py-3">
              <LoadingState label="Loading chats" />
            </div>
          ) : threads.length === 0 ? (
            <EmptyState
              icon={<MessageSquare size={16} strokeWidth={2} />}
              title="No chats yet"
              description="Start a new chat above to begin."
              className="px-2 py-6"
            />
          ) : (
            threads.map((t) => (
              <div
                key={t.id}
                data-menu-row
                className="group relative mb-0.5 flex items-center rounded-control"
              >
                <Button
                  variant="quiet"
                  onClick={() => openThread(t.id)}
                  aria-current={t.id === activeId ? "true" : undefined}
                  className={`min-w-0 flex-1 justify-start gap-2 rounded-control px-2 py-2 text-left text-[13px] font-normal hover:bg-transparent ${
                    t.id === activeId ? "bg-accent-tint" : ""
                  }`}
                >
                  <MessageSquare
                    size={15}
                    strokeWidth={2}
                    className={`shrink-0 ${t.id === activeId ? "text-accent-ink" : "text-ink-3"}`}
                  />
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
                  <Trash2 size={14} strokeWidth={2} />
                </Button>
              </div>
            ))
          )}
        </GlideMenu>
        <div className="border-t border-line p-3 text-[12px] text-ink-3">
          {mockMode ? "Mock mode — rule-based demo" : "Live AI agent"}
        </div>
      </div>

      {/* Messages + composer */}
      <div className="flex min-w-0 flex-1 flex-col">
        {mockMode && (
          <div className="flex items-center gap-2 border-b border-line bg-inset px-4 py-2 text-[12px] text-ink-2">
            <Sparkles size={14} className="shrink-0 text-accent-ink" strokeWidth={2} />
            <span>
              No LLM key configured — the assistant runs a rule-based demo. Type{" "}
              <code className="rounded-chip bg-field px-1 font-mono shadow-hairline">/help</code> to see
              commands.
            </span>
          </div>
        )}
        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto bg-canvas p-5">
          {messages.length === 0 && !sending && (
            <EmptyState
              icon={<Bot size={18} strokeWidth={2} className="text-accent-ink" />}
              title="Ask Marketr to do the work"
              description="Rank lookups, keyword research, content drafts, audits, reports, autopilot approvals — grounded in this project's data."
              action={
                <div className="flex flex-wrap items-center justify-center gap-1.5">
                  <span className="text-[12px] text-ink-3">Try:</span>
                  {["/rankings", "/keywords", "/alerts", "/help"].map((c) => (
                    <code
                      key={c}
                      className="rounded-chip bg-field px-1.5 py-0.5 font-mono text-[12px] text-ink-2 shadow-hairline"
                    >
                      {c}
                    </code>
                  ))}
                </div>
              }
            />
          )}
          {messages.map((m) => {
            if (m.role === "user") {
              return (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[75%] rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-[13px] text-canvas">
                    <p className="whitespace-pre-wrap">{m.content}</p>
                  </div>
                </div>
              );
            }
            if (m.role === "tool") {
              const calls = m.toolCalls ?? [];
              return (
                <div key={m.id} className="flex justify-start">
                  <ToolChips steps={toolSteps(calls)} diffs={[]} labels={toolLabels(calls.length)} />
                </div>
              );
            }
            return (
              <div key={m.id} className="flex justify-start gap-2.5">
                <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-tint">
                  <Bot size={15} className="text-accent-ink" strokeWidth={2} />
                </div>
                <div className="min-w-0 max-w-[85%] rounded-2xl rounded-tl-md border border-line bg-surface px-4 py-2.5 text-[13px] leading-relaxed text-ink shadow-card">
                  <div className="whitespace-pre-wrap">
                    <StreamText text={m.content} caret={false} />
                  </div>
                  {m.toolCalls && m.toolCalls.length > 0 && (
                    <div className="mt-2">
                      <ToolChips
                        steps={toolSteps(m.toolCalls)}
                        diffs={[]}
                        labels={toolLabels(m.toolCalls.length)}
                      />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {sending && (
            <div className="flex justify-start gap-2.5">
              <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-tint">
                <Bot size={15} className="text-accent-ink" strokeWidth={2} />
              </div>
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
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-line bg-surface p-4">
          {canEdit ? (
            <PromptBar
              demo={false}
              placeholder="Ask Marketr…  (try /keywords /rankings /alerts /competitors /draft <topic> /help)"
              onSend={(text) => void sendMessage(text)}
            />
          ) : (
            <div className="rounded-control bg-inset px-4 py-3 text-center text-[13px] text-ink-2">
              You need the editor role to chat with the AI assistant.
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
