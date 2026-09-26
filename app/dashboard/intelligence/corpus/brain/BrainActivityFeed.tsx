// Marketr — Knowledge Brain: corpus activity feed.
//
// Real events only — proposals, removal flags, rebuild job history, manifest
// version bumps — fetched from /api/corpus/activity. No fabricated activity.

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

const TYPE_STYLE: Record<ActivityEvent["type"], { icon: React.ReactNode; tone: string }> = {
  proposal: {
    icon: <Inbox className="h-3.5 w-3.5" />,
    tone: "text-violet-600 bg-violet-50 border-violet-200",
  },
  "removal-flag": {
    icon: <Flag className="h-3.5 w-3.5" />,
    tone: "text-red-600 bg-red-50 border-red-200",
  },
  rebuild: {
    icon: <RefreshCw className="h-3.5 w-3.5" />,
    tone: "text-sky-700 bg-sky-50 border-sky-200",
  },
  manifest: {
    icon: <Tag className="h-3.5 w-3.5" />,
    tone: "text-stone-500 bg-stone-50 border-stone-200",
  },
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
    <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
      <div className="flex items-center gap-2 border-b border-stone-100 px-3 py-2">
        <History className="h-4 w-4 text-stone-400" />
        <div className="text-[13px] font-semibold text-stone-900">Activity</div>
        <div className="text-[11px] text-stone-400">what actually happened</div>
      </div>
      <div className="max-h-[420px] overflow-y-auto">
        {loading && (
          <div className="flex items-center gap-2 p-4 text-[13px] text-stone-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading activity…
          </div>
        )}
        {error && (
          <div className="p-4">
            <p className="text-[13px] text-red-600">Could not load activity ({error}).</p>
            <button onClick={() => location.reload()} className={btnGhost}>
              Retry
            </button>
          </div>
        )}
        {!loading && !error && events.length === 0 && (
          <p className="p-4 text-[13px] text-stone-400">
            No corpus events yet — proposals, removal flags, and rebuilds will appear here.
          </p>
        )}
        {!loading && !error && events.length > 0 && (
          <ul className="divide-y divide-stone-100">
            {events.map((e) => {
              const st = TYPE_STYLE[e.type];
              return (
                <li key={e.id} className="flex gap-2.5 px-3 py-2">
                  <span
                    className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border ${st.tone}`}
                  >
                    {st.icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-stone-900">{e.title}</div>
                    {e.detail && (
                      <div className="truncate text-[12px] text-stone-500" title={e.detail}>
                        {e.detail}
                      </div>
                    )}
                    <div className="mt-0.5 text-[11px] text-stone-400">
                      {timeAgo(e.at)}
                      {e.actor ? ` · ${e.actor}` : ""}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
