// ShapesOS - how a mission's money is worded. Pure, so it is unit-tested.
//
// The remainder is a recorded cost, not necessarily a verified bill. The no-model executors log a
// cost-model estimate (a size-based figure that also counts against the per-mission budget). It is a
// model, not a measurement: the wording says "estimate" and never claims anything about billing.

export function formatCents(cents: number): string {
  return cents === 0 ? "—" : `$${(cents / 100).toFixed(2)}`;
}

export function costSummary(totalCents: number, estimatedCents: number): string {
  const recorded = Math.max(0, totalCents - estimatedCents);
  const parts: string[] = [];
  if (recorded > 0) parts.push(`${formatCents(recorded)} recorded cost`);
  if (estimatedCents > 0) parts.push(`~${formatCents(estimatedCents)} execution estimate, not metered`);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}
