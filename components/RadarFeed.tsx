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
  lost_to_competitor: "bg-red-500/15 text-red-300 border-red-500/30",
  new_keyword: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  keyword_gain: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  new_page: "bg-sky-500/15 text-sky-300 border-sky-500/30",
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
          className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200"
        >
          <option value="all">All competitors</option>
          {competitors.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <button
          onClick={markAllRead}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-500"
        >
          Mark visible as read
        </button>
      </div>

      {visible.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center">
          <p className="text-lg">📡</p>
          <p className="mt-2 text-sm text-zinc-400">
            No radar events yet. The weekly radar needs at least two competitor snapshots — add competitors and wait for two runs.
          </p>
        </div>
      ) : (
        visible.map((e) => (
          <div key={e.id} className={`rounded-lg border p-4 ${e.read ? "border-zinc-800 bg-zinc-900/60" : "border-zinc-700 bg-zinc-900"}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded border px-2 py-0.5 text-xs font-medium ${TYPE_STYLE[e.eventType] ?? "border-zinc-700 text-zinc-300"}`}>
                {e.eventType.replace(/_/g, " ")}
              </span>
              {!e.read && <span className="text-xs text-sky-400">● new</span>}
              <span className="text-sm text-zinc-400">{e.competitorDomain}</span>
              <span className="ml-auto text-xs text-zinc-500">{e.detectedAt.slice(0, 10)}</span>
            </div>
            <p className="mt-2 text-sm font-medium text-zinc-100">
              {e.keywordPhrase ? `"${e.keywordPhrase}"` : "New ranking page"} <span className="font-normal text-zinc-400">— {detailLine(e)}</span>
            </p>
          </div>
        ))
      )}
    </div>
  );
}
