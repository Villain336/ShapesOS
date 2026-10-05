// Marketr — Phase 11 "Canvas": Comments panel (Feature 6). Workspace-internal
// comments: add, resolve/unresolve, delete (editors only for delete).
// The public share page renders these read-only.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  Circle,
  Loader2,
  MessageSquare,
  Send,
  Trash2,
} from "lucide-react";
import { panelTitle } from "../ui";
import { confirmAction } from "@/lib/ui/feedback";

interface Comment {
  id: string;
  authorName: string;
  body: string;
  elementId: string | null;
  x: number | null;
  y: number | null;
  resolved: boolean;
  createdAt: string;
}

export function CommentsPanel({ designId }: { designId: string }) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = `/api/studio/designs/${designId}/comments`;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(base);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { comments: Comment[] };
      setComments(data.comments);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load comments.");
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addComment = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { comment: Comment };
      setComments((prev) => [...prev, data.comment]);
      setDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not post comment.");
    } finally {
      setSending(false);
    }
  };

  const toggleResolved = async (c: Comment) => {
    try {
      const res = await fetch(`${base}/${c.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resolved: !c.resolved }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setComments((prev) =>
        prev.map((x) => (x.id === c.id ? { ...x, resolved: !x.resolved } : x)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update comment.");
    }
  };

  const deleteComment = async (c: Comment) => {
    const ok = await confirmAction({
      title: "Delete this comment?",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`${base}/${c.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setComments((prev) => prev.filter((x) => x.id !== c.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete comment.");
    }
  };

  const openCount = comments.filter((c) => !c.resolved).length;

  return (
    <div>
      <div className={panelTitle}>
        Comments{openCount > 0 && ` (${openCount} open)`}
      </div>
      <div className="space-y-3 px-3 pb-4">
        {error && (
          <p className="rounded-md border border-failed bg-failed-tint px-2.5 py-2 text-[12px] text-failed-text">
            {error}
          </p>
        )}
        {loading ? (
          <p className="flex items-center gap-2 text-[12px] text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading comments…
          </p>
        ) : comments.length === 0 ? (
          <div className="rounded-md border border-dashed border-line bg-canvas p-4 text-center">
            <MessageSquare className="mx-auto mb-1 h-5 w-5 text-subtle" />
            <p className="text-[12px] text-muted">
              No comments yet. Feedback from reviewers lands here.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {comments.map((c) => (
              <li
                key={c.id}
                className={`rounded-md border p-2.5 ${
                  c.resolved ? "border-line bg-canvas" : "border-line bg-paper"
                }`}
              >
                <div className="mb-1 flex items-center gap-1.5">
                  <span className="text-[12px] font-semibold text-ink">
                    {c.authorName}
                  </span>
                  <span className="text-[10px] text-subtle">
                    {new Date(c.createdAt).toLocaleDateString()}
                  </span>
                  <span className="ml-auto flex items-center gap-0.5">
                    <button
                      onClick={() => void toggleResolved(c)}
                      className={`rounded p-1 ${
                        c.resolved
                          ? "text-ink hover:bg-hover-paper"
                          : "text-subtle hover:bg-hover-paper hover:text-ink"
                      }`}
                      title={c.resolved ? "Reopen" : "Resolve"}
                    >
                      {c.resolved ? (
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      ) : (
                        <Circle className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <button
                      onClick={() => void deleteComment(c)}
                      className="rounded-full p-1 text-subtle hover:bg-failed-tint hover:text-failed-text"
                      title="Delete comment"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </div>
                <p
                  className={`whitespace-pre-wrap text-[12px] ${
                    c.resolved ? "text-subtle line-through" : "text-ink"
                  }`}
                >
                  {c.body}
                </p>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-start gap-1.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            placeholder="Add a comment…"
            className="min-w-0 flex-1 rounded-md border-[1.5px] border-control bg-paper px-2.5 py-1.5 text-[13px] text-ink focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none"
          />
          <button
            onClick={() => void addComment()}
            disabled={sending || !draft.trim()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-white aos-press disabled:opacity-40"
            title="Post comment"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
        </div>
        <p className="text-[11px] leading-snug text-subtle">
          Comments are visible to the workspace and read-only on public share links.
        </p>
      </div>
    </div>
  );
}
