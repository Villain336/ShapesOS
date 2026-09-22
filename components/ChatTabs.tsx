// Marketr — chat shell: slim top strip (project, AI/Team segmented tabs,
// live indicator) over the two chat panels. No page header.

"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Robot, Users } from "@phosphor-icons/react";
import { Tabs, TabsContent } from "@/components/vault/shadcn/tabs";
import AiChatPanel from "./AiChatPanel";
import TeamChatPanel from "./TeamChatPanel";
import { cn } from "@/lib/utils";

export default function ChatTabs({
  projectId,
  projectDomain,
  canEdit,
  mockMode,
  memberCount,
  currentUserId,
  initialTab,
}: {
  projectId: string;
  projectDomain: string;
  canEdit: boolean;
  mockMode: boolean;
  memberCount: number;
  currentUserId: string;
  initialTab: "ai" | "team";
}) {
  const [tab, setTab] = useState<"ai" | "team">(initialTab);

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as "ai" | "team")}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
        <Link
          href={`/dashboard/projects/${projectId}`}
          className="inline-flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-ink-2 transition-colors hover:text-ink"
        >
          <ArrowLeft className="size-3.5 shrink-0" />
          <span className="truncate">{projectDomain}</span>
        </Link>
        <div
          role="tablist"
          aria-label="Chat mode"
          className="mx-auto flex items-center gap-0.5 rounded-full bg-inset p-0.5"
        >
          {(
            [
              { value: "ai", label: "AI Assistant", Icon: Robot },
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
        <span className="hidden items-center gap-1.5 text-[12px] text-ink-3 sm:inline-flex">
          <span className={cn("size-1.5 rounded-full", mockMode ? "bg-amber" : "bg-green")} />
          {mockMode ? "Mock mode" : "Live AI"}
        </span>
      </div>

      <TabsContent value="ai" className="min-h-0 flex-1">
        <AiChatPanel projectId={projectId} canEdit={canEdit} mockMode={mockMode} />
      </TabsContent>
      <TabsContent value="team" className="min-h-0 flex-1">
        <TeamChatPanel projectId={projectId} memberCount={memberCount} currentUserId={currentUserId} />
      </TabsContent>
    </Tabs>
  );
}
