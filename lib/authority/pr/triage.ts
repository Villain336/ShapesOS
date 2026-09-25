// Marketr — O2 digital PR: deadline triage (pure).
// Assigns urgency tiers and same-day flags; expired opportunities resolve to
// status `expired`. Triage is read-only — the route layer persists status.

export type Urgency = "expired" | "same_day" | "within_48h" | "this_week" | "open";

export interface TriagedOpportunity<T = unknown> {
  opportunity: T;
  urgency: Urgency;
  hoursLeft: number | null;
  sameDayUrgency: boolean;
  /** The status the opportunity should carry after triage. */
  resolvedStatus: "expired" | "new" | "matched";
}

const SAME_DAY_HOURS = 24;
const WITHIN_48H = 48;
const THIS_WEEK_HOURS = 7 * 24;

/**
 * Triage one opportunity by deadline. `wasMatched` = the match score met the
 * strong-match threshold. Pure and deterministic.
 */
export function triageOpportunity<T>(
  opportunity: T & { deadline: Date | null },
  opts: { wasMatched: boolean; now?: Date } = { wasMatched: false },
): TriagedOpportunity<T> {
  const now = opts.now ?? new Date();
  const { deadline } = opportunity;
  if (!deadline || deadline.getTime() <= now.getTime()) {
    return {
      opportunity,
      urgency: "expired",
      hoursLeft: deadline ? Math.round((deadline.getTime() - now.getTime()) / 3600000) : null,
      sameDayUrgency: false,
      resolvedStatus: "expired",
    };
  }
  const hoursLeft = (deadline.getTime() - now.getTime()) / 3600000;
  const urgency: Urgency =
    hoursLeft <= SAME_DAY_HOURS
      ? "same_day"
      : hoursLeft <= WITHIN_48H
        ? "within_48h"
        : hoursLeft <= THIS_WEEK_HOURS
          ? "this_week"
          : "open";
  return {
    opportunity,
    urgency,
    hoursLeft: Math.round(hoursLeft),
    sameDayUrgency: urgency === "same_day",
    resolvedStatus: opts.wasMatched ? "matched" : "new",
  };
}

/** Sort triaged opportunities: same-day first, then by deadline ascending, open last. */
export function sortByUrgency<T>(items: TriagedOpportunity<T>[]): TriagedOpportunity<T>[] {
  const rank: Record<Urgency, number> = {
    same_day: 0,
    within_48h: 1,
    this_week: 2,
    open: 3,
    expired: 4,
  };
  return [...items].sort((a, b) => {
    const r = rank[a.urgency] - rank[b.urgency];
    if (r !== 0) return r;
    const ad = (a.opportunity as { deadline?: Date | null }).deadline?.getTime() ?? Infinity;
    const bd = (b.opportunity as { deadline?: Date | null }).deadline?.getTime() ?? Infinity;
    return ad - bd;
  });
}
