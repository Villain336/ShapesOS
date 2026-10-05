// Marketr — competitor radar feed (milestone 14, client island).
"use client";

import { useState } from "react";
import { Radio } from "lucide-react";

interface RadarEventItem {
  id: string;
  competitorDomain: string;
  eventType: string;
  keywordPhrase: string | null;
  details: Record<string, unknown>;
  detectedAt: string;
  read: boolean;
}

// Event types are categories, not agent states: neutral chips only.
const TYPE_STYLE: Record<string, string> = {
  lost_to_competitor: "bg-ink text-white",
  new_keyword: "bg-paper text-ink shadow-control",
  keyword_gain: "bg-paper text-ink shadow-control",
  new_page: "bg-canvas text-ink",
};

function detailLine(e: RadarEventItem): string {
  const d = e.details;
  switch (e.eventType) {
    case "lost_to_competitor":
      return `us #${String(d.ourPosition ?? "–")} vs them #${String(d.competitorPosition ?? "–")}`;
    case "keyword_gain":
      return `#${String(d.from ?? "?")} → #${String(d.to ?? "?")}${d.volume ? ` · ${d.volume} vol` : ""}`;
    case "new_keyword":
      return `#${String(d.position ?? "?")}${d.volume ? ` · ${d.volume} vol` : ""}`;
    case "new_page":
      return `${String(d.keywordCount ?? "?")} keywords · ${String(d.url ?? "").replace(/^https?:\/\//, "").slice(0, 50)}`;
    default:
      return "";
  }
}

export default function RadarFeed({
  projectId,
  initialEvents,
  competitors,
}: {
  projectId: string;
  initialEvents: RadarEventItem[];
  competitors: string[];
}) {
  const [events, setEvents] = useState(initialEvents);
  const [filter, setFilter] = useState<string>("all");

  const visible = events.filter((e) => filter === "all" || e.competitorDomain === filter);

  async function markAllRead() {
    const ids = visible.filter((e) => !e.read).map((e) => e.id);
    if (ids.length === 0) return;
    const res = await fetch("/api/radar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, eventIds: ids, action: "mark_read" }),
    });
    if (res.ok) setEvents((evs) => evs.map((e) => (ids.includes(e.id) ? { ...e, read: true } : e)));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="rounded-md border-[1.5px] border-control bg-paper px-3 py-1.5 text-sm text-ink"
        >
          <option value="all">All competitors</option>
          {competitors.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <button
          onClick={markAllRead}
          className="rounded-full bg-paper px-4 py-1.5 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-50"
        >
          Mark visible as read
        </button>
      </div>

      {visible.length === 0 ? (
        <div className="rounded-lg bg-paper shadow-hairline p-8 text-center">
          <Radio className="mx-auto h-6 w-6 text-muted" />
          <p className="mt-2 text-sm text-muted">
            No radar events yet. The weekly radar needs at least two competitor snapshots — add competitors and wait for two runs.
          </p>
        </div>
      ) : (
        visible.map((e) => (
          <div key={e.id} className={`rounded-lg border p-4 ${e.read ? "border-line bg-canvas" : "border-line bg-paper"}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${TYPE_STYLE[e.eventType] ?? "bg-canvas text-muted"}`}>
                {e.eventType.replace(/_/g, " ")}
              </span>
              {!e.read && <span className="text-xs font-semibold text-ink">● new</span>}
              <span className="text-sm text-muted">{e.competitorDomain}</span>
              <span className="ml-auto text-xs text-muted">{e.detectedAt.slice(0, 10)}</span>
            </div>
            <p className="mt-2 text-sm font-medium text-ink">
              {e.keywordPhrase ? `"${e.keywordPhrase}"` : "New ranking page"} <span className="font-normal text-muted">— {detailLine(e)}</span>
            </p>
          </div>
        ))
      )}
    </div>
  );
}
