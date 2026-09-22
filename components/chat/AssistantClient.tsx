"use client";

// Marketr — global AI assistant shell. Sets the chat session from the
// server-provided project, renders the top strip (project switcher, AI/Team
// segmented tabs, live indicator), and the active panel. The thread list
// lives in the AppSidebar on desktop; on mobile it collapses above the panel.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CaretUpDown,
  Chats,
  Check,
  TrendUp,
  Users,
} from "@phosphor-icons/react";
import { useChat, type ChatTab } from "./ChatContext";
import AiChatPanel from "@/components/AiChatPanel";
import TeamChatPanel from "@/components/TeamChatPanel";
import ThreadListSection from "./ThreadListSection";
import { buttonVariants } from "@/components/vault/atoms/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/vault/shadcn/dropdown-menu";
import { cn } from "@/lib/utils";

export interface AssistantProject {
  id: string;
  domain: string;
}

export default function AssistantClient({
  project,
  projects,
  canEdit,
  mockMode,
  memberCount,
  currentUserId,
  initialTab,
}: {
  project: AssistantProject;
  projects: AssistantProject[];
  canEdit: boolean;
  mockMode: boolean;
  memberCount: number;
  currentUserId: string;
  initialTab: ChatTab;
}) {
  const { setSession, tab, setTab } = useChat();
  const router = useRouter();
  const [showThreads, setShowThreads] = useState(false);

  useEffect(() => {
    setSession({
      projectId: project.id,
      projectDomain: project.domain,
      canEdit,
      mockMode,
    });
    return () => setSession(null);
  }, [project.id, project.domain, canEdit, mockMode, setSession]);

  useEffect(() => {
    setTab(initialTab);
    // Mount-only: the tab is user-controlled afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Top strip: project switcher, AI/Team tabs, live indicator */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "max-w-56 justify-between")}
            aria-label="Switch project"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-control bg-ink text-page">
                <TrendUp className="size-3" weight="duotone" />
              </span>
              <span className="truncate text-[13px] font-medium">{project.domain}</span>
            </span>
            <CaretUpDown className="size-3.5 shrink-0 opacity-60" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel>Project</DropdownMenuLabel>
            {projects.map((p) => {
              const selected = p.id === project.id;
              return (
                <DropdownMenuItem
                  key={p.id}
                  onSelect={() => router.push(`/dashboard/assistant?project=${p.id}`)}
                  className="justify-between"
                >
                  <span className="truncate">{p.domain}</span>
                  {selected ? <Check className="size-3.5 shrink-0" /> : null}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        <div
          role="tablist"
          aria-label="Chat mode"
          className="mx-auto flex items-center gap-0.5 rounded-full bg-inset p-0.5"
        >
          {(
            [
              { value: "ai", label: "AI Assistant", Icon: TrendUp },
              { value: "team", label: "Team chat", Icon: Users },
            ] as const
          ).map(({ value, label, Icon }) => {
            const active = tab === value;
            return (
              <button
                key={value}
                role="tab"
                aria-selected={active}
                onClick={() => setTab(value)}
                className={cn(
                  "flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] transition-all duration-150",
                  active
                    ? "bg-surface font-medium text-ink shadow-hairline"
                    : "text-ink-2 hover:text-ink",
                )}
              >
                <Icon className="size-[15px]" weight="duotone" />
                {label}
              </button>
            );
          })}
        </div>

        {/* Mobile thread toggle — the sidebar is hidden on small screens */}
        <button
          type="button"
          onClick={() => setShowThreads((v) => !v)}
          aria-expanded={showThreads}
          aria-label="Toggle chat threads"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] text-ink-2 transition-colors hover:text-ink md:hidden",
            showThreads && "bg-accent-tint font-medium text-accent-ink",
          )}
        >
          <Chats className="size-[15px]" weight="duotone" />
          Chats
        </button>

        <span className="hidden items-center gap-1.5 text-[12px] text-ink-3 sm:inline-flex">
          <span className={cn("size-1.5 rounded-full", mockMode ? "bg-amber" : "bg-green")} />
          {mockMode ? "Mock mode" : "Live AI"}
        </span>
      </div>

      {/* Mobile collapsible thread list */}
      {showThreads && tab === "ai" && (
        <div className="shrink-0 border-b border-line bg-surface px-3 py-3 md:hidden">
          <div className="max-h-64 overflow-y-auto">
            <ThreadListSection />
          </div>
        </div>
      )}

      {/* Panels */}
      <div className="min-h-0 flex-1">
        {tab === "ai" ? (
          <AiChatPanel />
        ) : (
          <TeamChatPanel
            projectId={project.id}
            memberCount={memberCount}
            currentUserId={currentUserId}
          />
        )}
      </div>
    </div>
  );
}
