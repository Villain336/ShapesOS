// Marketr — Revenue attribution (C2): revenue events.
//
// Revenue is derived, never entered twice: a lead in the canonical `won`
// stage contributes its valueCents as attributable revenue. When a lead newly
// reaches won with a value, we log a `revenue` activity — the visible revenue
// event in the lead's timeline and the signal that value was booked.

import { logActivity } from "@/lib/crm/dedup";

/** Attributable revenue for a lead: its value once it reaches won. */
export function leadRevenueCents(lead: { stage: string; valueCents: number | null }): number {
  if (lead.stage !== "won") return 0;
  return Math.max(0, lead.valueCents ?? 0);
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Record the revenue event when a lead newly reaches won with a value.
 * Idempotent by transition: value edits on an already-won lead, or reaching
 * won with no value, log nothing. Returns true when an event was logged.
 */
export async function maybeRecordWonRevenue(opts: {
  workspaceId: string;
  leadId: string;
  before: { stage: string; valueCents: number | null };
  after: { stage: string; valueCents: number | null };
  actor?: string;
}): Promise<boolean> {
  const wasWon = opts.before.stage === "won";
  const isWon = opts.after.stage === "won";
  const value = Math.max(0, opts.after.valueCents ?? 0);
  if (wasWon || !isWon || value <= 0) return false;
  await logActivity({
    workspaceId: opts.workspaceId,
    leadId: opts.leadId,
    type: "revenue",
    body: `Revenue recorded: ${formatCents(value)} (lead won)`,
    actor: opts.actor ?? "System",
  });
  return true;
}
