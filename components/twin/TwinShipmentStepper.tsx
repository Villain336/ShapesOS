// ShapesOS — Phase 13 (twinui): shipment tracking stepper (bottom-left) for
// the selected dock's shipment, else the most urgent one. Neutral: done steps
// are solid ink, the current step an ink ring, later steps a line — booking
// and shipment states are not agent states, so no status colours.
// Server-renderable.

import { ArrowDownToLine, ArrowUpFromLine, Truck } from "lucide-react";
import type { TwinShipment } from "@/lib/twin/types";
import { formatTime } from "@/lib/twin/view-model";
import { cn } from "@/lib/utils";

export function TwinShipmentStepper({ shipment, className }: { shipment: TwinShipment | null; className?: string }) {
  if (!shipment) {
    return (
      <section aria-label="Shipment tracking" className={cn("rounded-lg bg-paper px-4 py-3 shadow-hairline", className)}>
        <p className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Truck size={15} aria-hidden /> Shipments
        </p>
        <p className="mt-1 text-sm text-muted">No open shipments at this site.</p>
      </section>
    );
  }
  const Dir = shipment.direction === "inbound" ? ArrowDownToLine : ArrowUpFromLine;
  return (
    <section aria-label="Shipment tracking" className={cn("rounded-lg bg-paper px-4 py-3 shadow-hairline", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Dir size={15} aria-hidden />
            <span className="truncate">
              {shipment.direction === "inbound" ? "Inbound" : "Outbound"}
              {shipment.ref ? <span className="aos-mono ml-1.5 text-xs">{shipment.ref}</span> : null}
            </span>
          </p>
          <p className="mt-0.5 truncate text-xs text-muted">
            {[shipment.truckRef, shipment.carrier].filter(Boolean).join(" · ") || "No truck yet"}
            {shipment.eta ? ` · ETA ${formatTime(shipment.eta)}` : ""}
          </p>
        </div>
        {shipment.late ? (
          <span className="inline-flex h-6 shrink-0 items-center rounded-full bg-ink px-2.5 text-xs font-semibold text-paper">Late</span>
        ) : null}
      </div>
      <ol className="mt-3 flex items-start">
        {shipment.steps.map((s, i) => {
          const current = i === shipment.currentStep && !s.done;
          const last = i === shipment.steps.length - 1;
          return (
            <li key={`${s.key}-${i}`} className="relative flex min-w-0 flex-1 flex-col items-center text-center" aria-current={current ? "step" : undefined}>
              {!last && (
                <span aria-hidden className={cn("absolute left-1/2 top-[7px] h-0.5 w-full", s.done ? "bg-ink" : "bg-line")} />
              )}
              <span
                aria-hidden
                className={cn(
                  "relative z-10 h-4 w-4 rounded-full",
                  s.done ? "bg-ink" : current ? "bg-paper shadow-[inset_0_0_0_3px_var(--aos-ink)]" : "bg-paper shadow-[inset_0_0_0_1.5px_var(--aos-control)]",
                )}
              />
              <span className={cn("mt-1.5 px-0.5 text-xs leading-tight", s.done || current ? "font-semibold text-ink" : "text-muted")}>{s.label}</span>
              <span className="text-2xs tabular-nums text-muted">{s.at ? formatTime(s.at) : " "}</span>
              <span className="sr-only">{s.done ? "done" : current ? "current step" : "not yet"}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
