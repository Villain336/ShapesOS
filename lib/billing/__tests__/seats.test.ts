// ShapesOS — Phase 15.3 pricing: seat math. Pure: no database, no Stripe.
// Run: npx tsx --test lib/billing/__tests__/seats.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  billedSeatQuantity,
  extraSeats,
  seatAddDecision,
  seatConfirmationMessage,
  seatProvisioningRefusal,
  seatSummary,
  type SeatBillingAvailability,
} from "../seats";
import { INCLUDED_SEATS } from "../entitlements";
import { EXTRA_SEAT_PRICE_CENTS } from "../plans";

const billable = (perSeatCents: number, interval: "month" | "year" = "month"): SeatBillingAvailability => ({
  available: true,
  interval,
  perSeatCents,
  reason: null,
});
const notBillable: SeatBillingAvailability = { available: false, interval: "month", perSeatCents: null, reason: "No subscription." };

describe("included vs extra", () => {
  it("extra = max(0, used − included); unlimited has no extra", () => {
    assert.equal(extraSeats(3, 10), 0);
    assert.equal(extraSeats(10, 10), 0);
    assert.equal(extraSeats(13, 10), 3);
    assert.equal(extraSeats(1_000, null), 0);
  });

  it("quantity = max(0, used − included), never above what an admin approved", () => {
    assert.equal(billedSeatQuantity({ used: 13, included: 10, approvedExtra: 5 }), 3);
    assert.equal(billedSeatQuantity({ used: 13, included: 10, approvedExtra: 1 }), 1);
    assert.equal(billedSeatQuantity({ used: 8, included: 10, approvedExtra: 5 }), 0);
    assert.equal(billedSeatQuantity({ used: 99, included: null, approvedExtra: 5 }), 0);
    assert.equal(billedSeatQuantity({ used: 13, included: 10, approvedExtra: -4 }), 0);
  });
});

describe("adding a member", () => {
  const pro = INCLUDED_SEATS.pro;

  it("self-hosted is unlimited and free", () => {
    assert.deepEqual(seatAddDecision({ plan: "self_hosted", usedBefore: 500, approvedExtra: 0, billing: notBillable, confirmed: false }), { kind: "within_plan" });
  });

  it("trial is a hard limit at its seats, even when 'confirmed'", () => {
    const d = seatAddDecision({ plan: "trial", usedBefore: INCLUDED_SEATS.trial, approvedExtra: 0, billing: billable(1_900), confirmed: true });
    assert.equal(d.kind, "limit");
    assert.equal(d.kind === "limit" && d.max, INCLUDED_SEATS.trial);
  });

  it("within the included seats needs nothing", () => {
    assert.deepEqual(seatAddDecision({ plan: "pro", usedBefore: pro - 1, approvedExtra: 0, billing: notBillable, confirmed: false }), { kind: "within_plan" });
  });

  it("past the included seats: confirmation required, with the plan's per-seat price", () => {
    const d = seatAddDecision({ plan: "pro", usedBefore: pro, approvedExtra: 0, billing: billable(EXTRA_SEAT_PRICE_CENTS.pro), confirmed: false });
    assert.equal(d.kind, "needs_confirmation");
    if (d.kind !== "needs_confirmation") return;
    assert.deepEqual(
      { included: d.included, usedAfter: d.usedAfter, extraAfter: d.extraAfter, perSeatCents: d.perSeatCents, approveExtra: d.approveExtra },
      { included: pro, usedAfter: pro + 1, extraAfter: 1, perSeatCents: 1_900, approveExtra: 1 },
    );
    assert.match(seatConfirmationMessage(d), /Pro includes 10 seats\. Adding this member makes 11, so 1 extra seat at \$19 per seat per month/);
  });

  it("confirmed: allowed, and the ceiling to record is the new extra count", () => {
    const d = seatAddDecision({ plan: "business", usedBefore: INCLUDED_SEATS.business + 2, approvedExtra: 2, billing: billable(EXTRA_SEAT_PRICE_CENTS.business), confirmed: true });
    assert.equal(d.kind, "confirmed");
    assert.equal(d.kind === "confirmed" && d.approveExtra, 3);
    assert.equal(d.kind === "confirmed" && d.perSeatCents, 1_500);
  });

  it("within an approved ceiling: no new confirmation", () => {
    const d = seatAddDecision({ plan: "pro", usedBefore: pro + 1, approvedExtra: 3, billing: billable(1_900), confirmed: false });
    assert.deepEqual(d, { kind: "within_approved", extraAfter: 2 });
  });

  it("a paid plan whose seats can't be billed keeps the included seats as a hard limit", () => {
    const d = seatAddDecision({ plan: "pro", usedBefore: pro, approvedExtra: 9, billing: notBillable, confirmed: true });
    assert.equal(d.kind, "limit");
    assert.match(d.kind === "limit" ? d.reason : "", /No subscription/);
  });

  it("annual subscriptions quote the annual seat price", () => {
    const d = seatAddDecision({ plan: "starter", usedBefore: INCLUDED_SEATS.starter, approvedExtra: 0, billing: billable(19_000, "year"), confirmed: false });
    assert.equal(d.kind, "needs_confirmation");
    if (d.kind === "needs_confirmation") assert.match(seatConfirmationMessage(d), /\$190 per seat per year/);
  });
});

describe("automated provisioning (SCIM, SSO) never charges", () => {
  it("is refused past the paid seats and allowed within them", () => {
    const past = seatAddDecision({ plan: "business", usedBefore: INCLUDED_SEATS.business, approvedExtra: 0, billing: billable(1_500), confirmed: false });
    assert.match(seatProvisioningRefusal(past) ?? "", /must approve more extra seats/);
    const within = seatAddDecision({ plan: "business", usedBefore: INCLUDED_SEATS.business, approvedExtra: 1, billing: billable(1_500), confirmed: false });
    assert.equal(seatProvisioningRefusal(within), null);
    assert.equal(seatProvisioningRefusal({ kind: "within_plan" }), null);
  });
});

describe("summary", () => {
  it("reports unbilled members after a downgrade", () => {
    const s = seatSummary({
      plan: "starter",
      used: 12,
      approvedExtra: 2,
      billedExtra: 2,
      billing: billable(1_900),
      lastSyncedAt: null,
      syncError: null,
    });
    assert.equal(s.included, INCLUDED_SEATS.starter);
    assert.equal(s.extra, 12 - INCLUDED_SEATS.starter);
    assert.equal(s.targetExtra, 2);
    assert.equal(s.unapprovedExtra, 12 - INCLUDED_SEATS.starter - 2);
  });
});
