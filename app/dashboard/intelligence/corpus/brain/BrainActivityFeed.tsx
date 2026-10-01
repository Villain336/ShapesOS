// Marketr — Knowledge Brain: corpus activity feed (Agentic OS).
//
// Real events only — proposals, removal flags, rebuild job history, manifest
// version bumps — fetched from /api/corpus/activity. No fabricated activity.
// Event categories are not agent states, so icons get a single neutral
// treatment.

"use client";

import { useEffect, useState } from "react";
import { Inbox, Flag, RefreshCw, Tag, Loader2, History } from "lucide-react";
import { btnGhost } from "./brain-ui";

export interface ActivityEvent {
  id: string;
  type: "proposal" | "removal-flag" | "rebuild" | "manifest";
  at: string;
  title: string;
  detail?: string;
  actor?: string;
}

const TYPE_ICON: Record<ActivityEvent["type"], React.ReactNode> = {
  proposal: <Inbox className="h-3.5 w-3.5" />,
  "removal-flag": <Flag className="h-3.5 w-3.5" />,
  rebuild: <RefreshCw className="h-3.5 w-3.5" />,
  manifest: <Tag className="h-3.5 w-3.5" />,
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function BrainActivityFeed({ refreshKey }: { refreshKey: number }) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/api/corpus/activity")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (!cancelled) {
          setEvents(d.events ?? []);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return (
    <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <History className="h-4 w-4 text-subtle" />
        <div className="text-sm font-semibold text-ink">Activity</div>
        <div className="text-[11px] text-subtle">what actually happened</div>
      </div>
      <div className="max-h-[420px] overflow-y-auto">
        {loading && (
          <div className="flex items-center gap-2 p-4 text-sm text-subtle">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading activity…
          </div>
        )}
        {error && (
          <div className="p-4">
            <p className="flex items-start gap-1.5 text-sm text-failed-text">
              <span className="aos-shape aos-shape--failed mt-1 shrink-0" style={{ "--aos-shape-size": "10px" } as React.CSSProperties} />
              Could not load activity ({error}).
            </p>
            <button onClick={() => location.reload()} className={`${btnGhost} mt-2`}>
              Retry
            </button>
          </div>
        )}
        {!loading && !error && events.length === 0 && (
          <p className="p-4 text-sm text-subtle">
            No corpus events yet — proposals, removal flags, and rebuilds will appear here.
          </p>
        )}
        {!loading && !error && events.length > 0 && (
          <ul className="divide-y divide-line">
            {events.map((e) => (
              <li key={e.id} className="flex gap-2.5 px-3 py-2">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-canvas text-muted">
                  {TYPE_ICON[e.type]}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">{e.title}</div>
                  {e.detail && (
                    <div className="truncate text-xs text-muted" title={e.detail}>
                      {e.detail}
                    </div>
                  )}
                  <div className="mt-0.5 text-[11px] text-subtle">
                    {timeAgo(e.at)}
                    {e.actor ? ` · ${e.actor}` : ""}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
