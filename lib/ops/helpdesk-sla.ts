// ShapesOS Phase 10 (ops-core) — helpdesk SLA timers and subject threading
// helpers. PURE and client-safe (the Helpdesk view renders SLA clocks with
// the same function the SLA sweep records breaches with).

export type TicketPriority = "low" | "normal" | "high" | "urgent";

/** Defaults used when a workspace has no policy for a priority (minutes). */
export const DEFAULT_SLA: Record<TicketPriority, { firstResponseMinutes: number; resolutionMinutes: number }> = {
  urgent: { firstResponseMinutes: 60, resolutionMinutes: 8 * 60 },
  high: { firstResponseMinutes: 4 * 60, resolutionMinutes: 24 * 60 },
  normal: { firstResponseMinutes: 8 * 60, resolutionMinutes: 3 * 24 * 60 },
  low: { firstResponseMinutes: 24 * 60, resolutionMinutes: 7 * 24 * 60 },
};

export function slaDueDates(createdAt: Date, policy: { firstResponseMinutes: number; resolutionMinutes: number }) {
  return {
    firstResponseDueAt: new Date(createdAt.getTime() + policy.firstResponseMinutes * 60_000),
    resolutionDueAt: new Date(createdAt.getTime() + policy.resolutionMinutes * 60_000),
  };
}

export type SlaClock = "met" | "running" | "breached" | "none";

export interface SlaState {
  firstResponse: SlaClock;
  resolution: SlaClock;
  /** The first missed target, if any. */
  breach: "first_response" | "resolution" | null;
}

/**
 * Where a ticket stands against its SLA at `now`. A clock is "met" when the
 * event happened by the due time, "breached" when it happened late or is
 * still outstanding past due, "running" while outstanding and not yet due.
 */
export function slaState(
  t: {
    status: string;
    firstResponseDueAt: Date | string | null;
    resolutionDueAt: Date | string | null;
    firstRespondedAt: Date | string | null;
    solvedAt: Date | string | null;
    closedAt: Date | string | null;
  },
  now: Date,
): SlaState {
  const ts = (v: Date | string | null) => (v == null ? null : new Date(v).getTime());
  const clock = (due: number | null, doneAt: number | null): SlaClock => {
    if (due == null) return "none";
    if (doneAt != null) return doneAt <= due ? "met" : "breached";
    return now.getTime() > due ? "breached" : "running";
  };
  const resolvedAt = ts(t.solvedAt) ?? ts(t.closedAt);
  const firstResponse = clock(ts(t.firstResponseDueAt), ts(t.firstRespondedAt));
  const resolution = clock(ts(t.resolutionDueAt), resolvedAt);
  return {
    firstResponse,
    resolution,
    breach: firstResponse === "breached" ? "first_response" : resolution === "breached" ? "resolution" : null,
  };
}

/** "[#123]" anywhere in a subject → 123. */
export function ticketNumberFromSubject(subject: string | null | undefined): number | null {
  const m = /\[#(\d{1,9})\]/.exec(subject ?? "");
  return m ? Number(m[1]) : null;
}

/** "Re: FW: Printer jam [#12]" → "printer jam". */
export function normalizeSubject(subject: string | null | undefined): string {
  return (subject ?? "")
    .replace(/\[#\d+\]/g, "")
    .replace(/^\s*((re|fw|fwd|aw|sv)\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function replySubject(subject: string, number: number): string {
  const base = subject.replace(/\[#\d+\]/g, "").replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, "").trim();
  return `Re: ${base} [#${number}]`.slice(0, 300);
}

