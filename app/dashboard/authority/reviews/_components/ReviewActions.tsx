// Marketr — R1 review queue action buttons (client).
// Approve/sign (two-person) and post-to-GBP via the authority API.

"use client";

import { useState } from "react";
import { confirmAction } from "@/lib/ui/feedback";

export function ApproveButton({ id, draftReply }: { id: string; draftReply: string | null }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function act() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`/api/authority/reviews/${id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draftReply: draftReply ?? undefined }),
      });
      const data = (await res.json()) as { error?: string; needsSecondApprover?: boolean; approval?: { status: string } };
      if (!res.ok) throw new Error(data.error ?? "Approval failed");
      setResult(
        data.needsSecondApprover
          ? "Signed (1 of 2) — awaiting a second distinct approver."
          : `Approved (${data.approval?.status ?? "approved"}). Ready to post.`,
      );
    } catch (e) {
      setResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={act}
        disabled={busy}
        className="inline-flex h-control-sm items-center gap-1.5 rounded-full bg-done px-4 text-sm font-semibold text-white aos-press hover:bg-done/90 disabled:opacity-40"
      >
        {busy ? "Signing…" : "Approve / sign"}
      </button>
      {result && <span className="text-xs text-muted">{result}</span>}
    </span>
  );
}

export function PostButton({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function act() {
    if (!await confirmAction("Post this reply to Google Business Profile? It enters pre-publication moderation.")) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`/api/authority/reviews/${id}/post`, { method: "POST" });
      const data = (await res.json()) as { error?: string; replyState?: string };
      if (!res.ok) throw new Error(data.error ?? "Post failed");
      setResult(`Posted — moderation state: ${data.replyState ?? "PENDING"}. Poll for APPROVED.`);
    } catch (e) {
      setResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={act}
        disabled={busy}
        className="inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40"
      >
        {busy ? "Posting…" : "Post to GBP"}
      </button>
      {result && <span className="text-xs text-muted">{result}</span>}
    </span>
  );
}
