// ShapesOS — Phase 13 (twinui): KPI cards (top-left over the scene). White
// cards, hairline shadow; numbers only, no status colours. Server-renderable.

import type { TwinKpi } from "@/lib/twin/types";
import { formatKpiValue } from "@/lib/twin/view-model";
import { cn } from "@/lib/utils";

export function TwinKpis({ kpis, className }: { kpis: TwinKpi[]; className?: string }) {
  if (kpis.length === 0) return null;
  return (
    <section aria-label="Site figures" className={cn("flex flex-wrap gap-2", className)}>
      {kpis.map((k) => (
        <div key={k.key} className="min-w-[150px] rounded-lg bg-paper px-3.5 py-2.5 shadow-hairline">
          <p className="text-xs font-semibold text-muted">{k.label}</p>
          <p className="stretch-heading mt-0.5 text-xl font-heading tabular-nums text-ink">{formatKpiValue(k)}</p>
          {k.hint ? <p className="text-xs text-muted">{k.hint}</p> : null}
        </div>
      ))}
    </section>
  );
}
