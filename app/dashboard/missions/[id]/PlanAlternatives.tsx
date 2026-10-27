// ShapesOS - choose between declared alternatives of a DRAFTED mission plan.
// Honest scope shown in the UI: these are alternative drafts of the same plan,
// not parallel runs, and no cost forecast exists. Choosing one does not start
// the mission; the plan must still be approved as shown.

"use client";

import { useCallback, useEffect, useState } from "react";
import { toast, toastError } from "@/lib/ui/feedback";
import { aosButton } from "@/components/aos";
import { comparePlans, type CompareStep } from "@/lib/missions/plan-compare";

interface Alt {
  id: string;
  label: string;
  strategy: string;
  revision: string;
  stepCount: number;
  outsideActionSteps: number;
  checkpointCount: number;
  omitted: string[];
  steps: CompareStep[];
}
interface Data {
  status: string;
  currentRevision: string;
  spendCapCents: number | null;
  alternatives: Alt[];
}


function PlanComparison({ alternatives, currentRevision }: { alternatives: Alt[]; currentRevision: string }) {
  const result = comparePlans(alternatives.map((a) => ({ id: a.id, label: a.label, steps: a.steps })));
  const cols = `minmax(0,1.4fr) repeat(${alternatives.length}, minmax(0,1fr))`;
  return (
    <details className="mt-3 scroll-mt-20 rounded-md bg-canvas p-3" data-testid="plan-compare">
      <summary className="cursor-pointer text-sm font-semibold text-ink">Compare steps side by side</summary>
      <p className="mt-2 text-xs text-muted">
        These are variants of one template plan, not independent runs, laid next to each other step by step. Nothing was run to produce this, and there is no time or cost estimate.
        Differences are shown against the first variant.
      </p>
      <div role="table" aria-label="Plan variants compared" className="mt-2 text-xs">
        <div role="row" className="grid gap-2 border-b border-hairline pb-1 font-semibold text-ink" style={{ gridTemplateColumns: cols }}>
          <span role="columnheader">Step</span>
          {alternatives.map((a) => (
            <span role="columnheader" key={a.id}>
              {a.label}
              {a.revision === currentRevision ? " (current)" : ""}
            </span>
          ))}
        </div>
        {result.rows.map((r) => (
          <div role="row" key={r.key} data-testid={`compare-row-${r.key}`} className="grid gap-2 border-b border-hairline py-1" style={{ gridTemplateColumns: cols }}>
            <span role="rowheader" className="text-ink">{r.title}</span>
            {r.cells.map((c, i) => (
              <span role="cell" key={alternatives[i].id} data-diff={r.diff[i]} className={r.diff[i] === "missing" ? "text-muted" : r.diff[i] === "changed" ? "font-semibold text-ink" : "text-ink"}>
                {c === null ? (
                  "Not in this variant"
                ) : (
                  <>
                    <span className="block">{c.executor}</span>
                    <span className="block text-muted">
                      {c.tier > 0 ? `T${c.tier}, outside` : "T0"}
                      {c.checkpointAfter ? ", CP" : ""}
                    </span>
                  </>
                )}
              </span>
            ))}
          </div>
        ))}
      </div>
      <p data-testid="compare-legend" className="mt-2 text-xs text-muted">
        Key: T0 = step marked as making no outside action. T1 or T2 = marked as acting outside the workspace. CP = a checkpoint label after the step. These are labels on each step as written, not a forecast.
      </p>
      <ul className="mt-2 scroll-mb-28 text-xs text-muted">
        {result.summary.slice(1).map((s) => (
          <li key={s.id}>
            {s.label}: {s.missingFromBaseline} step{s.missingFromBaseline === 1 ? "" : "s"} left out, {s.changed} changed, {s.notInBaseline} added, compared with {alternatives[0].label}.
          </li>
        ))}
      </ul>
    </details>
  );
}

export function PlanAlternatives({ missionId, status, onChanged }: { missionId: string; status: string; onChanged: () => Promise<void> | void }) {
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cp, setCp] = useState<{ enabled: boolean; reason: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/missions/${missionId}/plan-alternatives`);
      const j = (await r.json()) as Data & { error?: string };
      if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
      setData(j);
      setError(null);
      const c = await fetch(`/api/missions/${missionId}/competing-plans`);
      if (c.ok) setCp((await c.json()) as { enabled: boolean; reason: string });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the plan alternatives.");
    }
  }, [missionId]);

  useEffect(() => {
    void load();
  }, [load, status]);

  if (status !== "planned") return null;
  if (error) return <p role="alert" className="mb-4 text-md text-failed-text">{error}</p>;
  if (!data || data.alternatives.length < 2) return null;

  async function choose(a: Alt) {
    if (!data) return;
    setBusy(a.id);
    try {
      const r = await fetch(`/api/missions/${missionId}/plan-alternatives`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alternativeId: a.id, planRevision: data.currentRevision }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
      toast({ title: "Plan changed", description: "The mission has not started. Review the plan, then approve it.", status: "done" });
      await onChanged();
      await load();
    } catch (e) {
      toastError("Couldn't change the plan", e instanceof Error ? e.message : undefined);
      await load();
    } finally {
      setBusy(null);
    }
  }

  const cap = data.spendCapCents === null ? null : `$${(data.spendCapCents / 100).toLocaleString("en-US")}`;
  return (
    <section aria-label="Plan variants" className="mb-5 rounded-lg bg-paper px-4 py-4 shadow-hairline">
      <h3 className="text-md font-semibold text-ink">Plan variants</h3>
      <p className="mt-1 text-sm text-muted">
        Variants of this one template plan, not independent competing plans. They are not run side by side, and no time or cost forecast is made for any of them.
        {cap ? ` The mission's spend limit is ${cap} whichever you choose; that is a limit, not an estimate.` : " Cost: unknown."}{" "}
        Choosing one does not start the mission. You still approve the plan you end up with.
      </p>
      <ul className="mt-3 grid gap-3 md:grid-cols-3">
        {data.alternatives.map((a) => {
          const current = a.revision === data.currentRevision;
          return (
            <li key={a.id} data-testid={`alt-${a.id}`} className="flex flex-col gap-2 rounded-md bg-canvas p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-ink">{a.label}</span>
                {current ? <span className="rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-ink shadow-control">Current plan</span> : null}
              </div>
              <p className="text-xs text-muted">{a.strategy}</p>
              <p className="text-xs text-ink">
                {a.stepCount} steps, {a.outsideActionSteps} marked as acting outside the workspace
              </p>
              {a.omitted.length > 0 ? <p className="text-xs text-muted">Leaves out: {a.omitted.join(", ")}</p> : null}
              <div className="mt-auto pt-1">
                <button
                  type="button"
                  className={aosButton({ variant: "secondary", size: "sm" })}
                  disabled={current || busy !== null}
                  onClick={() => void choose(a)}
                >
                  {current ? "In use" : busy === a.id ? "Switching..." : "Use this plan"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <PlanComparison alternatives={data.alternatives} currentRevision={data.currentRevision} />
      <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md bg-canvas p-3" data-testid="competing-plans-gate">
        <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} disabled>
          Generate competing plans
        </button>
        <p className="text-xs text-muted">
          Independent competing plans are not available. {cp ? cp.reason : "They would call a paid model."}
        </p>
      </div>
    </section>
  );
}
