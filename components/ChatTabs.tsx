// Marketr — chat page tabs: AI assistant chat vs team chat.

"use client";

import { useState } from "react";
import { Bot, Users } from "lucide-react";
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
    <div className="flex flex-col gap-4">
      <div className="flex gap-1 border-b border-zinc-200">
        <button
          onClick={() => setTab("ai")}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors ${
            tab === "ai"
              ? "border-b-2 border-orange-600 text-zinc-900"
              : "text-zinc-500 hover:text-zinc-700"
          }`}
        >
          <Bot size={16} strokeWidth={2} className={tab === "ai" ? "text-orange-600" : ""} />
          AI Assistant
        </button>
        <button
          onClick={() => setTab("team")}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors ${
            tab === "team"
              ? "border-b-2 border-orange-600 text-zinc-900"
              : "text-zinc-500 hover:text-zinc-700"
          }`}
        >
          <Users size={16} strokeWidth={2} className={tab === "team" ? "text-orange-600" : ""} />
          Team chat
        </button>
      </div>

      {tab === "ai" ? (
        <AiChatPanel projectId={projectId} canEdit={canEdit} mockMode={mockMode} />
      ) : (
        <TeamChatPanel projectId={projectId} memberCount={memberCount} currentUserId={currentUserId} />
      )}
    </div>
  );
}
