// Marketr — I1 90-day plan board (client): sprint-grouped initiatives with
// human-adjustable priority. Up/down reorders the flat priority list and
// persists via PATCH /api/authority/intelligence/reports/:id
// (reorder-only; draft reports only). Initiatives that were human-touched
// carry the "adjusted" flag set by lib/authority/intelligence/plan.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Loader2, Hand } from "lucide-react";
import { Badge } from "@/components/vault/shadcn/badge";
import type { PlanInitiative } from "@/lib/authority/intelligence/types";

const SPRINTS = [
  { sprint: 30 as const, label: "Days 1–30", sub: "Foundation: fix what's leaking first." },
  { sprint: 60 as const, label: "Days 31–60", sub: "Acceleration: compound the quick wins." },
  { sprint: 90 as const, label: "Days 61–90", sub: "Scale: invest in what the data proved." },
];

const EFFORT_STYLES: Record<string, string> = {
  low: "bg-emerald-50 text-emerald-700 border-emerald-200",
  medium: "bg-amber-50 text-amber-700 border-amber-200",
  high: "bg-rose-50 text-rose-700 border-rose-200",
};

export function PlanBoard({ reportId, initial }: { reportId: string; initial: PlanInitiative[] }) {
  const router = useRouter();
  const [order, setOrder] = useState<PlanInitiative[]>(
    [...initial].sort((a, b) => a.priority - b.priority),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function persist(next: PlanInitiative[]) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/authority/intelligence/reports/${reportId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderedInitiativeIds: next.map((i) => i.id) }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Reorder failed");
      setOrder(next.map((i, idx) => ({ ...i, priority: idx + 1, adjustedByHuman: true })));
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function move(id: string, dir: -1 | 1) {
    const idx = order.findIndex((i) => i.id === id);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= order.length) return;
    const next = [...order];
    [next[idx], next[j]] = [next[j], next[idx]];
    void persist(next);
  }

  return (
    <div className="space-y-8">
      {(error || saving) && (
        <div className="flex items-center gap-2 text-xs text-stone-500">
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {saving ? "Saving priority…" : null}
          {error && <span className="text-red-600">{error}</span>}
        </div>
      )}
      {SPRINTS.map((s) => {
        const items = order.filter((i) => i.sprint === s.sprint);
        if (items.length === 0) return null;
        return (
          <section key={s.sprint} aria-label={s.label}>
            <div className="mb-3 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold tracking-tight text-stone-900">{s.label}</h3>
              <p className="text-xs text-stone-500">{s.sub}</p>
            </div>
            <ol className="space-y-3">
              {items.map((i) => (
                <li
                  key={i.id}
                  className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm transition hover:shadow-md"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-sm font-bold text-indigo-700">
                      {i.priority}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-stone-900">{i.title}</p>
                        {i.adjustedByHuman && (
                          <Badge variant="outline" className="gap-1 border-indigo-200 bg-indigo-50 text-indigo-700">
                            <Hand className="h-3 w-3" /> human-adjusted
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1 text-sm text-stone-600">{i.description}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                        <Badge variant="secondary" className="bg-stone-100 text-stone-700">
                          Executes in: {i.module}
                        </Badge>
                        <Badge variant="outline" className={EFFORT_STYLES[i.effort] ?? ""}>
                          {i.effort} effort
                        </Badge>
                        <span className="text-stone-500">Expected: {i.expectedOutcome}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col gap-1">
                      <button
                        type="button"
                        aria-label={`Raise priority of ${i.title}`}
                        onClick={() => move(i.id, -1)}
                        disabled={saving || i.priority === 1}
                        className="rounded-md border border-stone-200 p-1.5 text-stone-500 hover:border-stone-400 hover:text-stone-800 disabled:opacity-30"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Lower priority of ${i.title}`}
                        onClick={() => move(i.id, 1)}
                        disabled={saving || i.priority === order.length}
                        className="rounded-md border border-stone-200 p-1.5 text-stone-500 hover:border-stone-400 hover:text-stone-800 disabled:opacity-30"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
