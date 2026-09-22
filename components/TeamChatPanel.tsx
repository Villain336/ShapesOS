// Marketr — per-project team chat (redesign §3b).
// Polling-based message list (5s ?after= refresh), composer, member count.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Send, Users } from "lucide-react";

interface TeamMessage {
  id: string;
  userId: string;
  authorName: string;
  body: string;
  createdAt: string;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function TeamChatPanel({
  projectId,
  memberCount,
  currentUserId,
}: {
  projectId: string;
  memberCount: number;
  currentUserId: string;
}) {
  const [messages, setMessages] = useState<TeamMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const latestRef = useRef<string | null>(null);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const fetchMessages = useCallback(
    async (after?: string) => {
      const url = after
        ? `/api/team/chat?projectId=${projectId}&after=${encodeURIComponent(after)}`
        : `/api/team/chat?projectId=${projectId}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const incoming = (data.messages ?? []) as TeamMessage[];
      if (after) {
        if (incoming.length) {
          setMessages((prev) => {
            const ids = new Set(prev.map((m) => m.id));
            return [...prev, ...incoming.filter((m) => !ids.has(m.id))];
          });
          latestRef.current = incoming[incoming.length - 1].createdAt;
        }
      } else {
        setMessages(incoming);
        if (incoming.length) latestRef.current = incoming[incoming.length - 1].createdAt;
        scrollToBottom();
      }
    },
    [projectId, scrollToBottom],
  );

  useEffect(() => {
    fetchMessages();
    const id = setInterval(() => fetchMessages(latestRef.current ?? undefined), 5000);
    return () => clearInterval(id);
  }, [fetchMessages]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending || text.length > 2000) return;
    setSending(true);
    try {
      const res = await fetch("/api/team/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, body: text }),
      });
      if (!res.ok) return;
      const data = await res.json();
      const msg = data.message as TeamMessage;
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
      latestRef.current = msg.createdAt;
      setInput("");
      scrollToBottom();
    } finally {
      setSending(false);
    }
  }, [input, projectId, scrollToBottom, sending]);

  return (
    <div className="flex h-[calc(100vh-220px)] min-h-[480px] flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <div className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-5 py-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900">Project channel</h3>
          <p className="text-xs text-zinc-500">Shared with everyone on this project. Refreshes every 5 seconds.</p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs text-zinc-600">
          <Users size={13} className="text-orange-600" strokeWidth={2} />
          {memberCount} member{memberCount === 1 ? "" : "s"}
        </span>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-5">
        {messages.length === 0 ? (
          <div className="mx-auto mt-16 max-w-sm text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100">
              <Users size={22} className="text-zinc-400" strokeWidth={2} />
            </div>
            <h3 className="text-sm font-semibold text-zinc-900">No messages yet</h3>
            <p className="mt-1 text-sm text-zinc-500">Kick off the conversation — the whole project team sees it here.</p>
          </div>
        ) : (
          messages.map((m) => {
            const mine = m.userId === currentUserId;
            return (
              <div key={m.id} className="flex flex-col gap-0.5">
                <div className="flex items-baseline gap-2">
                  <span className={`text-sm font-medium ${mine ? "text-orange-700" : "text-zinc-900"}`}>
                    {m.authorName}
                    {mine && <span className="ml-1.5 text-xs font-normal text-zinc-400">(you)</span>}
                  </span>
                  <span className="text-xs text-zinc-400">{formatTime(m.createdAt)}</span>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-700">{m.body}</p>
              </div>
            );
          })
        )}
      </div>

      <div className="border-t border-zinc-200 bg-white p-4">
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
            maxLength={2000}
            placeholder="Message the team…"
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
        <p className={`mt-1 text-right text-xs ${input.length >= 1900 ? "text-amber-600" : "text-zinc-400"}`}>
          {input.length}/2000
        </p>
      </div>
    </div>
  );
}
