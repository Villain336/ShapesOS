// Marketr — I1 90-day plan board (client): sprint-grouped initiatives with
// human-adjustable priority. Up/down reorders the flat priority list and
// persists via PATCH /api/authority/intelligence/reports/:id
// (reorder-only; draft reports only). Initiatives that were human-touched
// carry the "adjusted" flag set by lib/authority/intelligence/plan.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Loader2, Hand } from "lucide-react";
function chip(text: React.ReactNode, cls: string) {
  return (
    <span className={`inline-flex items-center gap-0.5 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[0.625rem] font-medium leading-tight ${cls}`}>
      {text}
    </span>
  );
}
import type { PlanInitiative } from "@/lib/authority/intelligence/types";

const SPRINTS = [
  { sprint: 30 as const, label: "Days 1–30", sub: "Foundation: fix what's leaking first." },
  { sprint: 60 as const, label: "Days 31–60", sub: "Acceleration: compound the quick wins." },
  { sprint: 90 as const, label: "Days 61–90", sub: "Scale: invest in what the data proved." },
];

// Effort is an analytic estimate, not an agent state — neutral chips.
const EFFORT_CHIP: Record<string, string> = {
  low: "border-line bg-paper text-muted shadow-control",
  medium: "border-line bg-paper text-muted shadow-control",
  high: "border-line bg-paper text-muted shadow-control",
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
    <div className="space-y-4">
      {(error || saving) && (
        <div className="flex items-center gap-2 text-xs text-muted">
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {saving ? "Saving priority…" : null}
          {error && <span className="text-failed-text">{error}</span>}
        </div>
      )}
      {SPRINTS.map((s) => {
        const items = order.filter((i) => i.sprint === s.sprint);
        if (items.length === 0) return null;
        return (
          <section key={s.sprint} aria-label={s.label}>
            <div className="mb-3 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold tracking-tight text-ink">{s.label}</h3>
              <p className="text-xs text-muted">{s.sub}</p>
            </div>
            <ol className="space-y-2">
              {items.map((i) => (
                <li
                  key={i.id}
                  className="rounded-lg border border-line bg-paper p-4"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-paper text-sm font-bold text-ink">
                      {i.priority}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-ink">{i.title}</p>
                        {i.adjustedByHuman && chip(<><Hand className="h-3 w-3" /> human-adjusted</>, "border-line bg-paper text-muted shadow-control")}
                      </div>
                      <p className="mt-1 text-sm text-muted">{i.description}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                        {chip(`Executes in: ${i.module}`, "border-line bg-paper text-muted")}
                        {chip(`${i.effort} effort`, EFFORT_CHIP[i.effort] ?? "border-line bg-paper text-muted")}
                        <span className="text-muted">Expected: {i.expectedOutcome}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col gap-1">
                      <button
                        type="button"
                        aria-label={`Raise priority of ${i.title}`}
                        onClick={() => move(i.id, -1)}
                        disabled={saving || i.priority === 1}
                        className="rounded-md border border-line p-1.5 text-muted hover:border-ink hover:text-ink disabled:opacity-30"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Lower priority of ${i.title}`}
                        onClick={() => move(i.id, 1)}
                        disabled={saving || i.priority === order.length}
                        className="rounded-md border border-line p-1.5 text-muted hover:border-ink hover:text-ink disabled:opacity-30"
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
