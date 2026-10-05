// ShapesOS — extra seats, server side (Phase 15.3 pricing).
//
// The pure rules are in ./seats.ts. This module reads the workspace's plan,
// seats in use (seatsUsed), the admin-approved extra-seat ceiling and the
// subscription, decides whether one more member may be added, records an
// admin's explicit confirmation, and keeps the Stripe seat QUANTITY line in
// step (StripeBillingSink.syncSeatQuantity — idempotent, never above the
// approved ceiling).
//
// Charging money is the admin's explicit action, never automatic: the only
// ways approvedExtraSeats goes UP are recordSeatApproval (an admin confirmed
// adding a member past the ceiling) and setApprovedExtraSeats (an admin
// confirmed a new ceiling in Billing → Seats). Both are audit-logged.

import type { Plan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { auditEvent } from "@/lib/auditlog";
import { BadRequestError } from "@/lib/api/errors";
import { seatsUsed } from "./entitlements-server";
import { planLimit } from "./entitlements";
import { extraSeatMonthlyCentsFor, extraSeatPriceCents, formatUsd, planById, planDisplayName, stripeSeatPriceIdFor } from "./plans";
import {
  extraSeats,
  seatAddDecision,
  seatSummary,
  type SeatBillingAvailability,
  type SeatDecision,
  type SeatSummary,
} from "./seats";
import {
  BILLABLE_SUBSCRIPTION_STATUSES,
  StripeBillingSink,
  getSubscriptionRow,
  isBillingConfigured,
  type SeatSyncResult,
} from "@/lib/metering/billing";

/** What seat sync needs from the billing sink. */
export interface SeatSyncSink {
  syncSeatQuantity(workspaceId: string): Promise<SeatSyncResult>;
}

/**
 * The sink seat sync uses. Production: the real Stripe sink (fails closed
 * without keys). Tests replace makeSink with one built on a LABELLED fake
 * Stripe client — never a live call.
 */
export const seatBillingRuntime: { makeSink: () => SeatSyncSink } = {
  makeSink: () => new StripeBillingSink(),
};

async function planAndApproval(workspaceId: string) {
  const [ws, bw] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { plan: true } }),
    prisma.billingWorkspace.findUnique({ where: { workspaceId } }),
  ]);
  return {
    plan: (ws?.plan ?? null) as Plan | null,
    approvedExtra: bw?.approvedExtraSeats ?? 0,
    billedExtra: bw?.billedExtraSeats ?? 0,
    lastSyncedAt: bw?.seatsSyncedAt ?? null,
    syncError: bw?.seatSyncError ?? null,
  };
}

/** Can this workspace buy extra seats right now, at what price per seat? */
export async function seatBillingAvailability(workspaceId: string, plan: Plan | string | null): Promise<SeatBillingAvailability> {
  const none = (reason: string): SeatBillingAvailability => ({ available: false, interval: "month", perSeatCents: null, reason });
  if (!plan || extraSeatMonthlyCentsFor(plan) === null) {
    return none(`${planDisplayName(String(plan ?? "this plan"))} has no extra seats.`);
  }
  if (!isBillingConfigured()) {
    return none("Billing isn't enabled on this deployment (Stripe keys aren't set), so extra seats can't be bought yet.");
  }
  const row = await getSubscriptionRow(workspaceId);
  if (!row || !BILLABLE_SUBSCRIPTION_STATUSES.includes(row.status)) {
    return none("There's no active paid subscription to add seats to. Choose a plan in Billing first.");
  }
  const interval = row.interval ?? "month";
  const paid = planById(String(plan));
  if (!stripeSeatPriceIdFor(paid, interval)) {
    const env = interval === "year" ? paid.stripeSeatAnnualPriceEnv : paid.stripeSeatPriceEnv;
    return { available: false, interval, perSeatCents: null, reason: `Extra seats aren't linked to a Stripe price yet (the host sets ${env}).` };
  }
  return { available: true, interval, perSeatCents: extraSeatPriceCents(paid, interval), reason: null };
}

/** Seats summary for the Members and Billing pages. */
export async function getSeatSummary(workspaceId: string): Promise<SeatSummary> {
  const [state, used] = await Promise.all([planAndApproval(workspaceId), seatsUsed(workspaceId)]);
  const plan = state.plan ?? "self_hosted";
  return seatSummary({
    plan,
    used,
    approvedExtra: state.approvedExtra,
    billedExtra: state.billedExtra,
    billing: await seatBillingAvailability(workspaceId, plan),
    lastSyncedAt: state.lastSyncedAt,
    syncError: state.syncError,
  });
}

/**
 * Decide whether `adding` more members may join. `confirmed` must only be
 * true when an admin explicitly confirmed the seat charge (the members API's
 * confirmSeatCharge flag); SCIM and SSO always pass false.
 */
export async function checkSeatForNewMember(
  workspaceId: string,
  opts: { confirmed: boolean; adding?: number },
): Promise<SeatDecision> {
  const [state, used] = await Promise.all([planAndApproval(workspaceId), seatsUsed(workspaceId)]);
  const plan = state.plan ?? "self_hosted";
  const included = planLimit(plan, "seats");
  // Only read the subscription when the add would go past the included seats.
  const needsBilling = included !== null && used + (opts.adding ?? 1) > included;
  const billing = needsBilling
    ? await seatBillingAvailability(workspaceId, plan)
    : { available: false, interval: "month" as const, perSeatCents: null, reason: null };
  return seatAddDecision({
    plan,
    usedBefore: used,
    approvedExtra: state.approvedExtra,
    billing,
    confirmed: opts.confirmed,
    adding: opts.adding,
  });
}

/**
 * Record an admin's explicit confirmation: the approved extra-seat ceiling
 * becomes at least `approveExtra` (atomic GREATEST — two racing confirmations
 * never lower it). Audit-logged with the price that was confirmed.
 */
export async function recordSeatApproval(
  workspaceId: string,
  decision: Extract<SeatDecision, { kind: "confirmed" }>,
  actor: { userId: string; label: string },
): Promise<void> {
  await prisma.billingWorkspace.upsert({ where: { workspaceId }, update: {}, create: { workspaceId } });
  await prisma.$executeRaw`UPDATE billing_workspaces
     SET approved_extra_seats = GREATEST(approved_extra_seats, ${decision.approveExtra}), updated_at = now()
   WHERE workspace_id = ${workspaceId}`;
  await auditEvent({
    projectId: null,
    workspaceId,
    action: "seat_charge_confirmed",
    summary:
      `${actor.label} confirmed ${decision.approveExtra} extra seat${decision.approveExtra === 1 ? "" : "s"} at ` +
      `${formatUsd(decision.perSeatCents)} per seat per ${decision.interval}`,
    actorUserId: actor.userId,
  });
}

/**
 * Billing → Seats: an admin sets the approved extra-seat ceiling. Raising it
 * needs `confirmed` (the dialog showed the price) and billable seats;
 * lowering it below the extra seats already in use is refused (remove
 * members first) so no member is ever left unbilled by choice.
 */
export async function setApprovedExtraSeats(
  workspaceId: string,
  next: number,
  opts: { confirmed: boolean; actor: { userId: string; label: string } },
): Promise<SeatSummary> {
  if (!Number.isInteger(next) || next < 0 || next > 10_000) throw new BadRequestError("Approved extra seats must be a whole number from 0 to 10,000.");
  const [state, used] = await Promise.all([planAndApproval(workspaceId), seatsUsed(workspaceId)]);
  const plan = state.plan ?? "self_hosted";
  const inUse = extraSeats(used, planLimit(plan, "seats"));
  if (next < Math.min(inUse, state.approvedExtra)) {
    throw new BadRequestError(`${inUse} extra seat${inUse === 1 ? " is" : "s are"} in use — remove members first to approve fewer.`);
  }
  if (next > state.approvedExtra) {
    const billing = await seatBillingAvailability(workspaceId, plan);
    if (!billing.available || billing.perSeatCents === null) throw new BadRequestError(billing.reason ?? "Extra seats can't be billed here.");
    if (!opts.confirmed) {
      throw new BadRequestError(
        `Confirm the charge: up to ${next - state.approvedExtra} more extra seat${next - state.approvedExtra === 1 ? "" : "s"} at ` +
          `${formatUsd(billing.perSeatCents)} each per ${billing.interval}, billed only while in use.`,
        { code: "seat_confirmation_required" },
      );
    }
  }
  await prisma.billingWorkspace.upsert({
    where: { workspaceId },
    update: { approvedExtraSeats: next },
    create: { workspaceId, approvedExtraSeats: next },
  });
  await auditEvent({
    projectId: null,
    workspaceId,
    action: "seat_ceiling_changed",
    summary: `${opts.actor.label} set approved extra seats ${state.approvedExtra} → ${next}`,
    actorUserId: opts.actor.userId,
  });
  await syncSeatsBestEffort(workspaceId);
  return getSeatSummary(workspaceId);
}

export interface SeatSyncOutcome {
  ok: boolean;
  result?: SeatSyncResult;
  error?: string;
  /** True when billing isn't configured here (self-hosted / dev): nothing to sync. */
  skipped?: boolean;
}

/**
 * Bring the Stripe seat line in step after members changed. Never throws:
 * a failure is stored on the billing row (Billing shows it with a retry)
 * and returned, so adding or removing a member never fails on Stripe.
 */
export async function syncSeatsBestEffort(workspaceId: string): Promise<SeatSyncOutcome> {
  if (!isBillingConfigured()) return { ok: true, skipped: true };
  try {
    return { ok: true, result: await seatBillingRuntime.makeSink().syncSeatQuantity(workspaceId) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
