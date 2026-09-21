// Marketr — internal-link suggestion list (milestone 15, client island).
// Apply/dismiss are supervised: apply opens a fix-agent inbox issue with the
// exact edit — nothing is auto-edited.

"use client";

import { useState } from "react";

interface Suggestion {
  id: string;
  sourceUrl: string;
  targetUrl: string;
  suggestedAnchor: string;
  reason: string;
  score: number;
  status: "pending" | "applied" | "dismissed";
  createdAt: string;
}

const REASON_STYLE: Record<string, string> = {
  orphan: "bg-red-500/15 text-red-300 border-red-500/30",
  high_value_underlinked: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  keyword_relevant: "bg-sky-500/15 text-sky-300 border-sky-500/30",
};

const REASON_LABEL: Record<string, string> = {
  orphan: "Orphan page",
  high_value_underlinked: "High-value, under-linked",
  keyword_relevant: "Keyword opportunity",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  applied: "Applied → inbox",
  dismissed: "Dismissed",
};

export default function InternalLinksList({
  projectId,
  initial,
}: {
  projectId: string;
  initial: Suggestion[];
}) {
  const [items, setItems] = useState(initial);
  const [statusFilter, setStatusFilter] = useState("pending");
  const [busy, setBusy] = useState<string | null>(null);

  const visible = items.filter((s) => (statusFilter === "all" ? true : s.status === statusFilter));

  async function act(ids: string[], action: "apply" | "dismiss") {
    if (ids.length === 0) return;
    setBusy(action);
    try {
      const res = await fetch("/api/internal-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, suggestionIds: ids, action }),
      });
      if (res.ok) {
        const next = action === "apply" ? "applied" : "dismissed";
        setItems((cur) => cur.map((s) => (ids.includes(s.id) ? { ...s, status: next as Suggestion["status"] } : s)));
      }
    } finally {
      setBusy(null);
    }
  }

  function shortUrl(u: string): string {
    return u.replace(/^https?:\/\//, "").replace(/^www\./, "").slice(0, 60);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200"
        >
          <option value="pending">Pending</option>
          <option value="applied">Applied</option>
          <option value="dismissed">Dismissed</option>
          <option value="all">All</option>
        </select>
        {statusFilter === "pending" && visible.length > 0 && (
          <button
            onClick={() => act(visible.map((s) => s.id), "dismiss")}
            disabled={busy !== null}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
          >
            Dismiss all shown
          </button>
        )}
      </div>

      {visible.length === 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-8 text-center text-sm text-zinc-500">
          {initial.length === 0
            ? "No suggestions yet — the weekly refresh builds them from your ranking data."
            : "Nothing in this view."}
        </div>
      )}

      {visible.map((s) => (
        <div key={s.id} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded border px-2 py-0.5 text-xs ${REASON_STYLE[s.reason] ?? "border-zinc-600 text-zinc-300"}`}>
              {REASON_LABEL[s.reason] ?? s.reason}
            </span>
            <span className="text-xs text-zinc-500">score {s.score}</span>
            <span className="text-xs text-zinc-600">· {STATUS_LABEL[s.status]}</span>
          </div>
          <div className="mt-2 text-sm">
            <span className="text-zinc-400">From</span>{" "}
            <span className="text-zinc-200" title={s.sourceUrl}>{shortUrl(s.sourceUrl)}</span>
          </div>
          <div className="mt-0.5 text-sm">
            <span className="text-zinc-400">To</span>{" "}
            <span className="text-zinc-200" title={s.targetUrl}>{shortUrl(s.targetUrl)}</span>{" "}
            <span className="text-zinc-500">with anchor</span>{" "}
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-medium text-zinc-100">“{s.suggestedAnchor}”</span>
          </div>
          {s.status === "pending" && (
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => act([s.id], "apply")}
                disabled={busy !== null}
                className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
              >
                {busy === "apply" ? "…" : "Apply → inbox"}
              </button>
              <button
                onClick={() => act([s.id], "dismiss")}
                disabled={busy !== null}
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
