"use client";

// ShapesOS — Phase 19B (WS=engine): the Town tab of /dashboard/rehearsal.
//   setup (town, residents, days, seeds, scenario A vs B, estimate + confirmed
//   cap) → runs (a `town_run` job each) → a run: live map (SSE playback),
//   results (ranges over seeds, A vs B, objections, export, "do this for
//   real") and a day-by-day table. Loaded lazily by RehearsalApp (next/dynamic).
// Run states are neutral pills — a run is a background job, not an agent.

import { useCallback, useEffect, useRef, useState } from "react";
import { Building2, ChartLine, Map as MapIcon, RotateCcw, Square, Table2 } from "lucide-react";
import { aosButton, NeutralBadge } from "@/components/aos";
import { useI18n } from "@/components/i18n/I18nProvider";
import { toast, toastError } from "@/lib/ui/feedback";
import type { MessageKey } from "@/lib/i18n";
import type { PersonaView } from "@/lib/panel/service.server";
import type { TownRunView, WorldView } from "@/lib/sim/service.server";
import type { ResidentMeta } from "@/lib/sim/view-model";
import { TownLive } from "./TownLive";
import { TownBanner, TownResults, TownTable } from "./TownResults";
import { TownSetup } from "./TownSetup";

type RunRow = TownRunView & { hasReport?: boolean };

async function getJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { cache: "no-store" }).catch(() => null);
  return res?.ok ? ((await res.json().catch(() => null)) as T | null) : null;
}

function RunView({ runId, canEdit, onChange }: { runId: string; canEdit: boolean; onChange: () => void }) {
  const { t } = useI18n();
  const [data, setData] = useState<{ run: TownRunView; world: WorldView | null; residents: ResidentMeta[] } | null>(null);
  const [tab, setTab] = useState<"map" | "results" | "table">("map");
  const changed = useRef(onChange);
  changed.current = onChange;
  const load = useCallback(async () => {
    const d = await getJson<{ run: TownRunView; world: WorldView | null; residents: Array<ResidentMeta & { homeLotId: string }> }>(`/api/rehearsal/town/runs/${encodeURIComponent(runId)}`);
    if (d) setData(d);
    return d;
  }, [runId]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let live = true;
    const tick = async () => {
      const d = await load();
      if (live && d && (d.run.status === "queued" || d.run.status === "running")) timer = setTimeout(tick, 3_000);
      else if (live) changed.current();
    };
    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  if (!data) return null;
  const { run, world, residents } = data;
  const tabs = [
    { id: "map" as const, label: t("rehearsalTown.view.tabs.map"), icon: MapIcon },
    { id: "results" as const, label: t("rehearsalTown.view.tabs.results"), icon: ChartLine },
    { id: "table" as const, label: t("rehearsalTown.view.tabs.table"), icon: Table2 },
  ];
  async function act(path: "cancel" | "replay") {
    const res = await fetch(`/api/rehearsal/town/runs/${encodeURIComponent(runId)}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(path === "replay" ? { capCredits: run.capCredits, confirmed: true } : {}),
    }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { error?: string } | null;
    if (!res?.ok) return toastError(t("rehearsalTown.estimate.failed"), body?.error);
    if (path === "replay") toast({ title: t("rehearsalTown.runs.replayed"), status: "done" });
    onChange();
    void load();
  }
  return (
    <section className="flex flex-col gap-4 rounded-lg bg-paper p-4 shadow-hairline" aria-labelledby={`town-run-${run.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`town-run-${run.id}`} className="aos-subheading">
          {run.scenarioA.label}
          {run.scenarioB ? ` · ${run.scenarioB.label}` : ""}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <NeutralBadge label={t(`rehearsalTown.runs.statuses.${run.status}` as MessageKey)} />
          {canEdit && (run.status === "queued" || run.status === "running") ? (
            <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} onClick={() => void act("cancel")}>
              <Square className="size-4" aria-hidden />
              {t("rehearsalTown.runs.cancel")}
            </button>
          ) : null}
          {canEdit && run.status !== "queued" && run.status !== "running" ? (
            <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} onClick={() => void act("replay")}>
              <RotateCcw className="size-4" aria-hidden />
              {t("rehearsalTown.runs.replay")}
            </button>
          ) : null}
        </div>
      </div>
      <TownBanner modelKind={run.mode === "rules" ? "rules" : run.modelKind} />
      <div className="flex gap-1 border-b border-line" role="tablist" aria-label={t("rehearsalTown.view.scenario")}>
        {tabs.map((x) => {
          const Icon = x.icon;
          return (
            <button
              key={x.id}
              type="button"
              role="tab"
              id={`town-view-tab-${x.id}`}
              aria-selected={tab === x.id}
              aria-controls={`town-view-panel-${x.id}`}
              onClick={() => setTab(x.id)}
              className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition ${tab === x.id ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"}`}
            >
              <Icon className="size-4" aria-hidden />
              {x.label}
            </button>
          );
        })}
      </div>
      <div id={`town-view-panel-${tab}`} role="tabpanel" aria-labelledby={`town-view-tab-${tab}`}>
        {tab === "map" && world ? <TownLive key={`${run.id}-${run.status === "running" ? "live" : "done"}`} runId={run.id} layout={world.layout} residents={residents} days={run.days} hasB={Boolean(run.scenarioB)} status={run.status} /> : null}
        {tab !== "map" && !run.report ? <p className="text-sm text-muted">{t("rehearsalTown.results.notReady")}</p> : null}
        {tab === "results" && run.report ? (
          <TownResults runId={run.id} report={run.report} scenarioA={run.scenarioA} scenarioB={run.scenarioB} canEdit={canEdit} cost={{ spent: run.spentCredits, cap: run.capCredits, calls: run.callCount, hits: run.cacheHits }} />
        ) : null}
        {tab === "table" && run.report ? <TownTable report={run.report} /> : null}
      </div>
    </section>
  );
}

export default function TownTab({ canEdit, personas }: { canEdit: boolean; personas: PersonaView[] }) {
  const { t, format } = useI18n();
  const [worlds, setWorlds] = useState<WorldView[] | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [w, r] = await Promise.all([getJson<{ worlds: WorldView[] }>("/api/rehearsal/town/worlds"), getJson<{ runs: RunRow[] }>("/api/rehearsal/town/runs")]);
    if (w) setWorlds(w.worlds);
    if (r) setRuns(r.runs);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start gap-2">
        <Building2 className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
        <p className="max-w-[72ch] text-md text-muted">{t("rehearsalTown.intro")}</p>
      </div>
      <TownBanner />
      {canEdit && worlds ? <TownSetup worlds={worlds} personas={personas} onWorlds={(w) => setWorlds(w)} onStarted={(id) => (void refresh(), setOpen(id))} /> : null}
      <section className="flex flex-col gap-3 rounded-lg bg-paper p-4 shadow-hairline" aria-labelledby="town-runs-title">
        <h2 id="town-runs-title" className="aos-subheading">
          {t("rehearsalTown.runs.title")}
        </h2>
        {runs.length === 0 ? (
          <p className="text-sm text-muted">{t("rehearsalTown.runs.empty")}</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-1.5 pr-3 font-semibold">{t("rehearsalTown.runs.cols.run")}</th>
                <th className="py-1.5 pr-3 font-semibold">{t("rehearsalTown.runs.cols.status")}</th>
                <th className="py-1.5 pr-3 font-semibold">{t("rehearsalTown.runs.cols.residents")}</th>
                <th className="py-1.5 pr-3 font-semibold">{t("rehearsalTown.runs.cols.credits")}</th>
                <th className="py-1.5 pr-3 font-semibold">{t("rehearsalTown.runs.cols.created")}</th>
                <th className="py-1.5 font-semibold">
                  <span className="sr-only">{t("rehearsalTown.runs.open")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="py-1.5 pr-3 text-ink">
                    {r.scenarioA.label}
                    {r.scenarioB ? ` · ${r.scenarioB.label}` : ""}
                  </td>
                  <td className="py-1.5 pr-3">
                    <NeutralBadge size="sm" label={t(`rehearsalTown.runs.statuses.${r.status}` as MessageKey)} />
                  </td>
                  <td className="py-1.5 pr-3 text-muted">{t("rehearsalTown.runs.residentsDays", { residents: r.population, days: r.days })}</td>
                  <td className="py-1.5 pr-3 text-muted">
                    {r.spentCredits} / {r.capCredits}
                  </td>
                  <td className="py-1.5 pr-3 text-muted">{format.relative(r.createdAt)}</td>
                  <td className="py-1.5 text-right">
                    <button type="button" className={aosButton({ variant: open === r.id ? "primary" : "secondary", size: "xs" })} aria-pressed={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
                      {t("rehearsalTown.runs.open")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {open ? <RunView key={open} runId={open} canEdit={canEdit} onChange={() => void refresh()} /> : null}
    </div>
  );
}
