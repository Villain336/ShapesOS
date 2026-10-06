"use client";

// ShapesOS — Phase 18.2 (WS=comms): the Calendar app (/dashboard/calendar).
// Month / week / day over the member's own connected calendars plus the
// ShapesOS lanes (bookings, focus blocks, events, scheduled posts,
// reminders, calls — lib/comms/calendar/sources.server.ts), in the member's
// time zone. New events go to their own calendar through the connector's
// create_event; "Find time" proposes free slots; "Subscribe" makes a private
// ICS feed. Events are neutral ink-on-paper blocks — status colours belong to
// agent states only (DESIGN.md).

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AlarmClock,
  CalendarCheck,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Focus,
  Loader2,
  Plus,
  Rss,
  Search,
  Share2,
  Ticket,
  Video,
  type LucideIcon,
} from "lucide-react";
import { useI18n } from "@/components/i18n/I18nProvider";
import { aosButton } from "@/components/aos/button";
import { Segmented } from "@/components/aos/Controls";
import { FilterPill } from "@/components/aos/FilterPill";
import { cn } from "@/lib/utils";
import { deviceTimeZone, isoToWall, wallToIso } from "@/lib/comms/time";
import { localYmd, placeDay, shiftAnchor, viewDays, viewWindow, weekdayOf, type CalendarView } from "@/lib/comms/calendar/grid";
import { Card, Chip, ErrorLine, iconBtnCls, inputCls, labelCls, MockChip, Note, PageHeader, textareaCls } from "./ui";
import { Modal } from "./Modal";

type Source = "google" | "outlook" | "booking" | "focus" | "ops_event" | "social" | "reminder" | "meeting";
const SOURCES: Source[] = ["google", "outlook", "booking", "focus", "ops_event", "social", "reminder", "meeting"];

interface CalEvent {
  id: string;
  source: Source;
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  location: string | null;
  attendees: string[];
  href: string | null;
  externalUrl: string | null;
  editable: boolean;
  connectionId: string | null;
  externalId: string | null;
  mock: boolean;
}

interface Load {
  events: CalEvent[];
  connections: { id: string; key: "google-calendar" | "outlook-calendar"; account: string | null }[];
  errors: { source: string; message: string }[];
  timeZone: string;
}

const ICONS: Record<Source, LucideIcon> = {
  google: CalendarDays,
  outlook: CalendarDays,
  booking: CalendarCheck,
  focus: Focus,
  ops_event: Ticket,
  social: Share2,
  reminder: AlarmClock,
  meeting: Video,
};

const HOUR_PX = 48;

async function readError(res: Response): Promise<string> {
  try {
    return ((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function blockCls(e: CalEvent): string {
  // Connected calendars: an ink edge; ShapesOS lanes: paper with a hairline. Never a status colour.
  return e.source === "google" || e.source === "outlook"
    ? "bg-paper text-ink shadow-[inset_3px_0_0_var(--aos-ink),0_0_0_1px_var(--aos-line-strong)]"
    : "bg-canvas text-ink shadow-[inset_0_0_0_1px_var(--aos-line-strong)]";
}

export function CalendarApp({ initialView = "week", canCall = true }: { initialView?: CalendarView; canCall?: boolean }) {
  const { t, ctx, locale } = useI18n();
  const tz = ctx.timeZone ?? deviceTimeZone();
  const [view, setView] = useState<CalendarView>(initialView);
  const [anchor, setAnchor] = useState(() => localYmd(new Date(), tz));
  const [data, setData] = useState<Load | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<Source>>(new Set());
  const [selected, setSelected] = useState<CalEvent | null>(null);
  const [composer, setComposer] = useState<{ start: string; end: string } | null>(null);
  const [finding, setFinding] = useState(false);
  const [feeds, setFeeds] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const days = useMemo(() => viewDays(view, anchor), [view, anchor]);
  const load = useCallback(async () => {
    setLoading(true);
    const { from, to } = viewWindow(view, anchor, tz);
    try {
      const res = await fetch(`/api/comms/calendar/events?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`, { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res));
      setData((await res.json()) as Load);
      setError(null);
    } catch (e) {
      setError(t("comms.common.loadError", { error: e instanceof Error ? e.message : "" }));
    } finally {
      setLoading(false);
    }
  }, [view, anchor, tz, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const events = (data?.events ?? []).filter((e) => !hidden.has(e.source));
  const today = localYmd(new Date(), tz);
  const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale === "es" ? "es-ES" : "en-US", { timeZone: tz, ...opts });
  const dayLabel = (ymd: string, opts: Intl.DateTimeFormatOptions) => fmt({ ...opts, timeZone: "UTC" }).format(new Date(`${ymd}T12:00:00Z`));
  const time = (iso: string) => fmt({ hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  const rangeLabel =
    view === "month"
      ? dayLabel(anchor, { month: "long", year: "numeric" })
      : view === "week"
        ? `${dayLabel(days[0]!, { month: "short", day: "numeric" })} – ${dayLabel(days[6]!, { month: "short", day: "numeric", year: "numeric" })}`
        : dayLabel(anchor, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const counts = useMemo(() => {
    const c = new Map<Source, number>();
    for (const e of data?.events ?? []) c.set(e.source, (c.get(e.source) ?? 0) + 1);
    return c;
  }, [data]);
  const hasMock = (data?.events ?? []).some((e) => e.mock);
  const sourceName = (s: Source) => t(`comms.calendar.sources.${s}`);

  const openComposer = (start?: Date) => {
    const s = start ?? new Date(Math.ceil(Date.now() / (30 * 60_000)) * 30 * 60_000);
    setComposer({ start: isoToWall(s, tz), end: isoToWall(new Date(s.getTime() + 30 * 60_000), tz) });
  };

  const eventChip = (e: CalEvent, compact = false) => {
    const Icon = ICONS[e.source];
    return (
      <button
        key={e.id}
        type="button"
        onClick={() => setSelected(e)}
        className={cn("flex w-full min-w-0 items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-left text-xs font-semibold hover:bg-hover", blockCls(e))}
        aria-label={`${e.title || t("comms.common.noTitle")}, ${e.allDay ? t("comms.calendar.allDay") : time(e.start)}, ${sourceName(e.source)}`}
      >
        <Icon className="size-3 shrink-0" aria-hidden />
        {!compact && !e.allDay ? <span className="shrink-0 tabular-nums text-muted">{time(e.start)}</span> : null}
        <span className="truncate">{e.title || t("comms.common.noTitle")}</span>
      </button>
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-4">
      <PageHeader
        title={t("comms.calendar.title")}
        subtitle={t("comms.calendar.subtitle")}
        actions={
          <>
            <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} onClick={() => setFeeds(true)}>
              <Rss className="size-4" aria-hidden />
              {t("comms.calendar.subscribe")}
            </button>
            <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} onClick={() => setFinding(true)}>
              <Search className="size-4" aria-hidden />
              {t("comms.calendar.findTime")}
            </button>
            <button type="button" className={aosButton({ variant: "primary", size: "sm" })} onClick={() => openComposer()}>
              <Plus className="size-4" aria-hidden />
              {t("comms.calendar.newEvent")}
            </button>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} onClick={() => setAnchor(today)}>
          {t("comms.calendar.today")}
        </button>
        <button type="button" className={iconBtnCls} aria-label={t("comms.calendar.previous")} onClick={() => setAnchor((a) => shiftAnchor(view, a, -1))}>
          <ChevronLeft className="size-4" aria-hidden />
        </button>
        <button type="button" className={iconBtnCls} aria-label={t("comms.calendar.next")} onClick={() => setAnchor((a) => shiftAnchor(view, a, 1))}>
          <ChevronRight className="size-4" aria-hidden />
        </button>
        <h2 className="aos-subheading min-w-0 flex-1 truncate text-ink" aria-live="polite">
          {rangeLabel}
        </h2>
        {loading ? <Loader2 className="size-4 animate-spin text-muted" aria-label={t("comms.calendar.loadingEvents")} /> : null}
        <Segmented<CalendarView>
          label={t("comms.calendar.view")}
          value={view}
          onChange={setView}
          options={[
            { value: "month", label: t("comms.calendar.month") },
            { value: "week", label: t("comms.calendar.week") },
            { value: "day", label: t("comms.calendar.day") },
          ]}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("comms.calendar.lanes")}>
        {SOURCES.filter((s) => counts.get(s) || ((s === "google" || s === "outlook") && data?.connections.some((c) => (c.key === "google-calendar") === (s === "google")))).map((s) => (
          <FilterPill
            key={s}
            selected={!hidden.has(s)}
            count={counts.get(s) ?? 0}
            onClick={() =>
              setHidden((h) => {
                const n = new Set(h);
                if (n.has(s)) n.delete(s);
                else n.add(s);
                return n;
              })
            }
          >
            {sourceName(s)}
          </FilterPill>
        ))}
        <span className="ml-auto text-xs text-muted">{t("comms.calendar.timezoneNote", { tz })}</span>
      </div>
      <ErrorLine message={error} />
      {data?.errors.map((e) => <ErrorLine key={e.source} message={t("comms.calendar.calendarError", { source: e.source, error: e.message })} />)}
      {data && data.connections.length === 0 ? (
        <Note action={<Link href="/dashboard/settings/connectors" className={aosButton({ variant: "secondary", size: "sm" })}>{t("comms.calendar.connectCalendar")}</Link>}>
          <span className="font-semibold text-ink">{t("comms.calendar.noCalendarTitle")}.</span> {t("comms.calendar.noCalendarBody")}
        </Note>
      ) : null}
      {hasMock ? (
        <Note action={<MockChip label={t("comms.common.mock")} />}>{t("comms.calendar.mockNote")}</Note>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm font-semibold text-ink">
          {notice}
        </p>
      ) : null}

      {view === "month" ? (
        <Card className="overflow-hidden">
          <div className="grid grid-cols-7 border-b border-line" aria-hidden>
            {days.slice(0, 7).map((d) => (
              <div key={d} className="px-2 py-1.5 text-xs font-semibold text-muted">
                {dayLabel(d, { weekday: "short" })}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7" role="grid" aria-label={rangeLabel}>
            {days.map((d) => {
              const list = events.filter((e) => localYmd(e.start, tz) === d);
              const inMonth = d.slice(0, 7) === anchor.slice(0, 7);
              return (
                <div key={d} role="gridcell" className={cn("min-h-[104px] min-w-0 border-r border-b border-line p-1.5", !inMonth && "bg-canvas")}>
                  <button
                    type="button"
                    onClick={() => {
                      setAnchor(d);
                      setView("day");
                    }}
                    className={cn("mb-1 inline-flex size-7 items-center justify-center rounded-full text-xs font-semibold tabular-nums hover:bg-hover", d === today ? "bg-ink text-paper hover:bg-ink-hover" : inMonth ? "text-ink" : "text-muted")}
                    aria-label={dayLabel(d, { weekday: "long", month: "long", day: "numeric" })}
                  >
                    {Number(d.slice(8))}
                  </button>
                  <div className="flex flex-col gap-0.5">
                    {list.slice(0, 3).map((e) => eventChip(e, true))}
                    {list.length > 3 ? (
                      <button
                        type="button"
                        className="px-1.5 text-left text-xs font-semibold text-muted hover:text-ink"
                        onClick={() => {
                          setAnchor(d);
                          setView("day");
                        }}
                      >
                        {t("comms.calendar.moreCount", { count: list.length - 3 })}
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="grid border-b border-line" style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` }}>
            <div />
            {days.map((d) => (
              <div key={d} className="min-w-0 border-l border-line px-2 py-1.5">
                <p className={cn("text-xs font-semibold", d === today ? "text-ink" : "text-muted")}>{dayLabel(d, { weekday: "short", day: "numeric" })}</p>
                <div className="mt-1 flex flex-col gap-0.5">
                  {events
                    .filter((e) => (e.allDay || (e.end && new Date(e.end).getTime() - new Date(e.start).getTime() >= 86_400_000)) && localYmd(e.start, tz) <= d && localYmd(e.end ?? e.start, tz) >= d && !(e.allDay && e.end && localYmd(e.end, tz) === d && d !== localYmd(e.start, tz)))
                    .map((e) => eventChip(e, true))}
                </div>
              </div>
            ))}
          </div>
          <div className="relative max-h-[640px] overflow-y-auto" ref={(el) => {
            if (el && !el.dataset.scrolled) {
              el.scrollTop = 7 * HOUR_PX;
              el.dataset.scrolled = "1";
            }
          }}>
            <div className="grid" style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))`, height: 24 * HOUR_PX }}>
              <div className="relative">
                {Array.from({ length: 24 }, (_, h) => (
                  <span key={h} className="absolute right-2 -translate-y-1/2 text-xs text-muted tabular-nums" style={{ top: h * HOUR_PX }}>
                    {h === 0 ? "" : fmt({ hour: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 1, h)))}
                  </span>
                ))}
              </div>
              {days.map((d) => {
                const timed = events.filter((e) => !e.allDay && !(e.end && new Date(e.end).getTime() - new Date(e.start).getTime() >= 86_400_000) && localYmd(e.start, tz) === d);
                const placed = placeDay(timed, d, tz);
                return (
                  <div
                    key={d}
                    className={cn("relative border-l border-line", weekdayOf(d) === 0 || weekdayOf(d) === 6 ? "bg-canvas/60" : "")}
                  >
                    {Array.from({ length: 23 }, (_, h) => (
                      <span key={h} aria-hidden className="pointer-events-none absolute inset-x-0 border-t border-line" style={{ top: (h + 1) * HOUR_PX }} />
                    ))}
                    <button
                      type="button"
                      className="absolute inset-0 cursor-cell"
                      aria-label={`${t("comms.calendar.newEvent")}: ${dayLabel(d, { weekday: "long", month: "long", day: "numeric" })}`}
                      onClick={(ev) => {
                        const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                        const minutes = Math.max(0, Math.min(23 * 60 + 30, Math.floor(((ev.clientY - rect.top) / HOUR_PX) * 2) * 30));
                        const iso = wallToIso(`${d}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`, tz);
                        openComposer(iso ? new Date(iso) : undefined);
                      }}
                    />
                    {placed.map((e) => {
                      const Icon = ICONS[e.source];
                      return (
                        <button
                          key={e.id}
                          type="button"
                          onClick={() => setSelected(e)}
                          className={cn("absolute min-h-6 overflow-hidden rounded-sm px-1.5 py-0.5 text-left text-xs hover:z-10", blockCls(e))}
                          style={{ top: (e.top / 60) * HOUR_PX, height: Math.max(18, (e.height / 60) * HOUR_PX - 2), left: `calc(${(e.lane / e.lanes) * 100}% + 2px)`, width: `calc(${100 / e.lanes}% - 4px)` }}
                          aria-label={`${e.title || t("comms.common.noTitle")}, ${time(e.start)}${e.end ? `–${time(e.end)}` : ""}, ${sourceName(e.source)}`}
                        >
                          <span className="flex items-center gap-1 font-semibold">
                            <Icon className="size-3 shrink-0" aria-hidden />
                            <span className="truncate">{e.title || t("comms.common.noTitle")}</span>
                          </span>
                          {e.height >= 40 ? <span className="block truncate text-muted tabular-nums">{time(e.start)}{e.end ? ` – ${time(e.end)}` : ""}</span> : null}
                          {e.mock ? <span className="mt-0.5 block text-[0.6875rem] font-semibold text-muted">{t("comms.common.mock")}</span> : null}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </Card>
      )}

      <EventDetail event={selected} onClose={() => setSelected(null)} time={time} sourceName={sourceName} canCall={canCall} />
      <EventComposer
        open={!!composer}
        initial={composer}
        connections={data?.connections ?? []}
        tz={tz}
        onClose={() => setComposer(null)}
        onSaved={(mock) => {
          setComposer(null);
          setNotice(mock ? t("comms.calendar.createdMock") : t("comms.calendar.created"));
          void load();
        }}
      />
      <FindTime
        open={finding}
        tz={tz}
        onClose={() => setFinding(false)}
        onUse={(start, end) => {
          setFinding(false);
          setComposer({ start: isoToWall(start, tz), end: isoToWall(end, tz) });
        }}
      />
      <Feeds open={feeds} onClose={() => setFeeds(false)} />
    </div>
  );
}

function EventDetail({ event: e, onClose, time, sourceName, canCall }: { event: CalEvent | null; onClose: () => void; time: (iso: string) => string; sourceName: (s: Source) => string; canCall: boolean }) {
  const { t, format } = useI18n();
  if (!e) return null;
  const callHref = `/dashboard/meet?title=${encodeURIComponent(e.title || "Call")}&origin=calendar&ref=${encodeURIComponent(e.id)}`;
  return (
    <Modal open={!!e} onOpenChange={(o) => !o && onClose()} title={e.title || t("comms.common.noTitle")} closeLabel={t("common.close")}>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        <dt className="font-semibold text-ink">{t("comms.calendar.when")}</dt>
        <dd className="text-muted">
          {e.allDay ? `${format.date(e.start, "date")} · ${t("comms.calendar.allDay")}` : `${format.date(e.start, "date")} · ${time(e.start)}${e.end ? ` – ${time(e.end)}` : ""}`}
        </dd>
        <dt className="font-semibold text-ink">{t("comms.calendar.source")}</dt>
        <dd className="flex flex-wrap items-center gap-1.5 text-muted">
          {sourceName(e.source)}
          {e.mock ? <MockChip label={t("comms.common.mock")} /> : null}
        </dd>
        {e.location ? (
          <>
            <dt className="font-semibold text-ink">{t("comms.calendar.where")}</dt>
            <dd className="break-words text-muted">{e.location}</dd>
          </>
        ) : null}
        {e.attendees.length ? (
          <>
            <dt className="font-semibold text-ink">{t("comms.calendar.who")}</dt>
            <dd className="flex flex-wrap gap-1">
              {e.attendees.map((a) => (
                <Chip key={a}>{a}</Chip>
              ))}
            </dd>
          </>
        ) : null}
      </dl>
      {!e.editable ? <p className="mt-3 text-sm text-muted">{t("comms.calendar.readOnly")}</p> : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {e.href ? (
          <Link href={e.href} className={aosButton({ variant: "secondary", size: "sm" })}>
            {t("comms.calendar.open")}
          </Link>
        ) : null}
        {e.externalUrl ? (
          <a href={e.externalUrl} target="_blank" rel="noreferrer" className={aosButton({ variant: "secondary", size: "sm" })}>
            <ExternalLink className="size-4" aria-hidden />
            {t("comms.calendar.openIn", { source: sourceName(e.source) })}
          </a>
        ) : null}
        <a href={`/api/comms/calendar/ics?id=${encodeURIComponent(e.id)}&at=${encodeURIComponent(e.start)}`} className={aosButton({ variant: "secondary", size: "sm" })}>
          <Download className="size-4" aria-hidden />
          {t("comms.calendar.downloadIcs")}
        </a>
        {canCall ? (
          <Link href={callHref} className={aosButton({ variant: "primary", size: "sm" })}>
            <Video className="size-4" aria-hidden />
            {t("comms.calendar.startCall")}
          </Link>
        ) : null}
      </div>
    </Modal>
  );
}

function EventComposer({
  open,
  initial,
  connections,
  tz,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial: { start: string; end: string } | null;
  connections: Load["connections"];
  tz: string;
  onClose: () => void;
  onSaved: (mock: boolean) => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [attendees, setAttendees] = useState("");
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [notify, setNotify] = useState(true);
  const [connectionId, setConnectionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !initial) return;
    setStart(initial.start);
    setEnd(initial.end);
    setTitle("");
    setAttendees("");
    setLocation("");
    setDescription("");
    setError(null);
    setConnectionId((c) => c || connections[0]?.id || "");
  }, [open, initial, connections]);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    const s = wallToIso(start, tz);
    const e = wallToIso(end, tz);
    if (!s || !e || e <= s) {
      setError(t("comms.calendar.endBeforeStart"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/comms/calendar/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId, title: title.trim(), start: s, end: e, timeZone: tz, attendees: attendees.trim() || undefined, location: location.trim() || undefined, description: description.trim() || undefined, notifyAttendees: notify }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const j = (await res.json()) as { mock: boolean };
      onSaved(j.mock);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("comms.calendar.newEvent")}
      closeLabel={t("common.close")}
      footer={
        <>
          <button type="button" className={aosButton({ variant: "quiet", size: "sm" })} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" form="calendar-new-event" className={aosButton({ variant: "primary", size: "sm" })} disabled={busy || !connections.length || !title.trim()}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {busy ? t("comms.calendar.creating") : t("comms.calendar.create")}
          </button>
        </>
      }
    >
      {connections.length === 0 ? (
        <p className="text-sm text-muted">
          {t("comms.calendar.needsCalendar")}{" "}
          <Link href="/dashboard/settings/connectors" className="font-semibold text-ink underline">
            {t("comms.calendar.connectCalendar")}
          </Link>
        </p>
      ) : (
        <form id="calendar-new-event" onSubmit={submit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="ev-cal" className={labelCls}>
              {t("comms.calendar.calendarField")}
            </label>
            <select id="ev-cal" className={inputCls} value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {(c.key === "google-calendar" ? "Google Calendar" : "Outlook") + (c.account ? ` · ${c.account}` : "")}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="ev-title" className={labelCls}>
              {t("comms.calendar.eventTitle")}
            </label>
            <input id="ev-title" className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={500} required />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="ev-start" className={labelCls}>
                {t("comms.calendar.starts")}
              </label>
              <input id="ev-start" type="datetime-local" className={inputCls} value={start} onChange={(e) => setStart(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="ev-end" className={labelCls}>
                {t("comms.calendar.ends")}
              </label>
              <input id="ev-end" type="datetime-local" className={inputCls} value={end} onChange={(e) => setEnd(e.target.value)} required />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="ev-att" className={labelCls}>
              {t("comms.calendar.attendees")}
            </label>
            <input id="ev-att" className={inputCls} value={attendees} onChange={(e) => setAttendees(e.target.value)} aria-describedby="ev-att-help" />
            <p id="ev-att-help" className="text-sm text-muted">
              {t("comms.calendar.attendeesHelp")}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="ev-loc" className={labelCls}>
              {t("comms.calendar.location")}
            </label>
            <input id="ev-loc" className={inputCls} value={location} onChange={(e) => setLocation(e.target.value)} maxLength={500} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="ev-desc" className={labelCls}>
              {t("comms.calendar.description")}
            </label>
            <textarea id="ev-desc" className={textareaCls} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <label className="flex items-center gap-2.5 text-md text-ink">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="size-[18px] accent-[var(--aos-ink)]" />
            {t("comms.calendar.notify")}
          </label>
          <ErrorLine message={error} />
        </form>
      )}
    </Modal>
  );
}

function FindTime({ open, tz, onClose, onUse }: { open: boolean; tz: string; onClose: () => void; onUse: (start: string, end: string) => void }) {
  const { t, format } = useI18n();
  const [duration, setDuration] = useState(30);
  const [ahead, setAhead] = useState(7);
  const [slots, setSlots] = useState<{ start: string; end: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    setBusy(true);
    setError(null);
    try {
      const from = new Date();
      const res = await fetch("/api/comms/calendar/find-time", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ durationMin: duration, from: from.toISOString(), to: new Date(from.getTime() + ahead * 86_400_000).toISOString(), max: 8 }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setSlots(((await res.json()) as { slots: { start: string; end: string }[] }).slots);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title={t("comms.calendar.findTimeTitle")} closeLabel={t("common.close")}>
      <p className="text-sm text-muted">{t("comms.calendar.slotsHelp", { tz })}</p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="ft-dur" className={labelCls}>
            {t("comms.calendar.duration")}
          </label>
          <select id="ft-dur" className={inputCls} value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
            {[15, 30, 45, 60, 90].map((m) => (
              <option key={m} value={m}>
                {t("comms.calendar.minutes", { count: m })}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="ft-ahead" className={labelCls}>
            {t("comms.calendar.lookAhead")}
          </label>
          <select id="ft-ahead" className={inputCls} value={ahead} onChange={(e) => setAhead(Number(e.target.value))}>
            {[3, 7, 14].map((d) => (
              <option key={d} value={d}>
                {t("comms.calendar.days", { count: d })}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className={aosButton({ variant: "primary", size: "md" })} onClick={search} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Search className="size-4" aria-hidden />}
          {busy ? t("comms.calendar.searching") : t("comms.calendar.search")}
        </button>
      </div>
      <ErrorLine message={error} className="mt-3" />
      {slots ? (
        slots.length === 0 ? (
          <p className="mt-4 text-sm text-muted">{t("comms.calendar.noSlots")}</p>
        ) : (
          <>
            <p className="mt-4 text-sm font-semibold text-ink" role="status">
              {t("comms.calendar.slotsFrom", { count: slots.length })}
            </p>
            <ul className="mt-2 divide-y divide-line rounded-md shadow-hairline">
              {slots.map((s) => (
                <li key={s.start} className="flex items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1 text-md text-ink">
                    {format.date(s.start, "weekday")} · {format.date(s.start, "time")} – {format.date(s.end, "time")}
                  </span>
                  <button type="button" className={aosButton({ variant: "secondary", size: "xs" })} onClick={() => onUse(s.start, s.end)}>
                    {t("comms.calendar.useSlot")}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )
      ) : null}
    </Modal>
  );
}

function Feeds({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, format } = useI18n();
  const [feeds, setFeeds] = useState<{ id: string; hint: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }[] | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/comms/calendar/feeds", { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res));
      setFeeds(((await res.json()) as { feeds: NonNullable<typeof feeds> }).feeds);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (open) void load();
    else {
      setFresh(null);
      setCopied(false);
    }
  }, [open, load]);

  async function create() {
    setError(null);
    try {
      const res = await fetch("/api/comms/calendar/feeds", { method: "POST" });
      if (!res.ok) throw new Error(await readError(res));
      setFresh(((await res.json()) as { url: string }).url);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function revoke(id: string) {
    const res = await fetch(`/api/comms/calendar/feeds/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 204) setError(await readError(res));
    await load();
  }

  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title={t("comms.calendar.feedsTitle")} closeLabel={t("common.close")} wide>
      <p className="text-sm text-muted">{t("comms.calendar.feedsHelp")}</p>
      <div className="mt-3">
        <button type="button" className={aosButton({ variant: "primary", size: "sm" })} onClick={create}>
          <Plus className="size-4" aria-hidden />
          {t("comms.calendar.newFeed")}
        </button>
      </div>
      {fresh ? (
        <div className="mt-3 flex flex-col gap-2 rounded-md bg-canvas p-3">
          <p className="text-sm font-semibold text-ink">{t("comms.calendar.feedCreated")}</p>
          <code className="aos-mono block break-all text-sm text-ink">{fresh}</code>
          <button
            type="button"
            className={aosButton({ variant: "secondary", size: "xs", className: "self-start" })}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(fresh);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            <Copy className="size-4" aria-hidden />
            {copied ? t("comms.calendar.copied") : t("comms.calendar.copy")}
          </button>
        </div>
      ) : null}
      <ErrorLine message={error} className="mt-3" />
      <ul className="mt-4 divide-y divide-line rounded-md shadow-hairline">
        {(feeds ?? []).length === 0 ? <li className="px-3 py-3 text-sm text-muted">{t("comms.calendar.noFeeds")}</li> : null}
        {(feeds ?? []).map((f) => (
          <li key={f.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block text-md text-ink">{t("comms.calendar.feedHint", { hint: f.hint })}</span>
              <span className="block text-sm text-muted">
                {t("comms.calendar.feedCreatedAt", { when: format.date(f.createdAt, "date") })} · {f.lastUsedAt ? t("comms.calendar.feedLastUsed", { when: format.relative(f.lastUsedAt) }) : t("comms.calendar.feedNeverUsed")}
              </span>
            </span>
            {f.revokedAt ? (
              <Chip>{t("comms.calendar.revoked")}</Chip>
            ) : (
              <button type="button" className={aosButton({ variant: "deny", size: "xs" })} onClick={() => revoke(f.id)}>
                {t("comms.calendar.revoke")}
              </button>
            )}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

export default CalendarApp;
