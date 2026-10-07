"use client";

// ShapesOS — Phase 19B (WS=engine): town results — honest by construction.
// The "not representative" banner, ranges over seeded runs (never a single
// number), seed variance, Test Lab-style badges (underpowered → inconclusive),
// the calibration score shared with the panel (no calibration → no verdict),
// objections traced to interviews, key moments, the export, and "do this for
// real" (a normal proposal: Tier 2, or Tier 3 for ad spend — always asks).
// Neutral pills and ink only: a run is a background job, residents are people.

import { useState } from "react";
import { Download, Info } from "lucide-react";
import { aosButton, NeutralBadge } from "@/components/aos";
import { useI18n } from "@/components/i18n/I18nProvider";
import { toast, toastError } from "@/lib/ui/feedback";
import type { MessageKey } from "@/lib/i18n";
import type { Range, TownReport } from "@/lib/sim/results";
import type { Scenario } from "@/lib/sim/scenario";
import { RangeChart } from "./RangeChart";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function TownBanner({ modelKind }: { modelKind?: string }) {
  const { t } = useI18n();
  return (
    <p role="note" className="flex items-start gap-2 rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink">
      <Info className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
      <span>
        <strong className="font-semibold">{t("rehearsalTown.banner")}</strong>
        {modelKind === "fake" ? <span className="block text-muted">{t("rehearsalTown.fakeModel")}</span> : null}
        {modelKind === "rules" ? <span className="block text-muted">{t("rehearsalTown.rulesOnly")}</span> : null}
      </span>
    </p>
  );
}

function rangeText(r: Range | undefined, f: (n: number) => string): string {
  if (!r) return "—";
  return r.n > 1 ? `${f(r.median)} [${f(r.min)}–${f(r.max)}]` : f(r.median);
}

function RealButton({ runId, variant, index, label, isAd }: { runId: string; variant: "A" | "B"; index: number; label: string; isAd: boolean }) {
  const { t } = useI18n();
  const [state, setState] = useState<{ status: string; summary: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function send(confirmed: boolean) {
    setBusy(true);
    const res = await fetch(`/api/rehearsal/town/runs/${encodeURIComponent(runId)}/real`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ variant, index, confirmed }) }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { status?: string; summary?: string; error?: string } | null;
    setBusy(false);
    if (!res?.ok || !body?.status) return toastError(t("rehearsalTown.results.realFailed"), body?.error);
    setState({ status: body.status, summary: body.summary ?? "" });
  }
  return (
    <li className="flex flex-col gap-1.5 rounded-sm bg-canvas px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-ink">{label}</span>
        {!state ? (
          <button type="button" className={aosButton({ variant: "secondary", size: "xs" })} disabled={busy} onClick={() => void send(false)}>
            {t("rehearsalTown.results.real")}
          </button>
        ) : state.status === "pending_confirmation" ? (
          <button type="button" className={aosButton({ variant: "primary", size: "xs" })} disabled={busy} onClick={() => void send(true)}>
            {t("rehearsalTown.results.realApprove")}
          </button>
        ) : null}
      </div>
      {isAd ? <span className="text-xs text-muted">{t("rehearsalTown.results.realTier3")}</span> : null}
      {state?.status === "pending_confirmation" ? <span className="text-xs text-muted">{t("rehearsalTown.results.realPending")}</span> : null}
      {state && state.status !== "pending_confirmation" ? <span className="text-xs text-muted">{t("rehearsalTown.results.realDone", { summary: state.summary })}</span> : null}
    </li>
  );
}

export interface TownResultsProps {
  runId: string;
  report: TownReport;
  scenarioA: Scenario;
  scenarioB: Scenario | null;
  canEdit: boolean;
  cost: { spent: number; cap: number; calls: number; hits: number };
}

export function TownResults({ runId, report, scenarioA, scenarioB, canEdit, cost }: TownResultsProps) {
  const { t, format } = useI18n();
  const [exporting, setExporting] = useState(false);
  const A = report.variants.A;
  const B = report.variants.B;
  const money = (c: number) => format.money(Math.round(c), "USD");
  const series = (pick: (v: NonNullable<typeof B>) => Range[]) => [
    { label: `A · ${A.label}`, ranges: pick(A) },
    ...(B ? [{ label: `B · ${B.label}`, ranges: pick(B), dashed: true }] : []),
  ];
  async function exportReport() {
    setExporting(true);
    const res = await fetch(`/api/rehearsal/town/runs/${encodeURIComponent(runId)}/export`, { method: "POST" }).catch(() => null);
    setExporting(false);
    if (!res?.ok) return toastError(t("rehearsalTown.results.realFailed"));
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `town-rehearsal-${runId}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: t("rehearsalTown.results.exported"), status: "done" });
  }
  const c = report.comparison;
  return (
    <div className="flex flex-col gap-5">
      <TownBanner modelKind={report.modelKind} />
      {report.stopped ? <p className="rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink">{t("rehearsalTown.results.stopped", { detail: report.stopped.detail })}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <NeutralBadge label={t("rehearsalTown.results.seeds", { count: A.finalAdoption.n })} />
        <NeutralBadge label={t("rehearsalTown.results.cost", { spent: cost.spent, cap: cost.cap, calls: cost.calls, hits: cost.hits })} />
        <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} onClick={() => void exportReport()} disabled={exporting}>
          <Download className="size-4" aria-hidden />
          {exporting ? t("rehearsalTown.results.exporting") : t("rehearsalTown.results.export")}
        </button>
      </div>

      <section className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline">
        <h3 className="aos-subheading">{t("rehearsalTown.results.comparison")}</h3>
        {report.calibration.launches > 0 && report.calibration.score !== null ? (
          <p className="text-sm text-muted">{t("rehearsalTown.results.calibration", { score: report.calibration.score.toFixed(3), count: report.calibration.launches })}</p>
        ) : (
          <p className="text-sm text-muted">{t("rehearsalTown.results.noCalibration")}</p>
        )}
        {c ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <NeutralBadge label={c.verdict ? t(`rehearsalTown.results.verdicts.${c.verdict}` as MessageKey) : t("rehearsalTown.results.withheld")} />
              <NeutralBadge label={t(`rehearsalTown.results.badges.${c.badges.power}` as MessageKey)} />
            </div>
            <p className="text-sm text-ink">{t("rehearsalTown.results.difference", { min: pct(c.difference.min), max: pct(c.difference.max), median: pct(c.difference.median) })}</p>
            <p className="text-sm text-muted">{c.explanation}</p>
          </>
        ) : null}
        <p className="text-sm text-muted">
          {t("rehearsalTown.results.seedVariance", { values: [`A ${pct(report.seedVariance.A)}`, ...(report.seedVariance.B !== undefined ? [`B ${pct(report.seedVariance.B)}`] : [])].join(" · ") })}
        </p>
      </section>

      <section className="flex flex-col gap-4 rounded-lg bg-paper p-4 shadow-hairline">
        <p className="text-xs text-muted">{t("rehearsalTown.results.rangeLegend")}</p>
        <RangeChart title={t("rehearsalTown.results.adoption")} series={series((v) => v.adoption)} format={pct} description={`A ${rangeText(A.finalAdoption, pct)}${B ? `, B ${rangeText(B.finalAdoption, pct)}` : ""}`} />
        <RangeChart title={t("rehearsalTown.results.footTraffic")} series={series((v) => v.footTraffic)} format={(n) => format.number(Math.round(n))} description={t("rehearsalTown.table.caption")} />
        <RangeChart title={t("rehearsalTown.results.revenue")} series={series((v) => v.revenueCents)} format={money} description={t("rehearsalTown.table.caption")} />
      </section>

      <section className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline">
        <h3 className="aos-subheading">{t("rehearsalTown.results.segments")}</h3>
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <th className="py-1.5 pr-3 font-semibold">{t("rehearsalTown.results.segmentCols.segment")}</th>
              <th className="py-1.5 pr-3 font-semibold">{t("rehearsalTown.results.segmentCols.residents")}</th>
              <th className="py-1.5 pr-3 font-semibold">{t("rehearsalTown.results.segmentCols.adoption")} A</th>
              {B ? <th className="py-1.5 pr-3 font-semibold">{t("rehearsalTown.results.segmentCols.adoption")} B</th> : null}
              <th className="py-1.5 font-semibold">{t("rehearsalTown.results.segmentCols.calibrated")}</th>
            </tr>
          </thead>
          <tbody>
            {A.bySegment.map((s) => (
              <tr key={s.segment} className="border-t border-line">
                <td className="py-1.5 pr-3 text-ink">{s.label}</td>
                <td className="py-1.5 pr-3 text-muted">{s.residents}</td>
                <td className="py-1.5 pr-3 text-muted">{rangeText(s.adoption, pct)}</td>
                {B ? <td className="py-1.5 pr-3 text-muted">{rangeText(B.bySegment.find((x) => x.segment === s.segment)?.adoption, pct)}</td> : null}
                <td className="py-1.5 text-muted">{s.calibrated ? t("rehearsalTown.view.yes") : t("rehearsalTown.view.no")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline">
        <h3 className="aos-subheading">{t("rehearsalTown.results.objections")}</h3>
        {[...A.objections, ...(B?.objections ?? [])].length === 0 ? <p className="text-sm text-muted">{t("rehearsalTown.results.noObjections")}</p> : null}
        {[A, ...(B ? [B] : [])].map((v) =>
          v.objections.length ? (
            <table key={v.variant} className="w-full text-left text-sm">
              <caption className="pb-1 text-left text-xs font-semibold text-muted">{`${v.variant} · ${v.label}`}</caption>
              <thead className="text-xs text-muted">
                <tr>
                  <th className="py-1.5 pr-3 font-semibold">{t("rehearsalTown.results.objectionCols.day")}</th>
                  <th className="py-1.5 pr-3 font-semibold">{t("rehearsalTown.results.objectionCols.quote")}</th>
                  <th className="py-1.5 pr-3 font-semibold">{t("rehearsalTown.results.objectionCols.count")}</th>
                  <th className="py-1.5 font-semibold">{t("rehearsalTown.results.objectionCols.source")}</th>
                </tr>
              </thead>
              <tbody>
                {v.objections.slice(0, 20).map((o, i) => (
                  <tr key={`${o.day}-${i}`} className="border-t border-line align-top">
                    <td className="py-1.5 pr-3 text-muted">{o.day + 1}</td>
                    <td className="py-1.5 pr-3 text-ink">“{o.text}”</td>
                    <td className="py-1.5 pr-3 text-muted">{o.count}</td>
                    <td className="py-1.5 text-muted">{o.trace ? `“${o.trace.excerpt}”` : t("rehearsalTown.results.untraced")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null,
        )}
      </section>

      <section className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline">
        <h3 className="aos-subheading">{t("rehearsalTown.results.keyMoments")}</h3>
        {[A, ...(B ? [B] : [])].map((v) => (
          <ol key={v.variant} className="flex flex-col gap-1 text-sm" aria-label={`${v.variant} · ${v.label}`}>
            {v.keyMoments.map((k, i) => (
              <li key={`${k.kind}-${i}`} className="text-ink">
                <span className="font-mono text-xs text-muted">
                  {v.variant} · {t("rehearsalTown.view.dayN", { day: k.day + 1 })} {String(Math.floor((k.t % 1440) / 60)).padStart(2, "0")}:{String(k.t % 60).padStart(2, "0")}
                </span>{" "}
                {k.label}
              </li>
            ))}
          </ol>
        ))}
      </section>

      {canEdit ? (
        <section className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline">
          <h3 className="aos-subheading">{t("rehearsalTown.results.real")}</h3>
          {[
            { v: "A" as const, s: scenarioA, r: A },
            ...(scenarioB && B ? [{ v: "B" as const, s: scenarioB, r: B }] : []),
          ].map(({ v, s, r }) => (
            <ul key={v} className="flex flex-col gap-1.5" aria-label={`${v} · ${s.label}`}>
              {s.interventions.map((iv, i) => (
                <RealButton key={i} runId={runId} variant={v} index={i} label={`${v} · ${r.interventions[i] ?? iv.kind}`} isAd={iv.kind === "ad_campaign"} />
              ))}
            </ul>
          ))}
        </section>
      ) : null}
    </div>
  );
}

export function TownTable({ report }: { report: TownReport }) {
  const { t, format } = useI18n();
  const A = report.variants.A;
  const B = report.variants.B;
  const money = (c: number) => format.money(Math.round(c), "USD");
  const n = (x: number) => format.number(Math.round(x));
  return (
    <section className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline">
      <TownBanner modelKind={report.modelKind} />
      <table className="w-full text-left text-sm">
        <caption className="pb-2 text-left text-sm text-muted">{t("rehearsalTown.table.caption")}</caption>
        <thead className="text-xs text-muted">
          <tr>
            <th className="py-1.5 pr-3 font-semibold">{t("rehearsalTown.table.cols.day")}</th>
            <th className="py-1.5 pr-3 font-semibold">{t("rehearsalTown.table.cols.adoptionA")}</th>
            {B ? <th className="py-1.5 pr-3 font-semibold">{t("rehearsalTown.table.cols.adoptionB")}</th> : null}
            <th className="py-1.5 pr-3 font-semibold">{t("rehearsalTown.table.cols.visitsA")}</th>
            {B ? <th className="py-1.5 pr-3 font-semibold">{t("rehearsalTown.table.cols.visitsB")}</th> : null}
            <th className="py-1.5 pr-3 font-semibold">{t("rehearsalTown.table.cols.revenueA")}</th>
            {B ? <th className="py-1.5 font-semibold">{t("rehearsalTown.table.cols.revenueB")}</th> : null}
          </tr>
        </thead>
        <tbody>
          {A.adoption.map((_, d) => (
            <tr key={d} className="border-t border-line">
              <th scope="row" className="py-1.5 pr-3 font-semibold text-ink">
                {d + 1}
              </th>
              <td className="py-1.5 pr-3 text-muted">{rangeText(A.adoption[d], pct)}</td>
              {B ? <td className="py-1.5 pr-3 text-muted">{rangeText(B.adoption[d], pct)}</td> : null}
              <td className="py-1.5 pr-3 text-muted">{rangeText(A.footTraffic[d], n)}</td>
              {B ? <td className="py-1.5 pr-3 text-muted">{rangeText(B.footTraffic[d], n)}</td> : null}
              <td className="py-1.5 pr-3 text-muted">{rangeText(A.revenueCents[d], money)}</td>
              {B ? <td className="py-1.5 text-muted">{rangeText(B.revenueCents[d], money)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
