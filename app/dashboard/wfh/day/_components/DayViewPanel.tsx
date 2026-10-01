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

const chip =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight";

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
  if (kind === "focus") return <Timer className="h-4 w-4 text-[var(--brand-600)]" />;
  if (kind === "standup") return <MessagesSquare className="h-4 w-4 text-sky-600" />;
  if (kind === "ritual") return <PartyPopper className="h-4 w-4 text-amber-600" />;
  return <Bell className="h-4 w-4 text-stone-500" />;
}

function statusChip(item: TimelineItem) {
  const base = chip;
  if (item.status === "done") return <span className={`${base} border-emerald-200 bg-emerald-50 text-emerald-700`}>{item.status}</span>;
  if (item.status === "late") return <span className={`${base} border-red-200 bg-red-50 text-red-700`}>{item.status}</span>;
  if (item.status === "due" || item.status === "ready") return <span className={`${base} border-amber-200 bg-amber-50 text-amber-700`}>{item.status}</span>;
  if (item.status === "overridden") return <span className={`${base} border-amber-200 bg-amber-50 text-amber-700`}>{item.status}</span>;
  if (item.status === "protected") return <span className={`${base} border-[var(--brand-600)]/20 bg-[var(--brand-50)] text-[var(--brand-700)]`}>{item.status}</span>;
  return <span className={`${base} border-stone-200 bg-stone-100 text-stone-500`}>{item.status}</span>;
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
      <div className="flex items-center gap-2 text-[13px] text-stone-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Planning your day…
      </div>
    );
  }

  if (!day) {
    return <p className="text-[13px] text-stone-500">Could not load the day view.</p>;
  }

  return (
    <div className="space-y-4">
      {/* Day header stats */}
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-[15px] font-semibold text-stone-900">{fmtDate(day.date)}</h2>
        <span className={`${chip} border-[var(--brand-600)]/20 bg-[var(--brand-50)] text-[var(--brand-700)]`}>
          mode: {day.mode}
        </span>
        <span className={`${chip} border-stone-200 bg-stone-100 text-stone-600`}>
          {day.focusCount} focus block{day.focusCount === 1 ? "" : "s"}
        </span>
        <span className={`${chip} border-stone-200 bg-stone-100 text-stone-600`}>
          {Math.floor(day.protectedMinutes / 60)}h {day.protectedMinutes % 60}m protected
        </span>
      </div>

      {day.standup.copy && !day.standup.submitted && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-[13px] text-amber-800">
          {day.standup.copy}
        </div>
      )}

      {/* Timeline */}
      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
        <div className="border-b border-stone-200 px-4 py-2.5">
          <h2 className="text-[13px] font-semibold text-stone-900">
            Timeline <span className="font-normal text-stone-500">({day.timeline.length})</span>
          </h2>
        </div>
        {day.timeline.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-stone-500">
            Nothing planned today. Add a focus block to defend some deep work.
          </p>
        ) : (
          <ul>
            {day.timeline.map((t, i) => (
              <li key={`${t.kind}-${t.startAt}-${i}`} className="flex items-start gap-3 border-b border-stone-100 px-4 py-3 last:border-0 hover:bg-[var(--brand-50)]/40">
                <div className="mt-0.5 w-14 shrink-0 text-[12px] font-medium text-stone-500">
                  {fmtTime(t.startAt)}
                </div>
                <div className="mt-0.5 shrink-0">{kindIcon(t.kind)}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-[13px] font-medium text-stone-900">{t.title}</p>
                    {statusChip(t)}
                  </div>
                  {t.detail && <p className="mt-0.5 text-[12px] text-stone-500">{t.detail}</p>}
                  {t.endAt && (
                    <p className="text-[11px] text-stone-400">
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
