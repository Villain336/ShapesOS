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
          <p className="rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-[12px] text-red-700">
            {error}
          </p>
        )}
        {loading ? (
          <p className="flex items-center gap-2 text-[12px] text-stone-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading comments…
          </p>
        ) : comments.length === 0 ? (
          <div className="rounded-md border border-dashed border-stone-300 p-4 text-center">
            <MessageSquare className="mx-auto mb-1 h-5 w-5 text-stone-300" />
            <p className="text-[12px] text-stone-500">
              No comments yet. Feedback from reviewers lands here.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {comments.map((c) => (
              <li
                key={c.id}
                className={`rounded-md border p-2.5 ${
                  c.resolved ? "border-stone-100 bg-stone-50" : "border-stone-200 bg-white"
                }`}
              >
                <div className="mb-1 flex items-center gap-1.5">
                  <span className="text-[12px] font-semibold text-stone-800">
                    {c.authorName}
                  </span>
                  <span className="text-[10px] text-stone-400">
                    {new Date(c.createdAt).toLocaleDateString()}
                  </span>
                  <span className="ml-auto flex items-center gap-0.5">
                    <button
                      onClick={() => void toggleResolved(c)}
                      className={`rounded p-1 ${
                        c.resolved
                          ? "text-emerald-600 hover:bg-emerald-50"
                          : "text-stone-400 hover:bg-stone-100 hover:text-emerald-600"
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
                      className="rounded p-1 text-stone-400 hover:bg-red-50 hover:text-red-600"
                      title="Delete comment"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </div>
                <p
                  className={`whitespace-pre-wrap text-[12px] ${
                    c.resolved ? "text-stone-400 line-through" : "text-stone-700"
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
            className="min-w-0 flex-1 rounded-md border border-stone-200 px-2.5 py-1.5 text-[13px] focus:border-violet-400 focus:outline-none"
          />
          <button
            onClick={() => void addComment()}
            disabled={sending || !draft.trim()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40"
            title="Post comment"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
        </div>
        <p className="text-[11px] leading-snug text-stone-400">
          Comments are visible to the workspace and read-only on public share links.
        </p>
      </div>
    </div>
  );
}
