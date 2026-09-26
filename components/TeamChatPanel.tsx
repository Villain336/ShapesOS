// Marketr — per-project team chat.
// Polling-based (5s ?after= refresh), MessageScroller transcript,
// floating composer. UI: vault components only.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Users } from "lucide-react";
import { EmptyState } from "@/components/vault/EmptyState";
import { ValuePill } from "@/components/vault/atoms/ValuePill";
import PromptBar from "@/components/vault/primitives/PromptBar";
import { Avatar, AvatarFallback } from "@/components/vault/shadcn/avatar";
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
  MessageAvatar,
  MessageContent,
  MessageHeader,
} from "@/components/vault/shadcn/message";
import { Bubble, BubbleContent } from "@/components/vault/shadcn/bubble";
import { cn } from "@/lib/utils";

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
  const latestRef = useRef<string | null>(null);

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
      }
    },
    [projectId],
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
      } finally {
        setSending(false);
      }
    },
    [projectId, sending],
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-page">
      {/* Slim channel strip — chat chrome, not a page header */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface px-4">
        <span className="text-[13px] font-medium text-ink">Project channel</span>
        <ValuePill tone="neutral">
          <Users className="mr-1 size-3" />
          {memberCount} member{memberCount === 1 ? "" : "s"}
        </ValuePill>
        <span className="ml-auto text-[12px] text-ink-3">Refreshes every 5 seconds</span>
      </div>

      <div className="relative min-h-0 flex-1">
        <MessageScrollerProvider autoScroll>
          <MessageScroller className="min-h-0 flex-1">
            <MessageScrollerViewport className="thin-scroll">
              <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-5 px-4 pb-48 pt-6">
                {messages.length === 0 ? (
                  <div className="flex flex-col items-center pt-16 text-center">
                    <span className="flex size-12 items-center justify-center rounded-full bg-violet-600 text-white">
                      <Users className="size-6" />
                    </span>
                    <h2 className="mt-4 text-[24px] font-bold tracking-tight text-stone-900">
                      No messages yet
                    </h2>
                    <p className="mt-2 max-w-[46ch] text-[13.5px] leading-relaxed text-ink-2">
                      Kick off the conversation — the whole project team sees it here.
                    </p>
                  </div>
                ) : (
                  messages.map((m) => {
                    const mine = m.userId === currentUserId;
                    return (
                      <MessageScrollerItem
                        key={m.id}
                        messageId={m.id}
                        scrollAnchor={mine}
                        className="msg-enter"
                      >
                        <Message align="start">
                          <MessageAvatar>
                            <Avatar size="sm">
                              <AvatarFallback
                                className={cn(mine && "bg-ink text-page")}
                              >
                                {initials(m.authorName)}
                              </AvatarFallback>
                            </Avatar>
                          </MessageAvatar>
                          <MessageContent>
                            <MessageHeader>
                              <span className="font-medium text-ink">{m.authorName}</span>
                              {mine && <ValuePill tone="accent">you</ValuePill>}
                              <span className="font-normal text-ink-3">{formatTime(m.createdAt)}</span>
                            </MessageHeader>
                            <Bubble variant="ghost" align="start">
                              <BubbleContent>
                                <p className="whitespace-pre-wrap text-ink-2">{m.body}</p>
                              </BubbleContent>
                            </Bubble>
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    );
                  })
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton size="icon" variant="secondary" style={{ bottom: "7rem" }} />
          </MessageScroller>
        </MessageScrollerProvider>

        {/* Floating composer */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0">
          <div className="mx-auto w-full max-w-3xl px-4 pb-4">
            <div className="material-float pointer-events-auto rounded-[14px] p-2 shadow-float-lg ring-1 ring-line">
              <PromptBar
                demo={false}
                placeholder="Message the team…"
                onSend={(text) => void sendMessage(text)}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
