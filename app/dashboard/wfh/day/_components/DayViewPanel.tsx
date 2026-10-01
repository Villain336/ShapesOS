// Marketr — Wave 2 WFH mode slice 7: day-view panel (client).
// Sunsama-pattern timeline: focus blocks, standup, rituals, digests.

"use client";

import { useEffect, useState } from "react";
import { Loader2, Timer, MessagesSquare, PartyPopper, Bell } from "lucide-react";

interface TimelineItem {
  kind: "focus" | "standup" | "ritual" | "digest";
  startAt: string;
  endAt: string | null;
  title: string;
  detail: string | null;
  status: string;
}

interface DayView {
  date: string;
  mode: string;
  timeline: TimelineItem[];
  standup: { due: boolean; late: boolean; copy: string | null; submitted: boolean };
  focusCount: number;
  protectedMinutes: number;
}

// Timeline item states are workflow states, not agent states — neutrals only.
const chip =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-muted shadow-control";

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function fmtDate(iso: string) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function kindIcon(kind: TimelineItem["kind"]) {
  if (kind === "focus") return <Timer className="h-4 w-4 text-ink" />;
  if (kind === "standup") return <MessagesSquare className="h-4 w-4 text-ink" />;
  if (kind === "ritual") return <PartyPopper className="h-4 w-4 text-ink" />;
  return <Bell className="h-4 w-4 text-muted" />;
}

function statusChip(item: TimelineItem) {
  return <span className={chip}>{item.status}</span>;
}

export default function DayViewPanel() {
  const [day, setDay] = useState<DayView | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/wfh/day")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.day) setDay(d.day);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  if (!loaded) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Planning your day…
      </div>
    );
  }

  if (!day) {
    return <p className="text-sm text-muted">Could not load the day view.</p>;
  }

  return (
    <div className="space-y-4">
      {/* Day header stats */}
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="aos-subheading">{fmtDate(day.date)}</h2>
        <span className={chip}>
          mode: {day.mode}
        </span>
        <span className={chip}>
          {day.focusCount} focus block{day.focusCount === 1 ? "" : "s"}
        </span>
        <span className={chip}>
          {Math.floor(day.protectedMinutes / 60)}h {day.protectedMinutes % 60}m protected
        </span>
      </div>

      {day.standup.copy && !day.standup.submitted && (
        <div className="flex items-start gap-2 rounded-lg bg-paper px-3 py-2.5 shadow-hairline">
          <MessagesSquare className="mt-0.5 h-4 w-4 shrink-0 text-ink" aria-hidden="true" />
          <p className="text-sm text-muted">{day.standup.copy}</p>
        </div>
      )}

      {/* Timeline */}
      <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
        <div className="border-b border-line px-4 py-2.5">
          <h2 className="text-sm font-semibold text-ink">
            Timeline <span className="font-normal text-muted">({day.timeline.length})</span>
          </h2>
        </div>
        {day.timeline.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted">
            Nothing planned today. Add a focus block to defend some deep work.
          </p>
        ) : (
          <ul>
            {day.timeline.map((t, i) => (
              <li key={`${t.kind}-${t.startAt}-${i}`} className="flex items-start gap-3 border-b border-line px-4 py-3 last:border-0 hover:bg-hover-paper">
                <div className="mt-0.5 w-14 shrink-0 text-xs font-medium text-muted">
                  {fmtTime(t.startAt)}
                </div>
                <div className="mt-0.5 shrink-0">{kindIcon(t.kind)}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-ink">{t.title}</p>
                    {statusChip(t)}
                  </div>
                  {t.detail && <p className="mt-0.5 text-xs text-muted">{t.detail}</p>}
                  {t.endAt && (
                    <p className="text-xs text-subtle">
                      {fmtTime(t.startAt)} – {fmtTime(t.endAt)}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
