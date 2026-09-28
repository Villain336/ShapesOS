// Marketr — explicit feedback affordances on agent outputs (Phase 13B,
// worker 5). Small, unobtrusive thumbs up/down that POST to
// /api/agents/feedback as explicit_up / explicit_down (signal {source:
// "ui"}). Renders next to assistant messages (AI chat) and command-bar
// strategist answers. Lucide only, no emoji.

"use client";

import { useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { cn } from "@/lib/utils";

export default function FeedbackButtons({
  agentId,
  episodeId,
  workspaceId,
  className,
}: {
  /** Canonical agent key, e.g. "business-strategist". */
  agentId: string;
  /** Memory episode id when the output was captured; optional. */
  episodeId?: string | null;
  workspaceId: string;
  className?: string;
}) {
  const [vote, setVote] = useState<"explicit_up" | "explicit_down" | null>(null);
  const [sending, setSending] = useState(false);

  async function send(kind: "explicit_up" | "explicit_down") {
    if (sending) return;
    // Tapping the active vote again clears the local highlight; the
    // feedback row itself is an immutable signal (audit trail).
    const next = vote === kind ? null : kind;
    setVote(next);
    if (!next) return;
    setSending(true);
    try {
      await fetch(`/api/agents/feedback?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, agentId, episodeId: episodeId ?? null, kind }),
      });
    } catch {
      // Fire-and-forget: never interrupt the reading surface on failure.
      setVote(null);
    } finally {
      setSending(false);
    }
  }

  const btn = (kind: "explicit_up" | "explicit_down", label: string, Icon: typeof ThumbsUp) => (
    <button
      type="button"
      aria-label={label}
      aria-pressed={vote === kind}
      title={label}
      onClick={() => void send(kind)}
      className={cn(
        "rounded-md p-1 transition-colors",
        vote === kind
          ? kind === "explicit_up"
            ? "text-brand-700"
            : "text-red-500"
          : "text-stone-300 hover:bg-stone-100 hover:text-stone-500",
      )}
    >
      <Icon className="size-3.5" aria-hidden />
    </button>
  );

  return (
    <div className={cn("flex items-center gap-0.5 opacity-70 hover:opacity-100", className)} role="group" aria-label="Rate this answer">
      {btn("explicit_up", "Helpful", ThumbsUp)}
      {btn("explicit_down", "Not helpful", ThumbsDown)}
    </div>
  );
}
