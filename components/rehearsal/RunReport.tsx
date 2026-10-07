"use client";

// ShapesOS — Phase 19B (WS=panel): one run's report.
//   the distribution (names per bucket, never a single %), withheld verdicts
//   and why, ranked objections with the interview words behind them, section
//   heat, suggested fixes, every persona's walk with screenshots, a diff
//   against another run, and the track record (real conversions → the
//   calibration score). "Synthetic; directional" is always on screen; a fake-
//   model run says so too. While a run is queued or running it is polled.

import { useCallback, useEffect, useState } from "react";
import { GitCompare, Quote, ScrollText, Target, Wrench, X } from "lucide-react";
import { aosButton, NeutralBadge } from "@/components/aos";
import { useI18n } from "@/components/i18n/I18nProvider";
import { toast, toastError } from "@/lib/ui/feedback";
import type { MessageKey } from "@/lib/i18n";
import type { ReportDiff } from "@/lib/panel/aggregate";
import type { CalibrationSummary, CalibrationView, RunView, StepView, VerdictView } from "@/lib/panel/service.server";
import { inputClass, SyntheticNote } from "./ui";

interface RunDetail {
  run: RunView;
  steps: StepView[];
  verdicts: VerdictView[];
  calibration: CalibrationView | null;
}

const POLL_MS = 4_000;
const cardClass = "flex flex-col gap-3 rounded-lg bg-paper p-4 shadow-hairline";
const shotUrl = (ref: string) => `/api/rehearsal/artifacts?ref=${encodeURIComponent(ref)}`;

export function RunReportView({ runId, runs, canEdit, onClose, onChange }: { runId: string; runs: RunView[]; canEdit: boolean; onClose: () => void; onChange: () => Promise<void> }) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<RunDetail | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/rehearsal/runs/${encodeURIComponent(runId)}`, { cache: "no-store" }).catch(() => null);
    if (res?.ok) setDetail((await res.json()) as RunDetail);
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  const live = detail?.run.status === "queued" || detail?.run.status === "running";
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => void load().then(() => onChange()), POLL_MS);
    return () => clearInterval(id);
  }, [live, load, onChange]);

  if (!detail) return null;
  const { run } = detail;
  const report = run.report;
  return (
    <section aria-labelledby="rh-report" className="flex flex-col gap-4 rounded-lg border border-line p-4">
      <div className="flex flex-wrap items-center gap-2">
        <ScrollText className="size-4 text-muted" aria-hidden />
        <h2 id="rh-report" className="aos-subheading min-w-0 flex-1">
          {t("rehearsal.report.title", { page: run.targetLabel })}
        </h2>
        <NeutralBadge size="sm" label={t(`rehearsal.runs.statuses.${run.status}` as MessageKey)} />
        <button type="button" onClick={onClose} aria-label={t("rehearsal.report.close")} className={aosButton({ variant: "quiet", size: "xs" })}>
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <SyntheticNote fake={run.modelKind === "fake"} />
      <p className="text-sm text-muted">{t("rehearsal.report.spend", { spent: run.spentCredits, cap: run.capCredits, estimate: run.estimateCredits })}</p>
      {run.status === "partial" || run.status === "failed" ? (
        <p className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink">
          <strong className="font-semibold">{run.status === "partial" ? t("rehearsal.report.partial") : t("rehearsal.runs.statuses.failed")}.</strong> {run.stopReason}
        </p>
      ) : null}
      {!report ? (
        <p className="text-sm text-muted">{t("rehearsal.report.waiting")}</p>
      ) : (
        <>
          <Distribution report={report} />
          <Objections report={report} />
          <Heat report={report} />
          <Fixes report={report} />
          <Walks steps={detail.steps} verdicts={detail.verdicts} />
          <Compare runId={run.id} runs={runs.filter((r) => r.id !== run.id && (r.status === "completed" || r.status === "partial"))} />
          <TrackRecord runId={run.id} calibration={detail.calibration} canEdit={canEdit} onSaved={async () => (await load(), await onChange())} />
        </>
      )}
    </section>
  );
}

type Report = NonNullable<RunView["report"]>;

function Distribution({ report }: { report: Report }) {
  const { t } = useI18n();
  const d = report.distribution;
  const total = d.buy.length + d.maybe.length + d["no-buy"].length;
  const buckets: Array<{ key: "buy" | "maybe" | "no-buy"; label: string }> = [
    { key: "buy", label: t("rehearsal.report.buckets.buy") },
    { key: "maybe", label: t("rehearsal.report.buckets.maybe") },
    { key: "no-buy", label: t("rehearsal.report.buckets.noBuy") },
  ];
  return (
    <div className={cardClass}>
      <h3 className="text-md font-semibold text-ink">{t("rehearsal.report.distribution")}</h3>
      <div className="grid gap-3 md:grid-cols-3">
        {buckets.map((b) => (
          <div key={b.key} className="rounded-md border border-line p-3" data-bucket={b.key}>
            <p className="text-sm font-semibold text-ink">
              {b.label} <span className="font-normal text-muted">· {t("rehearsal.report.ofJudged", { count: d[b.key].length, total })}</span>
            </p>
            <p className="text-sm text-ink">{d[b.key].length ? d[b.key].join(", ") : <span className="text-muted">{t("rehearsal.report.nobody")}</span>}</p>
          </div>
        ))}
      </div>
      {report.withheld.length ? (
        <div className="text-sm">
          <p className="font-semibold text-ink">{t("rehearsal.report.withheld")}</p>
          <ul className="list-disc pl-5 text-muted">
            {report.withheld.map((w) => (
              <li key={w.personaKey}>
                <span className="text-ink">{w.personaName}</span>: {t(`rehearsal.report.withheldReasons.${w.reason}` as MessageKey)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Objections({ report }: { report: Report }) {
  const { t } = useI18n();
  return (
    <div className={cardClass}>
      <h3 className="flex items-center gap-2 text-md font-semibold text-ink">
        <Quote className="size-4 text-muted" aria-hidden />
        {t("rehearsal.report.objections")}
      </h3>
      {report.rankedObjections.length === 0 ? (
        <p className="text-sm text-muted">{t("rehearsal.report.noObjections")}</p>
      ) : (
        <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm">
          {report.rankedObjections.map((c) => (
            <li key={c.representativeQuote} className="text-ink">
              <p className="font-semibold">“{c.representativeQuote}”</p>
              <p className="text-xs text-muted">{t("rehearsal.report.raisedBy", { names: c.personaNames.join(", ") })} · {c.sections.join(", ")}</p>
              {c.interviewQuotes.length ? (
                <div className="mt-1 rounded-md bg-canvas px-3 py-2">
                  <p className="text-xs font-semibold text-muted">{t("rehearsal.report.interviewWords")}</p>
                  {c.interviewQuotes.map((q) => (
                    <blockquote key={q.excerpt} className="text-sm text-ink">
                      “{q.excerpt}”
                    </blockquote>
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-xs text-muted">{t("rehearsal.report.pageOnly")}</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Heat({ report }: { report: Report }) {
  const { t, format } = useI18n();
  const max = Math.max(1, ...report.sectionHeat.map((h) => h.totalFriction));
  return (
    <div className={cardClass}>
      <h3 className="flex items-center gap-2 text-md font-semibold text-ink">
        <Target className="size-4 text-muted" aria-hidden />
        {t("rehearsal.report.heat")}
      </h3>
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
          <caption className="sr-only">{t("rehearsal.report.heat")}</caption>
          <thead>
            <tr className="border-b border-line text-xs text-muted">
              <th scope="col" className="px-2 py-2 font-semibold">{t("rehearsal.report.heatCols.section")}</th>
              <th scope="col" className="px-2 py-2 font-semibold">{t("rehearsal.report.heatCols.friction")}</th>
              <th scope="col" className="px-2 py-2 font-semibold">{t("rehearsal.report.heatCols.bounces")}</th>
              <th scope="col" className="px-2 py-2 font-semibold">{t("rehearsal.report.heatCols.dwell")}</th>
            </tr>
          </thead>
          <tbody>
            {report.sectionHeat.map((h) => (
              <tr key={h.name} className="border-b border-line last:border-b-0">
                <td className="px-2 py-2 font-semibold text-ink">{h.name}</td>
                <td className="px-2 py-2">
                  <span className="flex items-center gap-2">
                    <span className="h-2 rounded-full bg-ink" style={{ width: `${Math.round((h.totalFriction / max) * 96)}px` }} aria-hidden />
                    <span className="text-ink">{h.totalFriction}</span>
                  </span>
                </td>
                <td className="px-2 py-2 text-ink">{h.bounceCount}</td>
                <td className="px-2 py-2 text-muted">{format.number(h.avgDwellMs / 1000, { maximumFractionDigits: 1 })} s</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Fixes({ report }: { report: Report }) {
  const { t } = useI18n();
  if (report.fixes.length === 0 && !report.fixesSkippedAtCap) return null;
  return (
    <div className={cardClass}>
      <h3 className="flex items-center gap-2 text-md font-semibold text-ink">
        <Wrench className="size-4 text-muted" aria-hidden />
        {t("rehearsal.report.fixes")}
      </h3>
      <ul className="flex flex-col gap-2 text-sm">
        {report.fixes.map((f) => (
          <li key={f.objection} className="flex flex-col gap-1">
            <span className="text-ink">{f.suggestedFix}</span>
            <span className="text-xs text-muted">
              <NeutralBadge size="sm" label={t(`rehearsal.report.impact.${f.expectedImpact}` as MessageKey)} /> “{f.objection}”
            </span>
          </li>
        ))}
      </ul>
      {report.fixesSkippedAtCap ? <p className="text-xs text-muted">{t("rehearsal.report.fixesSkipped", { count: report.fixesSkippedAtCap })}</p> : null}
    </div>
  );
}

function Walks({ steps, verdicts }: { steps: StepView[]; verdicts: VerdictView[] }) {
  const { t } = useI18n();
  return (
    <div className={cardClass}>
      <h3 className="text-md font-semibold text-ink">{t("rehearsal.report.walks")}</h3>
      {verdicts.map((v) => {
        const mine = steps.filter((s) => s.personaKey === v.personaKey);
        return (
          <details key={v.personaKey} className="rounded-md border border-line p-3">
            <summary className="cursor-pointer text-sm font-semibold text-ink">
              {v.personaName} · {t(`rehearsal.report.outcomes.${v.outcome}` as MessageKey)}
              {v.verdict ? ` · ${t(`rehearsal.report.buckets.${v.verdict === "no-buy" ? "noBuy" : v.verdict}` as MessageKey)}` : ` · ${t("rehearsal.report.withheld")}`}
            </summary>
            {v.rationale ? <p className="mt-2 text-sm text-muted">{v.rationale}</p> : null}
            <ol className="mt-2 flex flex-col gap-3">
              {mine.map((s) => (
                <li key={s.stepIndex} className="flex flex-col gap-1 border-l-2 border-line pl-3 text-sm">
                  <span className="font-mono text-xs text-muted">{t("rehearsal.report.step", { n: s.stepIndex + 1 })} · {s.observation.type}</span>
                  {s.thinkAloud ? (
                    <p className="text-ink">
                      <span className="font-semibold">{t("rehearsal.report.thinkAloud")}: </span>
                      {s.thinkAloud}
                    </p>
                  ) : null}
                  {s.observation.textExcerpt ? <p className="text-muted">{s.observation.textExcerpt.slice(0, 280)}</p> : null}
                  {s.screenshotRef ? (
                    // eslint-disable-next-line @next/next/no-img-element -- an authenticated blob route, not a static asset
                    <img src={shotUrl(s.screenshotRef)} alt={t("rehearsal.report.screenshot", { n: s.stepIndex + 1, name: v.personaName })} loading="lazy" className="max-h-56 w-auto max-w-full self-start rounded-md border border-line" />
                  ) : null}
                </li>
              ))}
            </ol>
          </details>
        );
      })}
    </div>
  );
}

function Compare({ runId, runs }: { runId: string; runs: RunView[] }) {
  const { t } = useI18n();
  const [other, setOther] = useState("");
  const [diff, setDiff] = useState<ReportDiff | null>(null);
  async function compare(before: string) {
    setOther(before);
    setDiff(null);
    if (!before) return;
    const res = await fetch(`/api/rehearsal/runs/diff?before=${encodeURIComponent(before)}&after=${encodeURIComponent(runId)}`, { cache: "no-store" }).catch(() => null);
    const j = (await res?.json().catch(() => null)) as { diff?: ReportDiff; error?: string } | null;
    if (!res?.ok || !j?.diff) return toastError(t("rehearsal.report.compareFailed"), j?.error);
    setDiff(j.diff);
  }
  if (runs.length === 0) return null;
  const bucketLabel = (b: string) => t(`rehearsal.report.buckets.${b === "no-buy" ? "noBuy" : b}` as MessageKey);
  return (
    <div className={cardClass}>
      <label className="flex flex-col gap-1.5 text-sm font-semibold text-ink">
        <span className="flex items-center gap-2">
          <GitCompare className="size-4 text-muted" aria-hidden />
          {t("rehearsal.report.compare")}
        </span>
        <select value={other} onChange={(e) => void compare(e.target.value)} className={`${inputClass} max-w-md`}>
          <option value="">{t("rehearsal.report.comparePick")}</option>
          {runs.map((r) => (
            <option key={r.id} value={r.id}>
              {r.targetLabel} · {r.createdAt.slice(0, 16).replace("T", " ")}
            </option>
          ))}
        </select>
      </label>
      {diff ? (
        <div className="flex flex-col gap-2 text-sm">
          <ul className="flex flex-col gap-1">
            {diff.distribution.map((d) => (
              <li key={d.bucket} className="text-ink">
                {t("rehearsal.report.bucketShift", { bucket: bucketLabel(d.bucket), before: d.before, after: d.after })}
              </li>
            ))}
          </ul>
          <ul className="flex flex-col gap-1">
            {diff.objections.map((o) => (
              <li key={o.quote} className="text-ink">
                <NeutralBadge size="sm" label={t(`rehearsal.report.changes.${o.change}` as MessageKey)} /> “{o.quote}” ·{" "}
                <span className="text-muted">{t("rehearsal.report.objectionShift", { before: `${o.before.count}/${o.before.of}`, after: `${o.after.count}/${o.after.of}` })}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function TrackRecord({ runId, calibration, canEdit, onSaved }: { runId: string; calibration: CalibrationView | null; canEdit: boolean; onSaved: () => Promise<void> }) {
  const { t } = useI18n();
  const [conversions, setConversions] = useState(calibration ? String(calibration.actualConversions) : "");
  const [visitors, setVisitors] = useState(calibration ? String(calibration.actualVisitors) : "");
  const [busy, setBusy] = useState(false);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  async function save() {
    setBusy(true);
    const res = await fetch(`/api/rehearsal/runs/${encodeURIComponent(runId)}/launch`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversions: Number(conversions), visitors: Number(visitors) }) }).catch(() => null);
    const j = (await res?.json().catch(() => null)) as { summary?: CalibrationSummary; error?: string } | null;
    setBusy(false);
    if (!res?.ok) return toastError(t("rehearsal.track.failed"), j?.error);
    toast({ title: t("rehearsal.track.saved"), status: "done" });
    await onSaved();
  }
  return (
    <div className={cardClass}>
      <h3 className="text-md font-semibold text-ink">{t("rehearsal.track.title")}</h3>
      <p className="text-sm text-muted">{t("rehearsal.track.body")}</p>
      {calibration ? (
        <p className="text-sm text-ink">
          {t("rehearsal.track.thisRun", { predicted: pct(calibration.predictedRate), actual: pct(calibration.actualRate), verdict: t(`rehearsal.track.verdicts.${calibration.verdict}` as MessageKey) })}
        </p>
      ) : null}
      {canEdit ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm font-semibold text-ink">
            {t("rehearsal.track.conversions")}
            <input type="number" min={0} value={conversions} onChange={(e) => setConversions(e.target.value)} className={`${inputClass} w-32`} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-semibold text-ink">
            {t("rehearsal.track.visitors")}
            <input type="number" min={1} value={visitors} onChange={(e) => setVisitors(e.target.value)} className={`${inputClass} w-32`} />
          </label>
          <button type="submit" disabled={busy || !visitors} className={aosButton({ variant: "secondary", size: "md" })}>
            {t("rehearsal.track.save")}
          </button>
        </form>
      ) : null}
    </div>
  );
}
