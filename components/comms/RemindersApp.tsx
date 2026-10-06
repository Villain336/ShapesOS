"use client";

// ShapesOS — Phase 18.2 (WS=comms): the Reminders app (/dashboard/reminders).
// Personal to-dos over OpsTask (no project, assigned to you): add with an
// optional due time and repeat, tick done, remove. Groups: overdue, today,
// later, no due time; done ones on request. Due times are wall times in your
// time zone (Settings → You), so 09:00 means 09:00 where you are.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AlarmClock, Check, Loader2, Plus, Repeat, X } from "lucide-react";
import { useI18n } from "@/components/i18n/I18nProvider";
import { aosButton } from "@/components/aos/button";
import { cn } from "@/lib/utils";
import { dueGroup, isoToWall, wallToIso } from "@/lib/comms/time";
import { Card, Chip, EmptyState, ErrorLine, iconBtnCls, inputCls, labelCls, PageHeader } from "./ui";

interface Reminder {
  id: string;
  title: string;
  notes: string | null;
  dueAt: string | null;
  repeat: "daily" | "weekly" | "monthly" | null;
  done: boolean;
  completedAt: string | null;
  overdue: boolean;
  sourceRef: string | null;
  createdAt: string;
}

type RepeatValue = "" | "daily" | "weekly" | "monthly";

async function readError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    return j.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export function RemindersApp({ highlightId }: { highlightId?: string | null }) {
  const { t, ctx, format } = useI18n();
  const tz = ctx.timeZone;
  const [items, setItems] = useState<Reminder[] | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [repeat, setRepeat] = useState<RepeatValue>("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/comms/reminders${showDone ? "?done=1" : ""}`, { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res));
      const j = (await res.json()) as { reminders: Reminder[] };
      setItems(j.reminders);
      setError(null);
    } catch (e) {
      setError(t("comms.common.loadError", { error: e instanceof Error ? e.message : "" }));
      setItems((prev) => prev ?? []);
    }
  }, [showDone, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!highlightId || !items) return;
    document.getElementById(`reminder-${highlightId}`)?.scrollIntoView({ block: "center" });
  }, [highlightId, items]);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || adding) return;
    setAdding(true);
    setError(null);
    try {
      const dueAt = due ? wallToIso(due, tz) : null;
      const res = await fetch("/api/comms/reminders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), dueAt, repeat: repeat || null }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setTitle("");
      setDue("");
      setRepeat("");
      await load();
    } catch (e2) {
      setError(t("comms.common.saveError", { error: e2 instanceof Error ? e2.message : "" }));
    } finally {
      setAdding(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/comms/reminders/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await readError(res));
      await load();
    } catch (e) {
      setError(t("comms.common.saveError", { error: e instanceof Error ? e.message : "" }));
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy(id);
    try {
      const res = await fetch(`/api/comms/reminders/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error(await readError(res));
      setNote(t("comms.reminders.removed"));
      await load();
    } catch (e) {
      setError(t("comms.common.saveError", { error: e instanceof Error ? e.message : "" }));
    } finally {
      setBusy(null);
    }
  }

  const groups = useMemo(() => {
    const now = new Date();
    const open = (items ?? []).filter((r) => !r.done);
    const by = { overdue: [] as Reminder[], today: [] as Reminder[], later: [] as Reminder[], none: [] as Reminder[] };
    for (const r of open) by[dueGroup(r.dueAt, now, tz)].push(r);
    return by;
  }, [items, tz]);
  const done = (items ?? []).filter((r) => r.done);
  const repeatLabel = (r: Reminder["repeat"]) =>
    r === "daily" ? t("comms.reminders.repeatDaily") : r === "weekly" ? t("comms.reminders.repeatWeekly") : r === "monthly" ? t("comms.reminders.repeatMonthly") : null;

  const row = (r: Reminder) => (
    <li
      key={r.id}
      id={`reminder-${r.id}`}
      className={cn("flex min-h-row items-start gap-3 px-4 py-2.5", highlightId === r.id && "bg-hover-paper")}
    >
      <button
        type="button"
        onClick={() => patch(r.id, { done: !r.done })}
        disabled={busy === r.id}
        aria-label={r.done ? t("comms.reminders.markOpen", { title: r.title }) : t("comms.reminders.markDone", { title: r.title })}
        aria-pressed={r.done}
        className={cn(
          "aos-press mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full",
          r.done ? "bg-ink text-paper" : "bg-paper shadow-[inset_0_0_0_1.5px_var(--aos-control)] hover:shadow-[inset_0_0_0_1.5px_var(--aos-ink)]",
        )}
      >
        {busy === r.id ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : r.done ? <Check className="size-3.5" aria-hidden /> : null}
      </button>
      <div className="min-w-0 flex-1">
        <p className={cn("text-md break-words text-ink", r.done && "text-muted line-through")}>{r.title}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-muted">
          {r.dueAt ? (
            <span className={cn("inline-flex items-center gap-1", r.overdue && "font-semibold text-ink")}>
              <AlarmClock className="size-3.5" aria-hidden />
              {r.overdue ? `${t("comms.reminders.overdue")} · ` : ""}
              {format.date(r.dueAt, "dateTime")}
            </span>
          ) : null}
          {r.repeat ? (
            <Chip>
              <Repeat className="size-3" aria-hidden />
              {repeatLabel(r.repeat)}
            </Chip>
          ) : null}
          {r.sourceRef?.startsWith("meeting:") ? <Chip>{t("comms.reminders.fromMeeting")}</Chip> : null}
        </div>
      </div>
      <button type="button" className={iconBtnCls} onClick={() => remove(r.id)} disabled={busy === r.id} aria-label={t("comms.reminders.remove", { title: r.title })}>
        <X className="size-4" aria-hidden />
      </button>
    </li>
  );

  const section = (key: string, label: string, list: Reminder[]) =>
    list.length ? (
      <section key={key} aria-label={label}>
        <h2 className="px-4 pt-4 pb-1 text-xs font-semibold text-muted">{label}</h2>
        <ul className="divide-y divide-line">{list.map(row)}</ul>
      </section>
    ) : null;

  const openCount = groups.overdue.length + groups.today.length + groups.later.length + groups.none.length;

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4">
      <PageHeader title={t("comms.reminders.title")} subtitle={t("comms.reminders.subtitle")} />
      <Card className="p-4">
        <form onSubmit={add} className="flex flex-col gap-3">
          <label htmlFor="reminder-title" className="sr-only">
            {t("comms.reminders.newPlaceholder")}
          </label>
          <input
            id="reminder-title"
            className={inputCls}
            placeholder={t("comms.reminders.newPlaceholder")}
            value={title}
            maxLength={300}
            onChange={(e) => setTitle(e.target.value)}
          />
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
              <label htmlFor="reminder-due" className={labelCls}>
                {t("comms.reminders.dueLabel")}
              </label>
              <input id="reminder-due" type="datetime-local" className={inputCls} value={due} onChange={(e) => setDue(e.target.value)} />
            </div>
            <div className="flex min-w-[160px] flex-col gap-1.5">
              <label htmlFor="reminder-repeat" className={labelCls}>
                {t("comms.reminders.repeat")}
              </label>
              <select id="reminder-repeat" className={inputCls} value={repeat} onChange={(e) => setRepeat(e.target.value as RepeatValue)} disabled={!due}>
                <option value="">{t("comms.reminders.repeatNone")}</option>
                <option value="daily">{t("comms.reminders.repeatDaily")}</option>
                <option value="weekly">{t("comms.reminders.repeatWeekly")}</option>
                <option value="monthly">{t("comms.reminders.repeatMonthly")}</option>
              </select>
            </div>
            <button type="submit" disabled={!title.trim() || adding} className={aosButton({ variant: "primary", size: "md" })}>
              {adding ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
              {adding ? t("comms.reminders.adding") : t("comms.reminders.add")}
            </button>
          </div>
        </form>
      </Card>
      <ErrorLine message={error} />
      {note ? (
        <p role="status" className="text-sm text-muted">
          {note}
        </p>
      ) : null}
      <Card aria-label={t("comms.reminders.open")}>
        {items === null ? (
          <p className="flex items-center gap-2 px-4 py-6 text-sm text-muted" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t("common.loading")}
          </p>
        ) : openCount === 0 ? (
          <EmptyState icon={AlarmClock} title={t("comms.reminders.emptyTitle")} body={t("comms.reminders.emptyBody")} />
        ) : (
          <div className="pb-2">
            {section("overdue", t("comms.reminders.groupOverdue"), groups.overdue)}
            {section("today", t("comms.reminders.groupToday"), groups.today)}
            {section("later", t("comms.reminders.groupLater"), groups.later)}
            {section("none", t("comms.reminders.groupNoDate"), groups.none)}
          </div>
        )}
      </Card>
      <div>
        <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
          {showDone ? t("comms.reminders.hideDone") : t("comms.reminders.showDone")}
        </button>
      </div>
      {showDone ? (
        <Card aria-label={t("comms.reminders.done")}>
          {done.length === 0 ? <p className="px-4 py-4 text-sm text-muted">{t("comms.reminders.doneEmpty")}</p> : <ul className="divide-y divide-line">{done.map(row)}</ul>}
        </Card>
      ) : null}
    </div>
  );
}

export function dueWallValue(iso: string | null, tz: string | null): string {
  return iso ? isoToWall(iso, tz) : "";
}
