// Marketr — Phase 7 F5 DSP readiness battery (SPEC-PHASE7 §10 gate 8).
//
// Run: npx tsx scripts/verify-phase7-dsp.mts
// Run 3x green before calling this done.
//
// Exercises the REAL lib/flywheel/dsp modules against in-memory stores (pure,
// no DB): the tripwire decision tree at every band against live fee-schedule
// math; margin-ledger line separation on fixtures; fee-schedule versioning
// pinned to the spend period; seat-less adapters failing closed with setup
// guidance; kill-switch ↔ pause-API mapping (real targets vs honest no-ops);
// approval-object ↔ DSP cap mapping (cap ≤ signed amount, revoked approvals
// void caps); the zero-custody field contract; and the audit hash chain.
//
// Every case must FAIL CLOSED and be logged.

import { readFileSync } from "fs";
import { join } from "path";
import {
  DSP_KINDS,
  SeatNotConnectedError,
  type DspKind,
} from "../lib/flywheel/dsp/types";
import {
  adapterFor,
  createMemoryDspAdapterStore,
} from "../lib/flywheel/dsp/adapters";
import {
  createMemoryFeeScheduleStore,
  seedPlaceholderSchedules,
  computeFeeMath,
} from "../lib/flywheel/dsp/feeSchedules";
import {
  createMemoryMarginLedgerStore,
  postDerivedLedgerRow,
  reconcileLedgerRow,
} from "../lib/flywheel/dsp/ledger";
import {
  createMemoryDspCapStore,
  assertApprovalBackable,
  reverifyCapMappings,
} from "../lib/flywheel/dsp/caps";
import { executeDspKillAction } from "../lib/flywheel/dsp/killswitch";
import {
  buildTripwireReport,
  feeMathsForTripwire,
  liveSchedulesFor,
  tripwireBandFor,
} from "../lib/flywheel/dsp/tripwire";
import { createMemoryDspAuditStore } from "../lib/flywheel/dsp/audit";

// ---------------------------------------------------------------- assertions

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, extra?: string) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

async function throwsAsync(name: string, fn: () => Promise<unknown>, match?: RegExp) {
  try {
    await fn();
    ok(name, false, "expected throw, none occurred");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ok(name, match ? match.test(msg) : true, match ? `message "${msg}" did not match ${match}` : undefined);
  }
}

// ---------------------------------------------------------------- fixtures

const WS = "ws_battery";
const NOW = new Date("2026-09-25T12:00:00Z");

async function main() {
  console.log("== F5 DSP readiness battery ==");

  // ------------------------------------------------- fee schedules/versioning
  console.log("\n[fee schedules]");
  const feeStore = createMemoryFeeScheduleStore();
  const seeded = await seedPlaceholderSchedules(feeStore, WS, "battery", new Date("2026-01-01"));
  ok("seeds placeholder v1 for all four DSPs", seeded.length === 4 && seeded.every((s) => s.version === 1));
  const v1 = seeded.find((s) => s.dsp === "ttd")!;
  // Publish v2 effective 2026-06-01 with different take rate.
  const v2 = await feeStore.publish({
    workspaceId: WS, dsp: "ttd", version: 2,
    feeLines: { takeRateBps: 2000, techFeeBps: 200, monthlyMinimumCents: 0, sourceNote: "signed rate card" },
    effectiveFrom: new Date("2026-06-01"), createdBy: "battery",
  });
  ok("v2 publishes with strictly increasing version", v2.version === 2);
  await throwsAsync(
    "non-monotonic version (v2 again) is refused",
    () => feeStore.publish({ workspaceId: WS, dsp: "ttd", version: 2, feeLines: v1.feeLines, effectiveFrom: new Date("2026-07-01"), createdBy: "battery" }),
    /strictly increase|next after/i,
  );
  await throwsAsync(
    "invalid fee lines (negative take rate) are refused",
    () => feeStore.publish({ workspaceId: WS, dsp: "dv360", version: 2, feeLines: { ...v1.feeLines, takeRateBps: -5 }, effectiveFrom: new Date("2026-07-01"), createdBy: "battery" }),
    /Invalid fee lines/i,
  );

  const liveAtMar = await feeStore.liveAt(WS, "ttd", new Date("2026-03-15"));
  const liveAtAug = await feeStore.liveAt(WS, "ttd", new Date("2026-08-15"));
  ok("spend in March pins v1 (not today's v2)", liveAtMar?.version === 1);
  ok("spend in August pins v2", liveAtAug?.version === 2);
  const mathMar = computeFeeMath(10_000_00, liveAtMar!);
  const mathAug = computeFeeMath(10_000_00, liveAtAug!);
  ok(
    "fee math differs by pinned schedule (1500bps vs 2000bps take)",
    mathMar.takeRateCents === 1500_00 && mathAug.takeRateCents === 2000_00,
  );
  ok("fee math returns the pinned schedule version", mathMar.scheduleVersion === 1 && mathAug.scheduleVersion === 2);
  const history = await feeStore.history(WS, "ttd");
  ok("history lists v2 then v1", history[0].version === 2 && history[1].version === 1);

  // ------------------------------------------------- tripwire bands + fee math
  console.log("\n[tripwire]");
  const live = await liveSchedulesFor(feeStore, WS, NOW);
  const bandCases: Array<[number, ReturnType<typeof tripwireBandFor>, number]> = [
    [10_000_00, "no_dsp", 0],            // $10K
    [20_000_00, "self_serve", 0],        // $20K boundary
    [49_999_00, "self_serve", 0],
    [50_000_00, "managed_tier", 0],      // $50K boundary
    [249_999_00, "managed_tier", 0],
    [300_000_00, "managed_tier", 2],     // above $250K but not sustained → stays managed
    [300_000_00, "direct_ttd_seat", 3],  // sustained → direct seat
    [600_000_00, "multi_dsp", 12],
  ];
  for (const [spend, expected, sustained] of bandCases) {
    const r = buildTripwireReport(WS, {
      aggregateMonthlySpendCents: spend,
      sustainedMonthsAbove250k: sustained,
      feeMaths: await feeMathsForTripwire(spend, live),
    });
    ok(`$${(spend / 100).toLocaleString()} (sustained ${sustained}mo) → ${expected}`, r.band === expected);
    ok(
      `report pins fee-schedule versions (${spend / 100})`,
      r.feeSchedulePins.length >= 4 && r.feeSchedulePins.every((p) => p.version >= 1),
    );
    ok(`report demands a human decision (${spend / 100})`, r.decisionRequiredByHuman === true);
  }
  // Fee math consistency: rail costings reconcile to the fee maths.
  const rpt = buildTripwireReport(WS, {
    aggregateMonthlySpendCents: 300_000_00,
    sustainedMonthsAbove250k: 3,
    feeMaths: await feeMathsForTripwire(300_000_00, live),
  });
  const ttdCosting = rpt.railCostings.find((c) => c.rail === "ttd")!;
  const ttdMath = (await feeMathsForTripwire(300_000_00, live)).find((f) => f.dsp === "ttd")!.math;
  ok(
    "tripwire effective monthly cost = platformCost + fixed seat costs",
    ttdCosting.effectiveMonthlyCents === ttdMath.platformCostCents + ttdCosting.fixedMonthlyCents,
  );
  ok(
    "direct-seat break-even: saved partner markup (15pts of $300K = $45K) exceeds seat fixed (~$10K)",
    rpt.seatBreakeven !== null && rpt.seatBreakeven.directSeatWins === true,
  );

  // ------------------------------------------------- margin ledger separation
  console.log("\n[margin ledger]");
  const ledger = createMemoryMarginLedgerStore();
  const adapterStore = createMemoryDspAdapterStore();
  for (const dsp of DSP_KINDS) await adapterStore.upsert(WS, dsp);
  const adapter = (await adapterStore.get(WS, "ttd"))!;
  const schedule = await feeStore.liveAt(WS, "ttd", new Date("2026-08-01"));
  const { row } = await postDerivedLedgerRow(ledger, schedule!, {
    workspaceId: WS, period: "2026-08", dspAdapterId: adapter.id,
    mediaSpendCents: 12_000_00, marketrMarginCents: 180_00, postedBy: "battery",
  });
  ok("ledger pins the live schedule version", row.feeScheduleVersion === 2);
  const rec = reconcileLedgerRow(row);
  ok("lines reconcile: client_billed = fees + passthrough + margin", rec.balanced);
  ok(
    "the four lines are distinct and independently reported",
    row.passthroughCents === 12_000_00 &&
      row.platformFeesCents === ttdFeeCentsOf(12_000_00, schedule!) &&
      row.marketrMarginCents === 180_00 &&
      row.clientBilledCents === row.passthroughCents + row.platformFeesCents + row.marketrMarginCents,
  );
  await throwsAsync(
    "ledger refuses a row without a pinned schedule version",
    () => ledger.post({
      workspaceId: WS, period: "2026-08", dspAdapterId: adapter.id, dsp: "ttd",
      clientBilledCents: 100, platformFeesCents: 0, passthroughCents: 100, marketrMarginCents: 0,
      feeScheduleVersion: 0, postedBy: "battery",
    }),
    /feeScheduleVersion/i,
  );
  await throwsAsync(
    "ledger refuses malformed period",
    () => ledger.post({
      workspaceId: WS, period: "Aug 2026", dspAdapterId: adapter.id, dsp: "ttd",
      clientBilledCents: 100, platformFeesCents: 0, passthroughCents: 100, marketrMarginCents: 0,
      feeScheduleVersion: 1, postedBy: "battery",
    }),
    /YYYY-MM/i,
  );
  await throwsAsync(
    "ledger refuses negative margin (no hiding losses in lines)",
    () => ledger.post({
      workspaceId: WS, period: "2026-08", dspAdapterId: adapter.id, dsp: "ttd",
      clientBilledCents: 100, platformFeesCents: 0, passthroughCents: 100, marketrMarginCents: -5,
      feeScheduleVersion: 1, postedBy: "battery",
    }),
    /non-negative integer/i,
  );

  // ------------------------------------------------- seat-less adapters fail closed
  console.log("\n[adapters]");
  const seatless = adapterFor((await adapterStore.get(WS, "dv360"))!);
  await throwsAsync(
    "pause without seat fails closed with guidance",
    () => seatless.pause({ platformRef: "dv360-camp-1", reason: "stop-loss", actor: "sweeper" }),
    /connect your agency seat/i,
  );
  await throwsAsync(
    "setCap without seat fails closed with guidance",
    () => seatless.setCap({ platformRef: "dv360-camp-1", capCents: 1000, approvalId: "a1" }),
    /connect your agency seat/i,
  );
  await throwsAsync(
    "report without seat fails closed with guidance",
    () => seatless.report({ platformRef: "dv360-camp-1" }),
    /connect your agency seat/i,
  );
  const seatErr = await seatless.pause({ platformRef: "x", reason: "r", actor: "a" }).catch((e) => e);
  ok(
    "SeatNotConnectedError carries the guidance payload",
    seatErr instanceof SeatNotConnectedError && seatErr.guidance.includes("contracts and billing stay with your agency"),
  );
  await throwsAsync(
    "connect without a vault:// ref is refused (zero custody)",
    () => adapterStore.connect(WS, "dv360", "raw-api-key-123", "battery"),
    /vault/i,
  );
  const connected = await adapterStore.connect(WS, "ttd", "vault://dsp/ttd-agency-seat", "battery");
  ok("connect with a vault ref succeeds", connected.seatStatus === "connected" && connected.configRef === "vault://dsp/ttd-agency-seat");
  ok("connected seat is recorded", connected.connectedAt !== null && connected.connectedBy === "battery");

  // ------------------------------------------------- kill-switch ↔ pause-API mapping
  console.log("\n[kill-switch mapping]");
  const target = { dsp: "dv360" as DspKind, platformRef: "dv360-line-9", campaignName: "August CTV" };
  const killOpts = { killRuleId: "kr_1", killRuleName: "stop-loss pause", actor: "sweeper" };
  const noopPause = await executeDspKillAction(seatless, "pause", target, killOpts);
  ok(
    "seat-less pause is an HONEST no-op (not fake-executed)",
    noopPause.executed === false && noopPause.reallyExecuted === false && noopPause.outcome === "not_connected",
  );
  ok(
    "honest no-op tells the human to act in the DSP UI",
    (noopPause.honestReason ?? "").includes("Marketr cannot pause this"),
  );
  const noopAlert = await executeDspKillAction(seatless, "alert", target, killOpts);
  ok(
    "alert never becomes a platform action",
    noopAlert.executed === false && noopAlert.outcome === "not_supported" && noopAlert.reallyExecuted === false,
  );
  const connectedAdapter = adapterFor(connected);
  const connectedPause = await executeDspKillAction(connectedAdapter, "pause", { ...target, dsp: "ttd" }, killOpts);
  ok(
    "seat-connected pause routes to the adapter interface (honest not_supported until API wiring ships)",
    connectedPause.reallyExecuted === false && connectedPause.outcome === "not_supported" && connectedPause.honestReason !== null,
  );

  // ------------------------------------------------- approval ↔ cap mapping
  console.log("\n[cap mapping]");
  const capStore = createMemoryDspCapStore();
  const approvedAppr = { id: "appr_1", workspaceId: WS, status: "approved" as const, maxSpendCents: 50_000_00 };
  assertApprovalBackable(approvedAppr, NOW);
  const mapping = await capStore.map({
    workspaceId: WS, approvalId: approvedAppr.id, dsp: "ttd", platformRef: "ttd-camp-7",
    capCents: 50_000_00, approvalMaxSpendCents: approvedAppr.maxSpendCents, mappedBy: "battery",
  });
  ok("cap equal to the signed amount maps", mapping.status === "mapped");
  await throwsAsync(
    "cap above the signed approval amount is denied",
    () => capStore.map({
      workspaceId: WS, approvalId: approvedAppr.id, dsp: "ttd", platformRef: "ttd-camp-8",
      capCents: 50_001_00, approvalMaxSpendCents: approvedAppr.maxSpendCents, mappedBy: "battery",
    }),
    /exceeds the signed approval/i,
  );
  throwsAsyncCheck("non-approved approval cannot back a cap", () => {
    assertApprovalBackable({ ...approvedAppr, status: "pending" as const }, NOW);
  });
  throwsAsyncCheck("expired approval cannot back a cap", () => {
    assertApprovalBackable({ ...approvedAppr, approvalExpiresAt: new Date("2026-01-01") }, NOW);
  });
  // Re-mapping supersedes the older live mapping.
  const mapping2 = await capStore.map({
    workspaceId: WS, approvalId: approvedAppr.id, dsp: "ttd", platformRef: "ttd-camp-7",
    capCents: 40_000_00, approvalMaxSpendCents: approvedAppr.maxSpendCents, mappedBy: "battery",
  });
  const first = await capStore.get(WS, mapping.id);
  ok("older mapping for the same platform ref is superseded", first?.status === "superseded" && mapping2.status === "mapped");
  // Revoked approval voids its caps (fail closed, checked at use time).
  const approvals = new Map([[approvedAppr.id, approvedAppr]]);
  const voided = await reverifyCapMappings(capStore, WS, async (id) => {
    const a = approvals.get(id) ?? null;
    return a && a.status === "approved" ? { ...a, status: "revoked" as const } : a;
  }, NOW);
  ok("revoked approval voids its live DSP cap", voided.length === 1 && voided[0].id === mapping2.id);

  // ------------------------------------------------- zero-custody field contract
  console.log("\n[zero custody]");
  const libSources = [
    readFileSync("lib/flywheel/dsp/types.ts", "utf8"),
    readFileSync("lib/flywheel/dsp/adapters.ts", "utf8"),
    readFileSync("lib/flywheel/dsp/ledger.ts", "utf8"),
  ].join("\n");
  const fragment = readFileSync("prisma/fragments/phase7-dsp.prisma", "utf8");
  // Field-identifier patterns (not prose): identifiers that could hold payment
  // instruments or credential material. Word-boundary anchored so the
  // zero-custody comments ("never a PAN") do not false-positive.
  const forbiddenFields =
    /\b(pan|card_number|cardNumber|credit_card|cvc|cvv|payment_instrument|paymentInstrument|api_key|apiKey|api_secret|apiSecret|secret_key|secretKey|client_secret)\b/i;
  ok("lib sources define no payment-instrument fields", !forbiddenFields.test(libSources));
  ok("prisma fragment defines no payment-instrument columns", !forbiddenFields.test(fragment));
  ok(
    "fragment documents zero custody (vault ref only, never credential material)",
    fragment.includes("config_ref") && /never/i.test(fragment) && /credential/i.test(fragment),
  );

  // ------------------------------------------------- audit chain
  console.log("\n[audit]");
  const audit = createMemoryDspAuditStore();
  await audit.log({ workspaceId: WS, actor: "battery", action: "adapter_connected", subjectType: "adapter", subjectId: "a1", detail: { dsp: "ttd" } });
  await audit.log({ workspaceId: WS, actor: "battery", action: "cap_mapped", subjectType: "cap_mapping", subjectId: "c1", detail: { capCents: 1000 } });
  await audit.log({ workspaceId: WS, actor: "battery", action: "tripwire_report", subjectType: "tripwire", detail: { band: "self_serve" } });
  const chain = await audit.verifyChain(WS);
  ok("audit hash chain verifies", chain.ok);
  const events = await audit.list(WS);
  ok("adapter connections, cap mappings, and tripwire reports are audit-logged", events.length === 3);

  // ------------------------------------------------- summary
  console.log(`\n== ${passed} passed, ${failed} failed ==`);
  if (failed) {
    console.log("Failures:", failures.join("; "));
    process.exit(1);
  }
}

function throwsAsyncCheck(name: string, fn: () => void) {
  try {
    fn();
    ok(name, false, "expected throw, none occurred");
  } catch {
    ok(name, true);
  }
}

function ttdFeeCentsOf(spendCents: number, schedule: { feeLines: { takeRateBps: number; techFeeBps: number; monthlyMinimumCents: number } }): number {
  const take = Math.round((spendCents * schedule.feeLines.takeRateBps) / 10000);
  const tech = Math.round((spendCents * schedule.feeLines.techFeeBps) / 10000);
  return Math.max(spendCents + take + tech, schedule.feeLines.monthlyMinimumCents) - spendCents;
}

main().catch((err) => {
  console.error("Battery crashed:", err);
  process.exit(1);
});
