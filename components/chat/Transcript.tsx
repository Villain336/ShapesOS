"use client";

// ShapesOS — Phase 22 (chat): the transcript — one column of blocks
// (lib/chat/blocks.ts), Claude Code style: the person's message, the agent's
// markdown, thinking, tool calls with their results inline, approvals decided
// in place, generative UI, sub-agent plans, notices. The persisted thread and
// the live turn render through the same component.

import { useMemo, type ReactNode } from "react";
import { Markdown } from "./Markdown";
import { ToolCallBlock, type ToolBlockHandlers } from "./blocks/ToolCallBlock";
import { ApprovalBlock, type ApprovalHandlers } from "./blocks/ApprovalBlock";
import { GenUiBlock, type GenUiHandlers } from "./blocks/GenUiBlock";
import { DelegationCard } from "./DelegationCard";
import { LiveStatusLine } from "./LiveStatusLine";
import { StatusShape } from "@/components/aos/StatusShape";
import FeedbackButtons from "@/components/agents/FeedbackButtons";
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
} from "@/components/vault/shadcn/message-scroller";
import type { ChatBlock } from "@/lib/chat/blocks";
import { cn } from "@/lib/utils";
import { useI18n } from "@/components/i18n/I18nProvider";

export interface TranscriptHandlers extends ToolBlockHandlers, GenUiHandlers {
  approval: ApprovalHandlers;
}

function UserBlock({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-lg bg-ink px-4 py-2.5 text-md leading-relaxed whitespace-pre-wrap text-paper">{text}</div>
    </div>
  );
}

function ThinkingBlock({ active, text }: { active: boolean; text?: string }) {
  const { t } = useI18n();
  if (!active && !text) return null;
  return (
    <div className="flex items-start gap-2 text-sm text-muted">
      {active ? <StatusShape status="running" size={9} live className="mt-1" /> : null}
      <span className="min-w-0">{active ? t("chat.thinking") : text}</span>
    </div>
  );
}

function NoticeBlock({ text, tone }: { text: string; tone: "info" | "error" | "stopped" | "decision" }) {
  return (
    <p
      className={cn(
        "flex items-center gap-2 text-sm",
        tone === "error" ? "text-failed-text" : "text-muted",
        tone === "decision" && "justify-center",
      )}
      role={tone === "error" ? "alert" : undefined}
    >
      {tone === "error" ? <span className="inline-block size-2.5 shrink-0 bg-failed" aria-hidden /> : null}
      {tone === "decision" ? <StatusShape status="done" size={9} /> : null}
      <span>{text}</span>
    </p>
  );
}

export function Transcript({
  blocks,
  handlers,
  workspaceId,
  sending,
  liveStatus,
  empty,
  className,
}: {
  blocks: readonly ChatBlock[];
  handlers: TranscriptHandlers;
  workspaceId: string;
  sending: boolean;
  liveStatus: { label: string; live: boolean } | null;
  /** Shown when the thread has no blocks. */
  empty?: ReactNode;
  className?: string;
}) {
  const { t } = useI18n();
  // Feedback sits under the last text block of each agent turn.
  const lastTextIds = useMemo(() => {
    const ids = new Set<string>();
    let lastText: string | null = null;
    for (const b of blocks) {
      if (b.kind === "user") {
        if (lastText) ids.add(lastText);
        lastText = null;
      } else if (b.kind === "text" && !b.streaming) lastText = b.id;
    }
    if (lastText) ids.add(lastText);
    return ids;
  }, [blocks]);
  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller className={cn("min-h-0 flex-1", className)}>
        <MessageScrollerViewport className="thin-scroll">
          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-4 px-4 pb-52 pt-6">
            {blocks.length === 0 && !sending ? empty : null}
            {blocks.map((b) => {
              switch (b.kind) {
                case "user":
                  return (
                    <MessageScrollerItem key={b.id} messageId={b.id} scrollAnchor className="msg-enter">
                      <UserBlock text={b.text} />
                    </MessageScrollerItem>
                  );
                case "text":
                  return (
                    <MessageScrollerItem key={b.id} messageId={b.id} className="msg-enter">
                      <Markdown text={b.text}>
                        {b.cached ? <p className="mt-1 text-xs text-muted">{t("chat.cached")}</p> : null}
                        {lastTextIds.has(b.id) && !sending ? (
                          <div className="mt-1 flex justify-end">
                            <FeedbackButtons agentId="business-strategist" workspaceId={workspaceId} />
                          </div>
                        ) : null}
                      </Markdown>
                    </MessageScrollerItem>
                  );
                case "thinking":
                  return (
                    <MessageScrollerItem key={b.id} messageId={b.id} className="msg-enter">
                      <ThinkingBlock active={b.active} text={b.text} />
                    </MessageScrollerItem>
                  );
                case "tool":
                  return (
                    <MessageScrollerItem key={b.id} messageId={b.id} className="msg-enter">
                      <ToolCallBlock block={b} handlers={handlers} />
                    </MessageScrollerItem>
                  );
                case "approval":
                  return (
                    <MessageScrollerItem key={b.id} messageId={b.id} className="msg-enter">
                      <ApprovalBlock block={b} handlers={handlers.approval} />
                    </MessageScrollerItem>
                  );
                case "genui":
                  return (
                    <MessageScrollerItem key={b.id} messageId={b.id} className="msg-enter">
                      <GenUiBlock block={b} handlers={handlers} />
                    </MessageScrollerItem>
                  );
                case "delegation":
                  return (
                    <MessageScrollerItem key={b.id} messageId={b.id} className="msg-enter">
                      <DelegationCard runId={b.parentRunId} planId={b.planId} tasks={b.tasks} goal={b.goal} />
                    </MessageScrollerItem>
                  );
                case "notice":
                  return (
                    <MessageScrollerItem key={b.id} messageId={b.id} className="msg-enter">
                      <NoticeBlock text={b.text} tone={b.tone} />
                    </MessageScrollerItem>
                  );
              }
            })}
            {sending && liveStatus ? (
              <MessageScrollerItem messageId="live-status" className="msg-enter">
                <LiveStatusLine status={liveStatus} />
              </MessageScrollerItem>
            ) : null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton size="icon" variant="secondary" style={{ bottom: "9rem" }} />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

export default Transcript;
