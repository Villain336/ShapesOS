// ShapesOS — "what your plan includes" (Phase 4a entitlements).
// Reads the same table the server enforces (lib/billing/entitlements.ts), so
// the billing page can't promise something the API refuses. Dense table,
// tokens only; included/not-included is plain text (not a status color).

import { Check, Minus } from "lucide-react";
import {
  FEATURES,
  FEATURE_LABELS,
  LIMITS,
  LIMIT_LABELS,
  entitlementsFor,
} from "@/lib/billing/entitlements";

const PLAN_COLUMNS = [
  { id: "starter", label: "Starter" },
  { id: "pro", label: "Pro" },
  { id: "agency", label: "Agency" },
] as const;

function limitText(v: number | null): string {
  return v === null ? "Unlimited" : String(v);
}

export function PlanIncludes({ plan, planName }: { plan: string; planName: string }) {
  const current = entitlementsFor(plan);
  const columns = PLAN_COLUMNS.some((c) => c.id === plan)
    ? PLAN_COLUMNS
    : [{ id: plan, label: planName }, ...PLAN_COLUMNS];
  return (
    <section aria-labelledby="plan-includes" className="rounded-lg bg-paper p-5 shadow-hairline">
      <h2 id="plan-includes" className="aos-subheading">What your plan includes</h2>
      <p className="mt-1 text-sm text-muted">
        You&apos;re on {planName}: {current.features.length} of {FEATURES.length} tiered features.
        These limits are enforced by the server.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[480px] text-left text-sm">
          <thead>
            <tr className="border-b border-line text-xs font-semibold text-muted">
              <th scope="col" className="py-2 pr-3 font-semibold">Feature</th>
              {columns.map((c) => (
                <th key={c.id} scope="col" className={`px-3 py-2 font-semibold ${c.id === plan ? "text-ink" : ""}`}>
                  {c.label}
                  {c.id === plan ? " (yours)" : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {LIMITS.map((l) => (
              <tr key={l} className="border-b border-line">
                <th scope="row" className="py-2 pr-3 font-medium text-ink">{LIMIT_LABELS[l]}</th>
                {columns.map((c) => (
                  <td key={c.id} className="px-3 py-2 text-ink">{limitText(entitlementsFor(c.id).limits[l])}</td>
                ))}
              </tr>
            ))}
            {FEATURES.map((f) => (
              <tr key={f} className="border-b border-line last:border-0">
                <th scope="row" className="py-2 pr-3 font-medium text-ink">{FEATURE_LABELS[f]}</th>
                {columns.map((c) => {
                  const has = entitlementsFor(c.id).features.includes(f);
                  return (
                    <td key={c.id} className="px-3 py-2">
                      {has ? (
                        <span className="inline-flex items-center gap-1 text-ink">
                          <Check size={14} aria-hidden /> Included
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-subtle">
                          <Minus size={14} aria-hidden /> Not included
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
