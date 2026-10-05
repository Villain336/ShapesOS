// ShapesOS — Phase 16: the run page's delegation plan, live.
//
// Server-rendered first (the view the page loaded), then kept current by the
// watch SSE (GET /api/agent-runs/[runId]/watch?view=delegation): each
// sub-agent's state, budget used and deliverable as it lands. The stream
// ends when the run finishes or waits for the user.

"use client";

import { useEffect, useState } from "react";
import { DelegationPlan } from "@/components/aos/DelegationPlan";
import { StatusShape } from "@/components/aos/StatusShape";
import { formatBudget, viewProgress, type DelegationView } from "@/lib/aos/delegation";
import { progressLine } from "@/lib/agents/delegation/plan";

export function DelegationPlanLive({ initial }: { initial: DelegationView }) {
  const [view, setView] = useState<DelegationView>(initial);

  useEffect(() => {
    if (!initial.live) return;
    const es = new EventSource(`/api/agent-runs/${encodeURIComponent(initial.runId)}/watch?view=delegation`);
    const onView = (e: Event) => {
      try {
        setView(JSON.parse((e as MessageEvent).data) as DelegationView);
      } catch {
        // Malformed frame: keep the last view.
      }
    };
    es.addEventListener("delegation", onView);
    es.addEventListener("end", () => es.close());
    es.onerror = () => es.close();
    return () => es.close();
  }, [initial.live, initial.runId]);

  const total = viewProgress(view);
  return (
    <section className="overflow-hidden rounded-lg bg-paper shadow-hairline" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <h2 className="aos-subheading">Delegation plan</h2>
          <p className="mt-0.5 text-sm text-muted">{progressLine(total)} · the lead checks and merges every result</p>
        </div>
        {view.live ? (
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink">
            <StatusShape status={view.runStatus === "awaiting_confirmation" ? "needs" : "running"} size={9} />
            {view.runStatus === "awaiting_confirmation" ? "Needs you" : "Live"}
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-5 p-5">
        {view.plans.map((p) => (
          <div key={p.planId} className="flex flex-col gap-2">
            <div>
              <p className="text-md font-semibold text-ink">
                {p.round > 0 ? "Retry: " : ""}
                {p.goal}
              </p>
              <p className="text-sm text-muted">
                {p.line} · merge: {p.mergeInstructions} · kept for the merge: {formatBudget(p.reserve)}
              </p>
            </div>
            <div className="rounded-lg border border-line">
              <DelegationPlan plan={p} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default DelegationPlanLive;
