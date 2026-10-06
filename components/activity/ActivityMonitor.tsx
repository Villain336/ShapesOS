"use client";

// ShapesOS — Phase 18.2 (WS=content): the Activity Monitor.
//
// One dense table of every process (lib/aos/processes.ts ProcessRow) with the
// agent-state badge (colour + shape — agent work only; a person's terminal
// and cancelled rows are neutral), cost so far, elapsed time, the share of
// the run's budget used, and Stop. A health panel beside it: queue depth,
// oldest waiting job, jobs out of retries, worker heartbeat, prompt-cache
// hits, and for admins the scheduled jobs' last runs and database
// connections. Live through /api/activity/stream (openLiveStream); if the
// stream gives up, it polls /api/activity.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Activity, CornerDownRight, Square } from "lucide-react";
import { aosButton, FilterPill, NeutralBadge, StatusBadge } from "@/components/aos";
import { Segmented } from "@/components/aos/Controls";
import { useI18n } from "@/components/i18n/I18nProvider";
import { confirmAction, toast, toastError } from "@/lib/ui/feedback";
import { openLiveStream, type LiveStreamState } from "@/lib/ui/live-stream";
import { budgetUsed, elapsedMs, formatCost, formatElapsed, type ProcessRow, type ProcessSnapshot, type ProcessType, type SystemHealth } from "@/lib/aos/processes";
import type { MessageKey } from "@/lib/i18n";

type Show = "live" | "all";
type TypeFilter = "all" | ProcessType;
const TYPES: TypeFilter[] = ["all", "run", "job", "batch", "sandbox", "terminal", "cron"];
const NEUTRAL_STATES = ["cancelled", "stopping", "ended", "active", "destroyed", "expired", "running", "ok", "failed", "timeout"] as const;

export interface ActivityMonitorProps {
  initial: ProcessSnapshot;
  /** userId → display name (workspace members). */
  people: Record<string, string>;
  /** The signed-in person (Stop rights are computed on the server per row). */
  viewerId: string;
  isAdmin: boolean;
}

export function ActivityMonitor({ initial, people, isAdmin }: ActivityMonitorProps) {
  const { t, format } = useI18n();
  const [processes, setProcesses] = useState<ProcessRow[]>(initial.processes);
  const [health, setHealth] = useState<SystemHealth>(initial.health);
  const [show, setShow] = useState<Show>("live");
  const [type, setType] = useState<TypeFilter>("all");
  const [stream, setStream] = useState<LiveStreamState>("connecting");
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState<Set<string>>(new Set());

  const apply = useCallback((snap: Partial<ProcessSnapshot> | null) => {
    if (!snap) return;
    if (Array.isArray(snap.processes)) setProcesses(snap.processes);
    if (snap.health) setHealth(snap.health);
  }, []);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/activity", { cache: "no-store" });
      if (res.ok) apply((await res.json()) as ProcessSnapshot);
    } catch {
      // the next tick tries again
    }
  }, [apply]);

  useEffect(() => {
    const live = openLiveStream("/api/activity/stream", {
      events: {
        snapshot: (data) => {
          try {
            apply(JSON.parse(data) as ProcessSnapshot);
          } catch {
            // ignore a malformed frame
          }
        },
      },
      onState: setStream,
    });
    return () => live.close();
  }, [apply]);

  // Fallback: the stream gave up (proxy without SSE, a long outage) → poll.
  useEffect(() => {
    if (stream !== "failed") return;
    const h = window.setInterval(() => void poll(), 10_000);
    return () => window.clearInterval(h);
  }, [stream, poll]);

  // Elapsed time ticks every second while anything is live.
  const anyLive = processes.some((p) => p.live);
  useEffect(() => {
    if (!anyLive) return;
    const h = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(h);
  }, [anyLive]);

  const rows = useMemo(() => {
    const byShow = show === "live" ? processes.filter((p) => p.live || processes.some((c) => c.live && c.parentKey === p.key)) : processes;
    return type === "all" ? byShow : byShow.filter((p) => p.type === type);
  }, [processes, show, type]);
  const counts = useMemo(() => {
    const base = show === "live" ? processes.filter((p) => p.live) : processes;
    const c: Record<TypeFilter, number> = { all: base.length, run: 0, job: 0, batch: 0, sandbox: 0, terminal: 0, cron: 0 };
    for (const p of base) c[p.type] += 1;
    return c;
  }, [processes, show]);

  async function stop(row: ProcessRow) {
    const ok = await confirmAction({
      title: t("activityApp.stopConfirm", { title: row.title }),
      confirmLabel: t("activityApp.stop"),
      cancelLabel: t("common.cancel"),
      destructive: true,
    });
    if (!ok) return;
    setStopping((s) => new Set(s).add(row.key));
    try {
      const res = await fetch("/api/activity/stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: row.key }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) toastError(t("activityApp.stopFailed"), body.error);
      else toast({ title: t("activityApp.stopped"), status: "done" });
      await poll();
    } catch {
      toastError(t("activityApp.stopFailed"), t("common.couldNotReach"));
    } finally {
      setStopping((s) => {
        const n = new Set(s);
        n.delete(row.key);
        return n;
      });
    }
  }

  function stateBadge(row: ProcessRow) {
    if (row.status) return <StatusBadge status={row.status} size="sm" label={t(`status.${row.status}` as MessageKey)} />;
    const known = (NEUTRAL_STATES as readonly string[]).includes(row.state);
    return <NeutralBadge size="sm" label={known ? t(`activityApp.states.${row.state}` as MessageKey) : row.state} />;
  }

  function subtitle(row: ProcessRow): string | null {
    if (row.type === "terminal") return t("activityApp.terminalCommands", { count: Number(row.subtitle ?? 0) });
    return row.subtitle;
  }

  const depthOf = (row: ProcessRow) => {
    let d = 0;
    let k = row.parentKey;
    while (k && d < 4) {
      const p = processes.find((x) => x.key === k);
      if (!p) break;
      d += 1;
      k = p.parentKey;
    }
    return d;
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="aos-heading">{t("activityApp.title")}</h1>
          <p className="mt-1 max-w-[72ch] text-md text-muted">{t("activityApp.subtitle")}</p>
        </div>
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-muted" role="status" aria-live="polite">
          <Activity className="size-4" aria-hidden />
          {stream === "open" ? t("activityApp.live") : t("activityApp.reconnecting")}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-label={t("activityApp.tableLabel")} className="flex min-w-0 flex-col gap-3 rounded-lg bg-paper p-3 shadow-hairline sm:p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented<Show>
              value={show}
              onChange={setShow}
              label={t("activityApp.show")}
              options={[
                { value: "live", label: t("activityApp.showLive") },
                { value: "all", label: t("activityApp.showAll") },
              ]}
            />
            <div role="group" aria-label={t("activityApp.typeFilter")} className="flex flex-wrap gap-1.5">
              {TYPES.filter((ty) => ty !== "cron" || isAdmin).map((ty) => (
                <FilterPill key={ty} selected={type === ty} onClick={() => setType(ty)} count={counts[ty]}>
                  {t(`activityApp.types.${ty}` as MessageKey)}
                </FilterPill>
              ))}
            </div>
          </div>

          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-3 py-14 text-center">
              <Activity className="size-6 text-subtle" aria-hidden />
              <p className="text-md font-semibold text-ink">{show === "live" ? t("activityApp.emptyLive") : t("activityApp.emptyAll")}</p>
              <p className="max-w-[44ch] text-sm text-muted">{t("activityApp.emptyBody")}</p>
            </div>
          ) : (
            <div className="-mx-3 overflow-x-auto sm:-mx-4">
              <table className="w-full min-w-[56rem] border-collapse text-left text-sm">
                <caption className="sr-only">{t("activityApp.tableLabel")}</caption>
                <thead>
                  <tr className="border-b border-line text-xs font-semibold text-muted">
                    <th scope="col" className="px-3 py-2 sm:pl-4">{t("activityApp.columns.process")}</th>
                    <th scope="col" className="px-3 py-2">{t("activityApp.columns.kind")}</th>
                    <th scope="col" className="px-3 py-2">{t("activityApp.columns.status")}</th>
                    <th scope="col" className="px-3 py-2">{t("activityApp.columns.startedBy")}</th>
                    <th scope="col" className="px-3 py-2 text-right">{t("activityApp.columns.elapsed")}</th>
                    <th scope="col" className="px-3 py-2 text-right">{t("activityApp.columns.cost")}</th>
                    <th scope="col" className="px-3 py-2">{t("activityApp.columns.budget")}</th>
                    <th scope="col" className="px-3 py-2 text-right sm:pr-4">
                      <span className="sr-only">{t("activityApp.columns.actions")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const depth = depthOf(row);
                    const used = budgetUsed(row, now);
                    const who = row.startedBy ? people[row.startedBy] || "—" : t("activityApp.system");
                    const sub = subtitle(row);
                    return (
                      <tr key={row.key} className="border-b border-line last:border-b-0 hover:bg-hover-paper">
                        <td className="max-w-[22rem] px-3 py-2 align-top sm:pl-4">
                          <div className="flex min-w-0 items-start gap-1.5" style={{ paddingLeft: `${depth * 1.25}rem` }}>
                            {depth > 0 ? <CornerDownRight className="mt-0.5 size-3.5 shrink-0 text-subtle" aria-label={t("activityApp.subAgent")} /> : null}
                            <div className="min-w-0">
                              {row.href ? (
                                <Link href={row.href} className="block truncate font-semibold text-ink underline-offset-2 hover:underline">
                                  {row.title}
                                </Link>
                              ) : (
                                <span className="block truncate font-semibold text-ink">{row.title}</span>
                              )}
                              {sub ? <span className="block truncate text-xs text-muted">{sub}</span> : null}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2 align-top whitespace-nowrap text-muted">{t(`activityApp.typeLabels.${row.type}` as MessageKey)}</td>
                        <td className="px-3 py-2 align-top">{stateBadge(row)}</td>
                        <td className="max-w-[10rem] truncate px-3 py-2 align-top text-muted">{who}</td>
                        <td className="px-3 py-2 text-right align-top whitespace-nowrap tabular-nums text-ink">{formatElapsed(elapsedMs(row, now))}</td>
                        <td className="px-3 py-2 text-right align-top whitespace-nowrap tabular-nums text-ink">{formatCost(row.costMicroUsd)}</td>
                        <td className="px-3 py-2 align-top">
                          {used === null ? (
                            <span className="text-xs text-subtle">{t("activityApp.noBudget")}</span>
                          ) : (
                            <div className="flex items-center gap-2" title={t("activityApp.budgetUsed", { pct: Math.round(used * 100) })}>
                              <div className="h-1.5 w-20 overflow-hidden rounded-full bg-line" aria-hidden>
                                <div className="h-full rounded-full bg-ink" style={{ width: `${Math.round(used * 100)}%` }} />
                              </div>
                              <span className="text-xs tabular-nums text-muted">
                                <span className="sr-only">{t("activityApp.budgetUsed", { pct: Math.round(used * 100) })}</span>
                                <span aria-hidden>{Math.round(used * 100)}%</span>
                              </span>
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right align-top sm:pr-4">
                          {row.stop.allowed ? (
                            <button
                              type="button"
                              onClick={() => void stop(row)}
                              disabled={stopping.has(row.key)}
                              className={aosButton({ variant: "deny", size: "xs" })}
                              aria-label={`${t("activityApp.stop")}: ${row.title}`}
                            >
                              <Square className="size-3.5" aria-hidden />
                              {stopping.has(row.key) ? t("activityApp.stopping") : t("activityApp.stop")}
                            </button>
                          ) : row.live ? (
                            <span className="text-xs text-subtle">{t(`activityApp.stopReasons.${row.stop.reason}` as MessageKey)}</span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <HealthPanel health={health} isAdmin={isAdmin} formatTime={(iso) => format.date(iso, "time")} formatPercent={(n) => format.number(n, { style: "percent", maximumFractionDigits: 0 })} />
      </div>
    </div>
  );
}

function HealthPanel({ health, isAdmin, formatTime, formatPercent }: { health: SystemHealth; isAdmin: boolean; formatTime: (iso: string) => string; formatPercent: (n: number) => string }) {
  const { t } = useI18n();
  const mode = (["internal", "external", "off"] as const).includes(health.workerMode as "internal") ? t(`activityApp.health.workerModes.${health.workerMode}` as MessageKey) : health.workerMode;
  const stats: Array<{ label: string; value: string; hint?: string }> = [
    { label: t("activityApp.health.queue"), value: String(health.queueDepth) },
    { label: t("activityApp.health.oldest"), value: health.oldestQueuedMs === null ? t("activityApp.health.none") : formatElapsed(health.oldestQueuedMs) },
    { label: t("activityApp.health.dead"), value: String(health.deadJobs24h) },
    {
      label: t("activityApp.health.heartbeat"),
      value: health.lastHeartbeatMs === null ? t("activityApp.health.idle") : t("activityApp.health.heartbeatAgo", { elapsed: formatElapsed(health.lastHeartbeatMs) }),
      hint: t("activityApp.health.worker", { mode }),
    },
    { label: t("activityApp.health.cache"), value: health.cacheHitPct === null ? t("activityApp.health.cacheNone") : formatPercent(health.cacheHitPct) },
  ];
  if (health.db) stats.push({ label: t("activityApp.health.db"), value: t("activityApp.health.dbValue", { used: health.db.connections, max: health.db.max }) });
  return (
    <section aria-labelledby="activity-health" className="flex flex-col gap-4 self-start rounded-lg bg-paper p-4 shadow-hairline">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="activity-health" className="aos-subheading">
          {t("activityApp.health.title")}
        </h2>
        <span className="text-xs text-subtle">{t("activityApp.health.updated", { time: formatTime(health.generatedAt) })}</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        {stats.map((s) => (
          <div key={s.label} className="min-w-0">
            <dt className="text-xs text-muted">{s.label}</dt>
            <dd className="text-md font-semibold tabular-nums text-ink">{s.value}</dd>
            {s.hint ? <dd className="text-xs text-muted">{s.hint}</dd> : null}
          </div>
        ))}
      </dl>
      {isAdmin ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-ink">{t("activityApp.health.cron")}</h3>
          {health.cron && health.cron.length > 0 ? (
            <div className="-mx-1 overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-line text-muted">
                    <th scope="col" className="px-1 py-1.5 font-semibold">{t("activityApp.health.cronJob")}</th>
                    <th scope="col" className="px-1 py-1.5 font-semibold">{t("activityApp.health.cronStatus")}</th>
                    <th scope="col" className="px-1 py-1.5 text-right font-semibold">{t("activityApp.health.cronWhen")}</th>
                  </tr>
                </thead>
                <tbody>
                  {health.cron.map((c) => (
                    <tr key={c.job} className="border-b border-line last:border-b-0" title={c.error ?? undefined}>
                      <td className="max-w-[8rem] truncate px-1 py-1.5 font-mono text-ink">{c.job}</td>
                      <td className="px-1 py-1.5 text-muted">
                        {c.status}
                        {c.durationMs !== null ? ` · ${formatElapsed(c.durationMs)}` : ""}
                      </td>
                      <td className="px-1 py-1.5 text-right whitespace-nowrap text-muted">{formatTime(c.startedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-xs text-muted">{t("activityApp.health.cronNone")}</p>
          )}
        </div>
      ) : (
        <p className="rounded-md bg-canvas p-3 text-xs text-muted">{t("activityApp.health.adminOnly")}</p>
      )}
    </section>
  );
}

export default ActivityMonitor;
