"use client";

// ShapesOS — Phase 19B (WS=engine): the live view of a town run — a 2D SVG
// map whose residents move along their planned paths (interpolated in the
// browser from the SSE event log: lib/sim/view-model.ts TownPlayback), play /
// pause / speed (1× … 1,000×), jump to a day (seek via the hourly snapshot),
// follow a resident (their thought log), inspect a building. Reduced motion:
// jump-cuts once a second, no animation. Residents are people, not agents:
// clay and ink only — never the status colours (DESIGN.md).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, UserRound, X } from "lucide-react";
import { aosButton, NeutralBadge, Segmented } from "@/components/aos";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { TownEvent, TownSnapshot } from "@/lib/sim/engine";
import type { Lot, TownLayout } from "@/lib/sim/layout";
import type { ResidentLog } from "@/lib/sim/service.server";
import { TownPlayback, type ResidentMeta, type TownViewModel } from "@/lib/sim/view-model";
import type { MessageKey } from "@/lib/i18n";

export const SPEEDS = [1, 10, 60, 300, 1000] as const;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return document.documentElement.classList.contains("motion-reduce") || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

const LOT_FILL: Record<Lot["kind"], string> = {
  home: "var(--aos-clay-1)",
  work: "var(--aos-clay-2)",
  cafe: "var(--aos-clay-2)",
  park: "var(--aos-clay-0)",
  shop: "var(--aos-paper)",
  billboard: "var(--aos-ink)",
};

/** A stable spot inside a lot for each resident standing there (2D only: dots don't stack). */
function spread(id: string, rect: { w: number; h: number }): { dx: number; dy: number } {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  const fx = (h & 0xffff) / 0xffff - 0.5;
  const fy = (h >>> 16) / 0xffff - 0.5;
  return { dx: fx * Math.max(0, rect.w - 8), dy: fy * Math.max(0, rect.h - 8) };
}

export function TownMapSvg({ view, followed, inspected, onResident, onLot, label }: { view: TownViewModel; followed: string | null; inspected: string | null; onResident: (id: string) => void; onLot: (id: string) => void; label: string }) {
  const { layout } = view;
  const pad = 16;
  const yours = new Set(view.yourStores);
  const nodes = useMemo(() => new Map(layout.roads.nodes.map((n) => [n.id, n])), [layout]);
  const wnodes = useMemo(() => new Map(layout.walkways.nodes.map((n) => [n.id, n])), [layout]);
  const lotRects = useMemo(() => new Map(layout.lots.map((l) => [l.id, l.rect])), [layout]);
  return (
    <svg viewBox={`${-pad} ${-pad} ${layout.size.width + 2 * pad} ${layout.size.height + 2 * pad}`} className="h-auto max-h-[70vh] w-full rounded-md bg-canvas" role="img" aria-label={label}>
      {layout.districts.map((d) => (
        <rect key={d.id} x={d.rect.x} y={d.rect.y} width={d.rect.w} height={d.rect.h} fill="var(--aos-clay-0)" />
      ))}
      {layout.walkways.edges.map((e) => {
        const a = wnodes.get(e.from);
        const b = wnodes.get(e.to);
        return a && b ? <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--aos-clay-2)" strokeWidth={1} /> : null;
      })}
      {layout.roads.edges.map((e) => {
        const a = nodes.get(e.from);
        const b = nodes.get(e.to);
        return a && b ? <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--aos-clay-3)" strokeWidth={Math.max(2, e.lanes * 2.2)} strokeLinecap="round" /> : null;
      })}
      {layout.lots.map((l) => {
        const isYours = yours.has(l.id);
        const competitor = l.kind === "shop" && l.owner === "competitor" && !isYours;
        return (
          <g key={l.id} onClick={() => onLot(l.id)} className="cursor-pointer">
            <title>{l.name}</title>
            <rect
              x={l.rect.x}
              y={l.rect.y}
              width={l.rect.w}
              height={l.rect.h}
              rx={2}
              fill={isYours ? "var(--aos-paper)" : LOT_FILL[l.kind]}
              stroke={isYours || inspected === l.id ? "var(--aos-ink)" : competitor ? "var(--aos-text-muted)" : "var(--aos-clay-3)"}
              strokeWidth={isYours ? 3 : inspected === l.id ? 2.5 : 1}
              strokeDasharray={competitor ? "4 3" : undefined}
            />
            {isYours ? (
              <text x={l.rect.x + l.rect.w / 2} y={l.rect.y - 4} textAnchor="middle" fontSize={10} fontWeight={700} className="fill-ink" paintOrder="stroke" stroke="var(--aos-canvas)" strokeWidth={3}>
                {l.name}
              </text>
            ) : null}
          </g>
        );
      })}
      {view.residents.map((r) => {
        const isFollowed = followed === r.id;
        const rect = !r.moving && r.lot ? lotRects.get(r.lot) : undefined;
        const off = rect ? spread(r.id, rect) : { dx: 0, dy: 0 };
        const cx = r.position.x + off.dx;
        const cy = r.position.y + off.dy;
        return (
          <g key={r.id} onClick={() => onResident(r.id)} className="cursor-pointer">
            <title>{r.name}</title>
            <circle cx={cx} cy={cy} r={isFollowed ? 6 : 3.4} fill={r.adopted ? "var(--aos-ink)" : "var(--aos-paper)"} stroke="var(--aos-ink)" strokeWidth={isFollowed ? 2.5 : 1.2} />
            {isFollowed ? (
              <text x={cx + 9} y={cy + 4} fontSize={12} fontWeight={700} className="fill-ink" paintOrder="stroke" stroke="var(--aos-paper)" strokeWidth={3}>
                {r.name}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

export interface TownLiveProps {
  runId: string;
  layout: TownLayout;
  residents: ResidentMeta[];
  days: number;
  hasB: boolean;
  status: string;
}

export function TownLive({ runId, layout, residents, days, hasB, status }: TownLiveProps) {
  const { t, format } = useI18n();
  const [variant, setVariant] = useState<"A" | "B">("A");
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(300);
  const [playing, setPlaying] = useState(false);
  const [view, setView] = useState<TownViewModel>(() => new TownPlayback(layout, residents).viewAt(0));
  const [followed, setFollowed] = useState<string | null>(null);
  const [inspected, setInspected] = useState<string | null>(null);
  const [log, setLog] = useState<ResidentLog | null>(null);
  const [ended, setEnded] = useState(false);
  const reduced = useMemo(prefersReducedMotion, []);
  const playback = useRef<TownPlayback>(new TownPlayback(layout, residents));
  const buffer = useRef<TownEvent[]>([]);
  const loadedUntil = useRef(0);
  const simSec = useRef(0);
  const lotStats = useRef(new Map<string, { visits: number; buys: number }>());
  const source = useRef<EventSource | null>(null);

  const render = useCallback(() => {
    const due = buffer.current.filter((e) => e.t * 60 <= simSec.current);
    if (due.length) {
      buffer.current = buffer.current.filter((e) => e.t * 60 > simSec.current);
      playback.current.apply(due);
      for (const e of due) {
        if (!e.lot || (e.type !== "visit" && e.type !== "buy")) continue;
        const s = lotStats.current.get(e.lot) ?? { visits: 0, buys: 0 };
        if (e.type === "visit") s.visits += 1;
        else s.buys += 1;
        lotStats.current.set(e.lot, s);
      }
    }
    setView(playback.current.viewAt(simSec.current));
  }, []);

  const connect = useCallback(
    (v: "A" | "B", fromMinute: number) => {
      source.current?.close();
      playback.current = new TownPlayback(layout, residents);
      buffer.current = [];
      loadedUntil.current = 0;
      lotStats.current = new Map();
      simSec.current = fromMinute * 60;
      setEnded(false);
      const es = new EventSource(`/api/rehearsal/town/runs/${encodeURIComponent(runId)}/stream?variant=${v}&from=${fromMinute}`);
      source.current = es;
      es.addEventListener("snapshot", (ev) => {
        const snap = JSON.parse((ev as MessageEvent).data) as TownSnapshot;
        playback.current.loadSnapshot(snap);
        simSec.current = snap.t * 60;
        render();
      });
      es.addEventListener("events", (ev) => {
        const events = JSON.parse((ev as MessageEvent).data) as TownEvent[];
        buffer.current.push(...events);
        const last = events[events.length - 1];
        if (last) loadedUntil.current = Math.max(loadedUntil.current, last.t * 60);
        render();
      });
      es.addEventListener("end", () => {
        setEnded(true);
        es.close();
      });
      es.addEventListener("error", () => {
        // EventSource reconnects by itself with Last-Event-ID; a closed one stays closed.
      });
      render();
    },
    [layout, residents, runId, render],
  );

  useEffect(() => {
    connect(variant, 0);
    return () => source.current?.close();
  }, [connect, variant]);

  // The clock: rAF (smooth) or, with reduced motion, a jump-cut once a second.
  useEffect(() => {
    if (!playing) return;
    const step = (realMs: number) => {
      const next = simSec.current + (realMs / 1000) * speed;
      const limit = ended ? days * 86_400 : loadedUntil.current;
      simSec.current = Math.min(next, limit);
      if (simSec.current >= days * 86_400) setPlaying(false);
      render();
    };
    if (reduced) {
      const id = setInterval(() => step(1000), 1000);
      return () => clearInterval(id);
    }
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      step(now - last);
      last = now;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, reduced, ended, days, render]);

  useEffect(() => {
    if (!followed) return setLog(null);
    let live = true;
    void fetch(`/api/rehearsal/town/runs/${encodeURIComponent(runId)}/residents/${encodeURIComponent(followed)}?variant=${variant}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<ResidentLog>) : null))
      .then((l) => live && setLog(l))
      .catch(() => live && setLog(null));
    return () => {
      live = false;
    };
  }, [followed, runId, variant]);

  const followedView = view.residents.find((r) => r.id === followed) ?? null;
  const lot = inspected ? layout.lots.find((l) => l.id === inspected) : null;
  const weekday = t(`rehearsalTown.view.weekdays.${view.weekday}` as MessageKey);
  const weather = view.weather ? t(`rehearsalTown.view.weather.${view.weather}` as MessageKey) : null;
  const minuteNow = Math.floor(view.t / 60);
  const lotName = (id: string | null) => (id ? (layout.lots.find((l) => l.id === id)?.name ?? id) : t("rehearsalTown.view.travelling"));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={aosButton({ variant: "primary", size: "sm" })} onClick={() => setPlaying((p) => !p)} aria-pressed={playing}>
          {playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
          {playing ? t("rehearsalTown.view.pause") : t("rehearsalTown.view.play")}
        </button>
        <Segmented label={t("rehearsalTown.view.speed")} value={speed} onChange={(v) => setSpeed(v)} options={SPEEDS.map((s) => ({ value: s, label: `${format.number(s)}×` }))} />
        <label className="flex items-center gap-2 text-sm font-semibold text-ink">
          {t("rehearsalTown.view.jumpTo")}
          <select
            className="h-control-sm rounded-md border-[1.5px] border-control bg-paper px-2 text-sm"
            value={view.day}
            onChange={(e) => {
              setPlaying(false);
              connect(variant, Number(e.target.value) * 1440);
            }}
          >
            {Array.from({ length: days }, (_, d) => (
              <option key={d} value={d}>
                {t("rehearsalTown.view.dayN", { day: d + 1 })}
              </option>
            ))}
          </select>
        </label>
        {hasB ? (
          <Segmented
            label={t("rehearsalTown.view.scenario")}
            value={variant}
            onChange={(v) => {
              setPlaying(false);
              setVariant(v);
            }}
            options={[
              { value: "A" as const, label: "A" },
              { value: "B" as const, label: "B" },
            ]}
          />
        ) : null}
        <p className="text-sm font-semibold text-ink" aria-live="polite">
          {t("rehearsalTown.view.clock", { weekday, day: view.day + 1, clock: view.clock })}
          {weather ? <span className="font-normal text-muted"> · {weather}</span> : null}
        </p>
      </div>
      {status === "queued" || status === "running" ? <p className="text-sm text-muted">{t("rehearsalTown.view.waiting")}</p> : null}
      {reduced ? <p className="text-sm text-muted">{t("rehearsalTown.view.reducedMotion")}</p> : null}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-2">
          <TownMapSvg
            view={view}
            followed={followed}
            inspected={inspected}
            onResident={(id) => setFollowed(id)}
            onLot={(id) => setInspected(id)}
            label={t("rehearsalTown.view.mapLabel", { name: layout.name, residents: view.residents.length, adopters: view.stats.adopters })}
          />
          <div className="flex flex-wrap items-center gap-4 text-xs text-muted">
            <span className="inline-flex items-center gap-1.5">
              <svg width="10" height="10" aria-hidden>
                <circle cx="5" cy="5" r="4" fill="var(--aos-ink)" />
              </svg>
              {t("rehearsalTown.view.legend.adopted")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <svg width="10" height="10" aria-hidden>
                <circle cx="5" cy="5" r="4" fill="var(--aos-paper)" stroke="var(--aos-ink)" strokeWidth="1.2" />
              </svg>
              {t("rehearsalTown.view.legend.notYet")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <svg width="14" height="10" aria-hidden>
                <rect x="1" y="1" width="12" height="8" fill="var(--aos-paper)" stroke="var(--aos-ink)" strokeWidth="2" />
              </svg>
              {t("rehearsalTown.view.legend.yourStore")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <svg width="14" height="10" aria-hidden>
                <rect x="1" y="1" width="12" height="8" fill="var(--aos-paper)" stroke="var(--aos-text-muted)" strokeDasharray="3 2" />
              </svg>
              {t("rehearsalTown.view.legend.competitor")}
            </span>
            <NeutralBadge size="sm" label={t("rehearsalTown.view.adopters", { count: view.stats.adopters })} />
            <NeutralBadge size="sm" label={t("rehearsalTown.view.visits", { count: view.stats.visits })} />
          </div>
        </div>
        <aside className="flex flex-col gap-3">
          {followedView ? (
            <section className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline" aria-label={t("rehearsalTown.view.thoughtLog")}>
              <div className="flex items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 text-md font-semibold text-ink">
                  <UserRound className="size-4 text-muted" aria-hidden />
                  {t("rehearsalTown.view.following", { name: followedView.name })}
                </h3>
                <button type="button" className={aosButton({ variant: "quiet", size: "xs" })} aria-label={t("rehearsalTown.view.unfollow")} onClick={() => setFollowed(null)}>
                  <X className="size-4" aria-hidden />
                </button>
              </div>
              <p className="text-sm text-muted">
                {followedView.segment} · {followedView.moving ? t("rehearsalTown.view.travelling") : lotName(followedView.lot)}
              </p>
              <h4 className="text-sm font-semibold text-ink">{t("rehearsalTown.view.thoughtLog")}</h4>
              <ol className="flex max-h-72 flex-col gap-1.5 overflow-auto text-sm">
                {(log?.entries ?? []).filter((e) => e.t <= minuteNow).length === 0 ? <li className="text-muted">{t("rehearsalTown.view.noThoughts")}</li> : null}
                {(log?.entries ?? [])
                  .filter((e) => e.t <= minuteNow)
                  .slice(-30)
                  .map((e, i) => (
                    <li key={`${e.t}-${i}`} className="rounded-sm bg-canvas px-2 py-1 text-ink">
                      <span className="font-mono text-xs text-muted">{t("rehearsalTown.view.dayN", { day: Math.floor(e.t / 1440) + 1 })} {String(Math.floor((e.t % 1440) / 60)).padStart(2, "0")}:{String(e.t % 60).padStart(2, "0")}</span> {e.text}
                    </li>
                  ))}
              </ol>
            </section>
          ) : null}
          {lot ? (
            <section className="flex flex-col gap-1.5 rounded-lg bg-paper p-4 shadow-hairline" aria-label={t("rehearsalTown.view.inspect")}>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-md font-semibold text-ink">{t("rehearsalTown.view.building", { name: lot.name, kind: t(`rehearsalTown.view.lotKinds.${lot.kind}` as MessageKey) })}</h3>
                <button type="button" className={aosButton({ variant: "quiet", size: "xs" })} aria-label={t("rehearsalTown.view.inspect")} onClick={() => setInspected(null)}>
                  <X className="size-4" aria-hidden />
                </button>
              </div>
              <p className="text-sm text-muted">{t("rehearsalTown.view.visits", { count: lotStats.current.get(lot.id)?.visits ?? 0 })}</p>
              <p className="text-sm text-muted">
                {t("rehearsalTown.view.residentCols.where")}: {view.residents.filter((r) => r.lot === lot.id).length}
              </p>
            </section>
          ) : null}
        </aside>
      </div>
      <details className="rounded-lg bg-paper p-4 shadow-hairline">
        <summary className="cursor-pointer text-sm font-semibold text-ink">{t("rehearsalTown.view.residentsTable")}</summary>
        <div className="mt-3 max-h-96 overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-1.5 pr-3 font-semibold">{t("rehearsalTown.view.residentCols.name")}</th>
                <th className="py-1.5 pr-3 font-semibold">{t("rehearsalTown.view.residentCols.segment")}</th>
                <th className="py-1.5 pr-3 font-semibold">{t("rehearsalTown.view.residentCols.where")}</th>
                <th className="py-1.5 pr-3 font-semibold">{t("rehearsalTown.view.residentCols.bought")}</th>
                <th className="py-1.5 font-semibold">
                  <span className="sr-only">{t("rehearsalTown.view.follow")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {view.residents.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="py-1.5 pr-3 text-ink">{r.name}</td>
                  <td className="py-1.5 pr-3 text-muted">{r.segment}</td>
                  <td className="py-1.5 pr-3 text-muted">{r.moving ? t("rehearsalTown.view.travelling") : lotName(r.lot)}</td>
                  <td className="py-1.5 pr-3 text-muted">{r.adopted ? t("rehearsalTown.view.yes") : t("rehearsalTown.view.no")}</td>
                  <td className="py-1.5 text-right">
                    <button type="button" className={aosButton({ variant: "secondary", size: "xs" })} onClick={() => setFollowed(r.id)} aria-pressed={followed === r.id}>
                      {t("rehearsalTown.view.follow")} <span className="sr-only">{r.name}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
