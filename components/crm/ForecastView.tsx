// Marketr CRM — forecast tab: weighted pipeline by stage.
"use client";

import { useEffect, useState } from "react";
import { ChartLine } from "lucide-react";
import type { CrmPipeline } from "./types";
import { formatMoney } from "./types";
import { StageBadge, EmptyState } from "./ui";

interface StageForecast {
  stage: string;
  label: string;
  count: number;
  openValueCents: number;
  weightedCents: number;
  wonCents: number;
  lostCents: number;
}

export function ForecastView({ pipelineId }: { pipelineId: string }) {
  const [stages, setStages] = useState<StageForecast[]>([]);
  const [total, setTotal] = useState({ openValueCents: 0, weightedCents: 0, wonCents: 0, lostCents: 0 });
  const [loading, setLoading] = useState(true);
  const [pipeline, setPipeline] = useState<CrmPipeline | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/crm/forecast?pipelineId=${pipelineId}`)
      .then((r) => r.json())
      .then((d) => {
        setStages(d.stages ?? []);
        setTotal(d.total ?? { openValueCents: 0, weightedCents: 0, wonCents: 0, lostCents: 0 });
        // Stage colors come from the pipeline detail; fetch it once.
        return fetch("/api/crm/pipelines").then((r) => r.json());
      })
      .then((d) => {
        const p = (d.pipelines ?? []).find((x: CrmPipeline) => x.id === pipelineId);
        setPipeline(p ?? null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [pipelineId]);

  if (loading) return <p className="py-12 text-center text-sm text-muted">Loading forecast…</p>;
  if (stages.length === 0) {
    return <EmptyState icon={ChartLine} title="No forecast yet" hint="Add leads with values to see the weighted pipeline forecast." />;
  }

  const max = Math.max(1, ...stages.map((s) => s.openValueCents));
  const colorOf = (id: string) => pipeline?.stages.find((s) => s.id === id)?.color ?? "gray";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Open pipeline", total.openValueCents, "text-ink"],
          ["Weighted forecast", total.weightedCents, "text-ink"],
          ["Won", total.wonCents, "text-ink"],
          ["Lost", total.lostCents, "text-ink"],
        ].map(([k, v, cls]) => (
          <div key={k as string} className="rounded-md border border-line bg-paper p-4">
            <div className={`text-[20px] font-bold tabular-nums ${cls}`}>{formatMoney(v as number)}</div>
            <div className="mt-0.5 text-[12px] text-muted">{k as string}</div>
          </div>
        ))}
      </div>
      <div className="overflow-hidden rounded-md border border-line bg-paper">
        <div className="border-b border-line bg-canvas px-4 py-2.5 text-[12px] font-semibold text-muted">
          Weighted forecast by stage (value × score ÷ 100)
        </div>
        {stages.map((s) => (
          <div key={s.stage} className="border-b border-line px-4 py-3 last:border-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <StageBadge label={s.label} color={colorOf(s.stage)} />
                <span className="text-[12px] text-muted tabular-nums">{s.count} open</span>
              </div>
              <div className="flex items-center gap-4 text-[13px]">
                <span className="tabular-nums text-muted">{formatMoney(s.openValueCents)}</span>
                <span className="w-24 text-right font-bold tabular-nums text-ink">
                  {formatMoney(s.weightedCents)}
                </span>
              </div>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-canvas">
              <div
                className="h-full rounded-full bg-ink"
                style={{ width: `${Math.round((s.openValueCents / max) * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <p className="text-[12px] text-subtle">
        Forecast weights each open lead by its AI score (probability proxy). Won and lost stages are excluded from the weighted total.
      </p>
    </div>
  );
}
