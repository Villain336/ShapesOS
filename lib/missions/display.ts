// ShapesOS - how a mission's money is worded. Pure, so it is unit-tested.
//
// "Spent" is metered model usage only. The no-model executors log a cost-model estimate (a size-based
// figure used to enforce the per-mission budget); it was never billed, so it is labelled as an estimate.

export function formatCents(cents: number): string {
  return cents === 0 ? "—" : `$${(cents / 100).toFixed(2)}`;
}

export function costSummary(totalCents: number, estimatedCents: number): string {
  const spent = Math.max(0, totalCents - estimatedCents);
  const parts: string[] = [];
  if (spent > 0) parts.push(`${formatCents(spent)} spent`);
  if (estimatedCents > 0) parts.push(`~${formatCents(estimatedCents)} estimated, nothing billed`);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}
