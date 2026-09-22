// Marketr — per-project team chat (redesign §3b).
// Polling-based message list (5s ?after= refresh), composer, member count.
// UI: vault components only (PromptBar, Card, EmptyState, ValuePill,
// shadcn Avatar).

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Users } from "lucide-react";
import { Card, CardHeader } from "@/components/vault/Card";
import { EmptyState } from "@/components/vault/EmptyState";
import { ValuePill } from "@/components/vault/atoms/ValuePill";
import PromptBar from "@/components/vault/primitives/PromptBar";
import { Avatar, AvatarFallback } from "@/components/vault/shadcn/avatar";

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

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((w) => w.charAt(0))
    .slice(0, 2)
    .join("")
    .toUpperCase();
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

  const sendMessage = useCallback(
    async (raw: string) => {
      const text = raw.trim();
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
        scrollToBottom();
      } finally {
        setSending(false);
      }
    },
    [projectId, scrollToBottom, sending],
  );

  return (
    <Card className="flex h-[calc(100vh-220px)] min-h-[480px] flex-col overflow-hidden">
      <CardHeader
        title="Project channel"
        description="Shared with everyone on this project. Refreshes every 5 seconds."
        actions={
          <ValuePill tone="neutral">
            <Users size={12} strokeWidth={2} className="mr-1 text-accent-ink" />
            {memberCount} member{memberCount === 1 ? "" : "s"}
          </ValuePill>
        }
      />

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto bg-canvas p-5">
        {messages.length === 0 ? (
          <EmptyState
            icon={<Users size={18} strokeWidth={2} />}
            title="No messages yet"
            description="Kick off the conversation — the whole project team sees it here."
          />
        ) : (
          messages.map((m) => {
            const mine = m.userId === currentUserId;
            return (
              <div key={m.id} className="flex gap-2.5">
                <Avatar size="sm">
                  <AvatarFallback className={mine ? "bg-accent-tint text-accent-ink" : undefined}>
                    {initials(m.authorName)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className={`text-[13px] font-medium ${mine ? "text-accent-ink" : "text-ink"}`}>
                      {m.authorName}
                    </span>
                    {mine && <ValuePill tone="accent">you</ValuePill>}
                    <span className="text-[12px] text-ink-3">{formatTime(m.createdAt)}</span>
                  </div>
                  <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed text-ink-2">
                    {m.body}
                  </p>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="border-t border-line bg-surface p-4">
        <PromptBar
          demo={false}
          placeholder="Message the team…"
          onSend={(text) => void sendMessage(text)}
        />
      </div>
    </Card>
  );
}
