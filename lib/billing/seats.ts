// ShapesOS — seat math (Phase 15.3 pricing: base fee + seats + credits).
//
// A paid plan includes INCLUDED_SEATS (lib/billing/entitlements.ts). More
// seats cost the plan's EXTRA_SEAT_PRICE_CENTS (lib/billing/plans.ts), billed
// as a QUANTITY line on the Stripe subscription.
//
// MONEY RULE (owner): charging for an extra seat is always an admin's
// explicit confirmation — never automatic. So:
//   - approvedExtra is a CEILING an admin set by confirming a price
//     (adding a member past it, or Billing → Seats). It only goes up through
//     an admin confirmation.
//   - the billed quantity is min(used − included, approvedExtra): nothing
//     beyond what an admin agreed to is ever sent to Stripe. Fewer members
//     lower the quantity (paying less needs no confirmation).
//   - SCIM / SSO auto-provisioning can't confirm anything, so past the
//     included + approved seats they are refused, never charged.
//   - an approval is for one plan's per-seat price on one subscription: a
//     plan change, a new subscription or an ended one resets it to 0
//     (lib/metering/billing.ts resetSeatApproval, audited).
// Trial: a hard seat limit (no extra seats). Self-hosted: unlimited, free.
// A paid plan whose extra seats can't be billed on this deployment (no
// Stripe, no subscription, no seat Price) keeps the included seats as a hard
// limit — exactly how seats worked before 15.3.
//
// Pure: no database, no Stripe. The server side is ./seats-server.ts.

import type { Plan } from "@prisma/client";
import { planLimit } from "./entitlements";
import { extraSeatMonthlyCentsFor, formatUsd, planDisplayName, type BillingInterval } from "./plans";

/** Seats past the included ones (0 when within the plan, or unlimited). */
export function extraSeats(used: number, included: number | null): number {
  if (included === null) return 0;
  return Math.max(0, Math.floor(used) - included);
}

/** The Stripe seat quantity: never more than an admin approved. */
export function billedSeatQuantity(args: { used: number; included: number | null; approvedExtra: number }): number {
  return Math.min(extraSeats(args.used, args.included), Math.max(0, Math.floor(args.approvedExtra)));
}

/** Can extra seats be billed for this workspace right now, and at what price? */
export interface SeatBillingAvailability {
  available: boolean;
  interval: BillingInterval;
  /** Price of one extra seat for the interval, USD cents. */
  perSeatCents: number | null;
  /** Why not, in plain language (null when available). */
  reason: string | null;
}

export type SeatDecision =
  /** Unlimited, or still within the included seats: no charge. */
  | { kind: "within_plan" }
  /** Past the included seats but within the admin-approved ceiling. */
  | { kind: "within_approved"; extraAfter: number }
  /** Past the ceiling: the admin must confirm the charge first. */
  | {
      kind: "needs_confirmation";
      plan: string;
      included: number;
      usedAfter: number;
      extraAfter: number;
      approvedExtra: number;
      perSeatCents: number;
      interval: BillingInterval;
      /** The new ceiling once confirmed. */
      approveExtra: number;
    }
  /** The admin confirmed: raise the ceiling to approveExtra, then add. */
  | { kind: "confirmed"; approveExtra: number; extraAfter: number; perSeatCents: number; interval: BillingInterval }
  /** Hard limit (trial, or extra seats not billable here). */
  | { kind: "limit"; max: number; reason: string };

/**
 * May one more member be added? `confirmed` is the admin's explicit "yes,
 * charge the extra seat" (an API flag set by the confirmation dialog);
 * automated callers (SCIM, SSO) always pass false.
 */
export function seatAddDecision(args: {
  plan: Plan | string;
  usedBefore: number;
  approvedExtra: number;
  billing: SeatBillingAvailability;
  confirmed: boolean;
  /** How many members are being added (default 1). */
  adding?: number;
}): SeatDecision {
  const included = planLimit(args.plan, "seats");
  if (included === null) return { kind: "within_plan" };
  const usedAfter = Math.floor(args.usedBefore) + Math.max(1, Math.floor(args.adding ?? 1));
  if (usedAfter <= included) return { kind: "within_plan" };
  const perMonth = extraSeatMonthlyCentsFor(String(args.plan));
  if (perMonth === null) {
    return { kind: "limit", max: included, reason: `${planDisplayName(String(args.plan))} has no extra seats.` };
  }
  if (!args.billing.available || args.billing.perSeatCents === null) {
    return {
      kind: "limit",
      max: included,
      reason: args.billing.reason ?? "Extra seats can't be billed on this deployment yet.",
    };
  }
  const extraAfter = usedAfter - included;
  const approved = Math.max(0, Math.floor(args.approvedExtra));
  if (extraAfter <= approved) return { kind: "within_approved", extraAfter };
  if (!args.confirmed) {
    return {
      kind: "needs_confirmation",
      plan: String(args.plan),
      included,
      usedAfter,
      extraAfter,
      approvedExtra: approved,
      perSeatCents: args.billing.perSeatCents,
      interval: args.billing.interval,
      approveExtra: extraAfter,
    };
  }
  return {
    kind: "confirmed",
    approveExtra: extraAfter,
    extraAfter,
    perSeatCents: args.billing.perSeatCents,
    interval: args.billing.interval,
  };
}

const per = (interval: BillingInterval) => (interval === "year" ? "year" : "month");

/** The sentence the admin confirms (UI dialog and the API's 402 body). */
export function seatConfirmationMessage(d: Extract<SeatDecision, { kind: "needs_confirmation" }>): string {
  const newSeats = d.extraAfter - d.approvedExtra;
  const price = formatUsd(d.perSeatCents);
  const plan = planDisplayName(d.plan);
  return (
    `${plan} includes ${d.included} seats. Adding this member makes ${d.usedAfter}, so ` +
    `${newSeats === 1 ? "1 extra seat" : `${newSeats} extra seats`} at ${price} per seat per ${per(d.interval)} ` +
    `will be added to your subscription (${formatUsd(d.perSeatCents * newSeats)} per ${per(d.interval)}, prorated). ` +
    `Confirm to add the member and the seat charge.`
  );
}

/** Refusal for automated provisioning (SCIM, SSO) past the paid seats. */
export function seatProvisioningRefusal(d: SeatDecision): string | null {
  if (d.kind === "within_plan" || d.kind === "within_approved" || d.kind === "confirmed") return null;
  if (d.kind === "limit") return `Seat limit reached (${d.max}). ${d.reason}`;
  return (
    `Seat limit reached: ${d.included} included seats` +
    (d.approvedExtra ? ` plus ${d.approvedExtra} approved extra` : "") +
    ` are in use. A workspace admin must approve more extra seats ` +
    `(${formatUsd(d.perSeatCents)} each per ${per(d.interval)}) in ShapesOS → Billing before more members can be provisioned.`
  );
}

/** Client-safe summary for the Members and Billing pages. */
export interface SeatSummary {
  plan: string;
  /** Included seats; null = unlimited. */
  included: number | null;
  used: number;
  /** Seats past the included ones right now. */
  extra: number;
  approvedExtra: number;
  /** Quantity last confirmed on Stripe. */
  billedExtra: number;
  /** What the quantity should be (min(extra, approved)). */
  targetExtra: number;
  /** Members past the approved ceiling (after a downgrade) — not billed. */
  unapprovedExtra: number;
  perSeatCents: number | null;
  interval: BillingInterval;
  billable: boolean;
  billableReason: string | null;
  lastSyncedAt: string | null;
  syncError: string | null;
}

export function seatSummary(args: {
  plan: Plan | string;
  used: number;
  approvedExtra: number;
  billedExtra: number;
  billing: SeatBillingAvailability;
  lastSyncedAt: Date | null;
  syncError: string | null;
}): SeatSummary {
  const included = planLimit(args.plan, "seats");
  const extra = extraSeats(args.used, included);
  const targetExtra = billedSeatQuantity({ used: args.used, included, approvedExtra: args.approvedExtra });
  return {
    plan: String(args.plan),
    included,
    used: args.used,
    extra,
    approvedExtra: Math.max(0, args.approvedExtra),
    billedExtra: args.billedExtra,
    targetExtra,
    unapprovedExtra: Math.max(0, extra - args.approvedExtra),
    perSeatCents: args.billing.perSeatCents,
    interval: args.billing.interval,
    billable: args.billing.available,
    billableReason: args.billing.reason,
    lastSyncedAt: args.lastSyncedAt?.toISOString() ?? null,
    syncError: args.syncError,
  };
}
