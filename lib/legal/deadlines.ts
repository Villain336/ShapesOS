// Marketr — Legal/Compliance slice 2: deadline engine (pure).
// Spec: BUSINESS-OS-FEATURE-SPECS.md §4 (deadline engine).
//
// Filings, renewals, annual reports, license expirations — computed deadlines
// with escalation tiers that feed the alert hub (and later the OS Feed).
//
// HARD GUARDRAIL — never invent dates:
//   * A deadline only exists once the TENANT sets/confirms a due date.
//   * Recurring reminders are COMPUTED from the tenant's renewal cadence,
//     anchored to that tenant-set date — never to a guessed date.
//   * Anything without a confirmed date is tier "date_needed", never a
//     fabricated calendar date. Seed templates carry cadence, not dates.
//
// This module is pure: no DB, no I/O. Pass `now` explicitly in tests.

const MS_PER_DAY = 86_400_000;

/** Tenant-chosen recurrence for a deadline (fixed menu, never parsed from prose). */
export const RECURRENCES = [
  "none",
  "monthly",
  "quarterly",
  "semiannual",
  "annual",
  "biennial",
] as const;

export type DeadlineRecurrence = (typeof RECURRENCES)[number];

export const RECURRENCE_LABELS: Record<DeadlineRecurrence, string> = {
  none: "Does not recur",
  monthly: "Monthly",
  quarterly: "Quarterly",
  semiannual: "Every 6 months",
  annual: "Annual",
  biennial: "Every 2 years",
};

/** Where the deadline's date came from. */
export type DeadlineSource = "tenant_set" | "computed";

export const DEADLINE_SOURCES: { value: DeadlineSource; label: string }[] = [
  { value: "tenant_set", label: "Date set by you" },
  { value: "computed", label: "Computed from renewal cadence" },
];

/** Escalation tiers. Increasing severity as the due date approaches. */
export const ESCALATION_TIERS = [
  "date_needed",
  "due_90",
  "due_30",
  "due_7",
  "overdue",
] as const;

export type EscalationTier = (typeof ESCALATION_TIERS)[number];

export type AlertSeverity = "info" | "warn" | "critical";

export const TIER_META: Record<
  EscalationTier,
  { label: string; severity: AlertSeverity }
> = {
  date_needed: { label: "Date needed", severity: "info" },
  due_90: { label: "Due in 90 days", severity: "info" },
  due_30: { label: "Due in 30 days", severity: "warn" },
  due_7: { label: "Due in 7 days", severity: "critical" },
  overdue: { label: "Overdue", severity: "critical" },
};

/** Days-out boundaries for the escalation tiers. */
export const DUE_90_DAYS = 90;
export const DUE_30_DAYS = 30;
export const DUE_7_DAYS = 7;

function startOfDayUtc(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Whole calendar days from `now` until `due` (negative = overdue).
 * Compares UTC calendar days so a due date "today" is 0, not a fraction.
 */
export function daysUntilDue(due: Date, now: Date): number {
  return Math.floor((startOfDayUtc(due) - startOfDayUtc(now)) / MS_PER_DAY);
}

/**
 * The escalation tier for a deadline. `null` means no alert is warranted
 * (due more than 90 days out). A missing due date is ALWAYS "date_needed" —
 * the engine never guesses a calendar date.
 */
export function tierForDeadline(
  dueDate: Date | null,
  now: Date,
): EscalationTier | null {
  if (dueDate === null) return "date_needed";
  const days = daysUntilDue(dueDate, now);
  if (days < 0) return "overdue";
  if (days <= DUE_7_DAYS) return "due_7";
  if (days <= DUE_30_DAYS) return "due_30";
  if (days <= DUE_90_DAYS) return "due_90";
  return null;
}

/**
 * Add whole months to a date, clamping to the last day of the target month
 * (Jan 31 + 1 month = Feb 28, not Mar 3). All computation in UTC.
 */
export function addMonthsUtc(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const target = new Date(Date.UTC(year, month + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return new Date(
    Date.UTC(
      target.getUTCFullYear(),
      target.getUTCMonth(),
      Math.min(day, lastDay),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

const RECURRENCE_MONTHS: Record<Exclude<DeadlineRecurrence, "none">, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
  biennial: 24,
};

/**
 * The next occurrence of a recurring deadline, anchored to the tenant's
 * confirmed due date. Returns null when the deadline does not recur —
 * callers must treat null as "no next date", never invent one.
 */
export function nextDueDate(
  anchor: Date,
  recurrence: DeadlineRecurrence,
): Date | null {
  if (recurrence === "none") return null;
  return addMonthsUtc(anchor, RECURRENCE_MONTHS[recurrence]);
}

/**
 * The next occurrence of a recurring SERIES after `after` (the occurrence
 * just completed), anchored to the series' original due date:
 * anchor + n×cadence for the smallest n landing after `after`. Never
 * prev + cadence, so the day-of-month cannot erode through a short month:
 * Jan 31 monthly → Feb 28 → Mar 31 → Apr 30 (not Mar 28, Apr 28).
 *
 * Leap day, deliberately: a Feb 29 annual anchor falls on Feb 28 in common
 * years (the last day of February — the deadline is never pushed into
 * March, so it is never late) and returns to Feb 29 in leap years.
 */
export function nextOccurrenceFromAnchor(
  anchor: Date,
  after: Date,
  recurrence: DeadlineRecurrence,
): Date | null {
  if (recurrence === "none") return null;
  const step = RECURRENCE_MONTHS[recurrence];
  const monthsApart =
    (after.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    (after.getUTCMonth() - anchor.getUTCMonth());
  for (let n = Math.max(1, Math.floor(monthsApart / step)); ; n++) {
    const candidate = addMonthsUtc(anchor, n * step);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
}

export function isValidRecurrence(value: unknown): value is DeadlineRecurrence {
  return (
    typeof value === "string" &&
    (RECURRENCES as readonly string[]).includes(value)
  );
}

/**
 * Sentence-case alert title for a deadline at a tier. Carries no date that
 * the tenant did not set — the only dates rendered are tenant-set anchors
 * or dates computed from them via nextDueDate().
 */
export function tierAlertTitle(title: string, tier: EscalationTier): string {
  switch (tier) {
    case "date_needed":
      return `Set a due date: ${title}`;
    case "due_90":
      return `${title} — due within 90 days`;
    case "due_30":
      return `${title} — due within 30 days`;
    case "due_7":
      return `${title} — due within 7 days`;
    case "overdue":
      return `${title} — overdue`;
  }
}

/**
 * Sentence-case alert body. `dueDateText` must be a tenant-confirmed or
 * computed-from-tenant date string, or null (in which case the body asks
 * the tenant to set one — never substitutes a guess).
 */
export function tierAlertBody(params: {
  title: string;
  tier: EscalationTier;
  dueDateText: string | null;
  daysUntil: number | null;
}): string {
  const { title, tier, dueDateText, daysUntil } = params;
  if (tier === "date_needed") {
    return (
      `"${title}" has no confirmed due date yet. Set the date in Legal → ` +
      `Deadlines so reminders can be scheduled. Dates are never guessed — ` +
      `this reminder appears only because you own this obligation.`
    );
  }
  if (tier === "overdue") {
    return (
      `"${title}" is past its due date${dueDateText ? ` (${dueDateText})` : ""}. ` +
      `Review it in Legal → Deadlines and confirm what is still required.`
    );
  }
  const daysText =
    daysUntil === 0
      ? "today"
      : daysUntil === 1
        ? "tomorrow"
        : `in ${daysUntil} days`;
  return (
    `"${title}" is due ${daysText}${dueDateText ? ` (${dueDateText})` : ""}. ` +
    `Review it in Legal → Deadlines.`
  );
}
