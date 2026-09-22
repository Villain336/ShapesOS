// Marketr — competitor radar feed (milestone 14, client island).
"use client";

import { useState } from "react";

interface RadarEventItem {
  id: string;
  competitorDomain: string;
  eventType: string;
  keywordPhrase: string | null;
  details: Record<string, unknown>;
  detectedAt: string;
  read: boolean;
}

const TYPE_STYLE: Record<string, string> = {
  lost_to_competitor: "bg-red-500/15 text-red-700 border-red-200/30",
  new_keyword: "bg-accent/15 text-violet-700 border-violet-500/30",
  keyword_gain: "bg-amber-500/15 text-amber-700 border-amber-200/30",
  new_page: "bg-sky-100/15 text-sky-700 border-sky-200/30",
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
          className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-800"
        >
          <option value="all">All competitors</option>
          {competitors.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <button
          onClick={markAllRead}
          className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm text-zinc-500 hover:border-zinc-400"
        >
          Mark visible as read
        </button>
      </div>

      {visible.length === 0 ? (
        <div className="rounded-lg border border-zinc-300 bg-white p-8 text-center">
          <p className="text-lg">📡</p>
          <p className="mt-2 text-sm text-zinc-500">
            No radar events yet. The weekly radar needs at least two competitor snapshots — add competitors and wait for two runs.
          </p>
        </div>
      ) : (
        visible.map((e) => (
          <div key={e.id} className={`rounded-lg border p-4 ${e.read ? "border-zinc-200 bg-white/60" : "border-zinc-200 bg-white"}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded border px-2 py-0.5 text-xs font-medium ${TYPE_STYLE[e.eventType] ?? "border-zinc-200 text-zinc-500"}`}>
                {e.eventType.replace(/_/g, " ")}
              </span>
              {!e.read && <span className="text-xs text-sky-600">● new</span>}
              <span className="text-sm text-zinc-500">{e.competitorDomain}</span>
              <span className="ml-auto text-xs text-zinc-500">{e.detectedAt.slice(0, 10)}</span>
            </div>
            <p className="mt-2 text-sm font-medium text-zinc-900">
              {e.keywordPhrase ? `"${e.keywordPhrase}"` : "New ranking page"} <span className="font-normal text-zinc-500">— {detailLine(e)}</span>
            </p>
          </div>
        ))
      )}
    </div>
  );
}
