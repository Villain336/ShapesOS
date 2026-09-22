"use client";

// Marketr — chat thread list. Rendered as a contextual section inside the
// single AppSidebar on the assistant page (desktop), and inside a collapsible
// on mobile. Reads all state from the chat provider.

import { ChatCentered, Plus, Trash } from "@phosphor-icons/react";
import { Button } from "@/components/vault/atoms/Button";
import { EmptyState } from "@/components/vault/EmptyState";
import GlideMenu from "@/components/vault/primitives/GlideMenu";
import LoadingState from "@/components/vault/primitives/LoadingState";
import { cn } from "@/lib/utils";
import { useChat } from "./ChatContext";

export default function ThreadListSection() {
  const {
    threads,
    activeId,
    loadingThreads,
    openThread,
    newThread,
    deleteThread,
    session,
  } = useChat();

  return (
    <div className="flex flex-col gap-2">
      <div className="px-1">
        <Button variant="accent" size="md" className="w-full" onClick={() => void newThread()}>
          <Plus className="size-4" />
          New chat
        </Button>
      </div>
      <GlideMenu className="p-1" highlightClassName="inset-x-1 rounded-full bg-hover">
        {loadingThreads ? (
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
                onClick={() => void openThread(t.id)}
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
                onClick={() => void deleteThread(t.id)}
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
      <div className="px-3 text-[12px] text-ink-3">
        {session?.mockMode ? "Mock mode — rule-based demo" : "Live AI agent"}
      </div>
    </div>
  );
}
