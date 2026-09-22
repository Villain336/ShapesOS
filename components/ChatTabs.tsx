// Marketr — chat page tabs: AI assistant chat vs team chat.

"use client";

import { useState } from "react";
import { Bot, Users } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/vault/shadcn/tabs";
import AiChatPanel from "./AiChatPanel";
import TeamChatPanel from "./TeamChatPanel";

export default function ChatTabs({
  projectId,
  canEdit,
  mockMode,
  memberCount,
  currentUserId,
  initialTab,
}: {
  projectId: string;
  canEdit: boolean;
  mockMode: boolean;
  memberCount: number;
  currentUserId: string;
  initialTab: "ai" | "team";
}) {
  const [tab, setTab] = useState<"ai" | "team">(initialTab);

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as "ai" | "team")}>
      <TabsList
        variant="line"
        className="w-full justify-start gap-1 rounded-none border-b border-line bg-transparent p-0"
      >
        <TabsTrigger value="ai" className="px-3 py-2 after:bg-accent after:bottom-[-1px]">
          <Bot size={15} strokeWidth={2} className={tab === "ai" ? "text-accent-ink" : ""} />
          AI Assistant
        </TabsTrigger>
        <TabsTrigger value="team" className="px-3 py-2 after:bg-accent after:bottom-[-1px]">
          <Users size={15} strokeWidth={2} className={tab === "team" ? "text-accent-ink" : ""} />
          Team chat
        </TabsTrigger>
      </TabsList>

      <TabsContent value="ai" className="mt-4">
        <AiChatPanel projectId={projectId} canEdit={canEdit} mockMode={mockMode} />
      </TabsContent>
      <TabsContent value="team" className="mt-4">
        <TeamChatPanel projectId={projectId} memberCount={memberCount} currentUserId={currentUserId} />
      </TabsContent>
    </Tabs>
  );
}
