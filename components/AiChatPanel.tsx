// Marketr — AI chat panel: transcript + floating composer.
// Thread state lives in the chat provider; the thread list renders as a
// contextual section of the single AppSidebar (desktop) or a collapsible
// (mobile).
//
// Phase 22 (chat): the transcript is a Claude Code-style column of blocks
// (components/chat/Transcript.tsx): tool calls with their arguments and
// results inline, held calls decided in an approval block in place (y / n /
// e from the keyboard when no field has focus), markdown replies.

"use client";

import { useEffect } from "react";
import { TrendingUp } from "lucide-react";
import PromptBar from "@/components/vault/primitives/PromptBar";
import { useChat } from "./chat/ChatContext";
import AttachmentMenu from "./chat/AttachmentMenu";
import { TaskBar } from "./chat/TaskControls";
import { Transcript, type TranscriptHandlers } from "./chat/Transcript";
import { useI18n } from "@/components/i18n/I18nProvider";

function typingInField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export default function AiChatPanel({ workspaceId }: { workspaceId: string }) {
  const { t } = useI18n();
  const { blocks, sending, sendMessage, session, liveStatus, decide, decideFirstPending, loadMoreResult } = useChat();
  const canEdit = session?.canEdit ?? false;
  const mockMode = session?.mockMode ?? false;

  // Phase 22: y / n / e decide the newest pending approval (never while typing).
  useEffect(() => {
    if (!canEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typingInField(e.target)) return;
      const k = e.key.toLowerCase();
      if (k !== "y" && k !== "n" && k !== "e") return;
      if (decideFirstPending(k as "y" | "n" | "e")) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canEdit, decideFirstPending]);

  const handlers: TranscriptHandlers = {
    approval: { decide, canEdit },
    loadMore: (handle, offset) => loadMoreResult(handle, offset),
  };

  const empty = (
    <div className="flex flex-col items-center pt-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-sm bg-ink text-paper">
        <TrendingUp className="size-6" />
      </span>
      <h2 className="mt-4 text-xl font-heading stretch-heading tracking-heading text-ink">Ask ShapesOS to do the work</h2>
      <p className="mt-2 max-w-[52ch] text-md leading-relaxed text-muted">
        Rank lookups, keyword research, content drafts, audits, reports, autopilot approvals — grounded in this project’s data.
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5">
        <span className="text-[0.75rem] text-muted">Try:</span>
        {["/rankings", "/keywords", "/alerts", "/help"].map((c) => (
          <code key={c} className="rounded-key bg-paper px-1.5 py-0.5 font-mono text-[0.75rem] text-ink shadow-hairline">
            {c}
          </code>
        ))}
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0">
      <div className="relative flex min-w-0 flex-1 flex-col bg-canvas">
        <Transcript blocks={blocks} handlers={handlers} workspaceId={workspaceId} sending={sending} liveStatus={liveStatus} empty={empty} />

        {/* Floating composer */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0">
          <div className="mx-auto w-full max-w-3xl px-4 pb-4">
            <div className="pointer-events-auto">
              {canEdit ? <TaskBar working={sending} /> : null}
              {canEdit ? (
                <div className="rounded-xl bg-paper p-2 shadow-raised">
                  <AttachmentMenu />
                  <PromptBar
                    demo={false}
                    placeholder="Ask ShapesOS…  (try /keywords /rankings /alerts /competitors /draft <topic> /help)"
                    onSend={(text) => void sendMessage(text)}
                  />
                </div>
              ) : (
                <div className="rounded-xl bg-paper px-4 py-3 text-center text-[0.8125rem] text-muted shadow-raised">{t("chat.composer.viewer")}</div>
              )}
              {mockMode && canEdit && (
                <p className="mt-2 text-center text-[0.75rem] text-muted">
                  Mock mode — the assistant runs a rule-based demo. Type <code className="rounded-key bg-paper px-1 font-mono shadow-hairline">/help</code> to see commands.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
