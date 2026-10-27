// ShapesOS - choose between declared alternatives of a DRAFTED mission plan.
// Honest scope shown in the UI: these are alternative drafts of the same plan,
// not parallel runs, and no cost forecast exists. Choosing one does not start
// the mission; the plan must still be approved as shown.

"use client";

import { useCallback, useEffect, useState } from "react";
import { toast, toastError } from "@/lib/ui/feedback";
import { aosButton } from "@/components/aos";

interface Alt {
  id: string;
  label: string;
  strategy: string;
  revision: string;
  stepCount: number;
  outsideActionSteps: number;
  checkpointCount: number;
  omitted: string[];
}
interface Data {
  status: string;
  currentRevision: string;
  spendCapCents: number | null;
  alternatives: Alt[];
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
