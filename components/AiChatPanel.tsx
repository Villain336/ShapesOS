// Marketr — AI chat panel (redesign §3a): ChatGPT-style full-page chat.
// Thread rail left, messages center, composer bottom. Light theme.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock,
  MessageSquare,
  Plus,
  Send,
  Sparkles,
  Trash2,
  Wrench,
  XCircle,
} from "lucide-react";
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

const STATUS_ICON: Record<string, { icon: typeof CheckCircle2; cls: string }> = {
  executed: { icon: CheckCircle2, cls: "text-green-600" },
  pending_confirmation: { icon: Clock, cls: "text-amber-600" },
  error: { icon: XCircle, cls: "text-red-600" },
  skipped_role: { icon: AlertTriangle, cls: "text-zinc-500" },
};

/** Tiny inline formatter: **bold** and `code`, rest plain text. */
function renderInline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={i} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code key={i} className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.85em] text-zinc-800">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function ToolChips({ calls }: { calls: ChatToolCall[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {calls.map((c, i) => {
        const s = STATUS_ICON[c.status] ?? STATUS_ICON.executed;
        const Icon = s.icon;
        return (
          <span
            key={i}
            title={c.resultSummary ?? c.tool}
            className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-xs text-zinc-700"
          >
            <Icon size={13} className={s.cls} strokeWidth={2} />
            <span className="font-medium">{c.tool}</span>
            <span className="text-zinc-400">{c.status.replace(/_/g, " ")}</span>
          </span>
        );
      })}
    </div>
  );
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
  const [input, setInput] = useState("");
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

  const send = useCallback(async () => {
    const text = input.trim();
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
    setInput("");
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
  }, [activeId, canEdit, input, projectId, sending]);

  return (
    <div className="flex h-[calc(100vh-220px)] min-h-[480px] overflow-hidden rounded-xl border border-zinc-200 bg-white">
      {/* Thread rail */}
      <div className="flex w-64 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50">
        <div className="border-b border-zinc-200 p-3">
          <button
            onClick={newThread}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-orange-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-orange-700 active:scale-[0.98]"
          >
            <Plus size={16} strokeWidth={2} />
            New chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {loading ? (
            <p className="px-2 py-4 text-sm text-zinc-400">Loading chats…</p>
          ) : threads.length === 0 ? (
            <p className="px-2 py-4 text-sm text-zinc-400">No chats yet. Start one below.</p>
          ) : (
            threads.map((t) => (
              <div
                key={t.id}
                className={`group mb-1 flex items-center gap-1 rounded-lg px-2 py-2 text-sm transition-colors ${
                  t.id === activeId
                    ? "border border-orange-200 bg-orange-50 text-zinc-900"
                    : "border border-transparent text-zinc-600 hover:bg-zinc-100"
                }`}
              >
                <button onClick={() => openThread(t.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <MessageSquare size={15} className={t.id === activeId ? "text-orange-600" : "text-zinc-400"} strokeWidth={2} />
                  <span className="truncate">{t.title}</span>
                </button>
                <button
                  onClick={() => deleteThread(t.id)}
                  title="Delete chat"
                  className="hidden rounded p-1 text-zinc-400 hover:bg-zinc-200 hover:text-red-600 group-hover:block"
                >
                  <Trash2 size={14} strokeWidth={2} />
                </button>
              </div>
            ))
          )}
        </div>
        <div className="border-t border-zinc-200 p-3 text-xs text-zinc-400">
          {mockMode ? "Mock mode — rule-based demo" : "Live AI agent"}
        </div>
      </div>

      {/* Messages + composer */}
      <div className="flex min-w-0 flex-1 flex-col">
        {mockMode && (
          <div className="flex items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-4 py-2 text-xs text-zinc-500">
            <Sparkles size={14} className="text-orange-600" strokeWidth={2} />
            No LLM key configured — the assistant runs a rule-based demo. Type <code className="rounded bg-zinc-100 px-1 font-mono">/help</code> to see commands.
          </div>
        )}
        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto bg-white p-5">
          {messages.length === 0 && (
            <div className="mx-auto mt-16 max-w-md text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-orange-100">
                <Bot size={24} className="text-orange-600" strokeWidth={2} />
              </div>
              <h3 className="text-lg font-semibold text-zinc-900">Ask Marketr to do the work</h3>
              <p className="mt-1 text-sm text-zinc-500">
                Rank lookups, keyword research, content drafts, audits, reports, autopilot approvals — grounded in this
                project&apos;s data.
              </p>
              <p className="mt-3 text-xs text-zinc-400">
                Try: <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono">/rankings</code>{" "}
                <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono">/keywords</code>{" "}
                <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono">/alerts</code>{" "}
                <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono">/help</code>
              </p>
            </div>
          )}
          {messages.map((m) => {
            if (m.role === "user") {
              return (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[75%] rounded-2xl rounded-br-md bg-zinc-900 px-4 py-2.5 text-sm text-white">
                    <p className="whitespace-pre-wrap">{m.content}</p>
                  </div>
                </div>
              );
            }
            if (m.role === "tool") {
              const calls = m.toolCalls ?? [];
              return (
                <div key={m.id} className="flex justify-start">
                  <div className="max-w-[85%] rounded-xl border border-zinc-200 bg-zinc-50 px-3.5 py-2.5">
                    {calls.map((c, i) => {
                      const s = STATUS_ICON[c.status] ?? STATUS_ICON.executed;
                      const Icon = s.icon;
                      return (
                        <div key={i} className="flex items-start gap-2 text-sm">
                          <Wrench size={14} className="mt-0.5 shrink-0 text-zinc-400" strokeWidth={2} />
                          <div className="min-w-0">
                            <p className="font-medium text-zinc-800">
                              {c.tool} <Icon size={13} className={`ml-1 inline ${s.cls}`} strokeWidth={2} />
                            </p>
                            <p className="text-xs text-zinc-500">{c.resultSummary}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            }
            return (
              <div key={m.id} className="flex justify-start gap-2.5">
                <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-orange-100">
                  <Bot size={15} className="text-orange-600" strokeWidth={2} />
                </div>
                <div className="max-w-[85%] rounded-2xl rounded-tl-md border border-zinc-200 bg-white px-4 py-2.5 text-sm text-zinc-800 shadow-sm">
                  <div className="whitespace-pre-wrap leading-relaxed">{renderInline(m.content)}</div>
                  {m.toolCalls && m.toolCalls.length > 0 && <ToolChips calls={m.toolCalls} />}
                </div>
              </div>
            );
          })}
          {sending && (
            <div className="flex justify-start gap-2.5">
              <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full bg-orange-100">
                <Bot size={15} className="text-orange-600" strokeWidth={2} />
              </div>
              <div className="flex items-center gap-1.5 rounded-2xl rounded-tl-md border border-zinc-200 px-4 py-3">
                {[0, 1, 2].map((d) => (
                  <span
                    key={d}
                    className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400"
                    style={{ animationDelay: `${d * 150}ms` }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-zinc-200 bg-white p-4">
          {canEdit ? (
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={1}
                placeholder="Ask Marketr…  (try /keywords /rankings /alerts /competitors /draft <topic> /help)"
                className="max-h-32 min-h-[44px] flex-1 resize-none rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-100"
              />
              <button
                onClick={send}
                disabled={sending || !input.trim()}
                title="Send"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-orange-600 text-white transition-all hover:bg-orange-700 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Send size={17} strokeWidth={2} />
              </button>
            </div>
          ) : (
            <p className="rounded-xl bg-zinc-50 px-4 py-3 text-center text-sm text-zinc-500">
              You need the editor role to chat with the AI assistant.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
