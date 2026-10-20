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

// Suggestion reasons are categories, not agent states: neutral chips only.
const REASON_STYLE: Record<string, string> = {
  orphan: "bg-ink text-white",
  high_value_underlinked: "bg-paper text-ink shadow-control",
  keyword_relevant: "bg-canvas text-ink",
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
          className="rounded-md border-[1.5px] border-control bg-paper px-3 py-1.5 text-sm text-ink"
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
            className="rounded-full bg-paper px-4 py-1.5 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-50"
          >
            Dismiss all shown
          </button>
        )}
      </div>

      {visible.length === 0 && (
        <div className="rounded-lg bg-paper shadow-hairline p-8 text-center text-sm text-muted">
          {initial.length === 0
            ? "No suggestions yet — the weekly refresh builds them from your ranking data."
            : "Nothing in this view."}
        </div>
      )}

      {visible.map((s) => (
        <div key={s.id} className="rounded-lg bg-paper shadow-hairline p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${REASON_STYLE[s.reason] ?? "bg-canvas text-muted"}`}>
              {REASON_LABEL[s.reason] ?? s.reason}
            </span>
            <span className="text-xs text-muted">score {s.score}</span>
            <span className="text-xs text-muted">· {STATUS_LABEL[s.status]}</span>
          </div>
          <div className="mt-2 text-sm">
            <span className="text-muted">From</span>{" "}
            <span className="text-ink" title={s.sourceUrl}>{shortUrl(s.sourceUrl)}</span>
          </div>
          <div className="mt-0.5 text-sm">
            <span className="text-muted">To</span>{" "}
            <span className="text-ink" title={s.targetUrl}>{shortUrl(s.targetUrl)}</span>{" "}
            <span className="text-muted">with anchor</span>{" "}
            <span className="rounded-key bg-canvas px-1.5 py-0.5 font-medium text-ink">“{s.suggestedAnchor}”</span>
          </div>
          {s.status === "pending" && (
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => act([s.id], "apply")}
                disabled={busy !== null}
                className="rounded-full bg-ink px-3 py-1.5 text-sm font-semibold text-white hover:bg-ink-hover disabled:opacity-50 aos-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                {busy === "apply" ? "…" : "Apply → inbox"}
              </button>
              <button
                onClick={() => act([s.id], "dismiss")}
                disabled={busy !== null}
                className="rounded-full bg-paper px-4 py-1.5 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-50"
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
