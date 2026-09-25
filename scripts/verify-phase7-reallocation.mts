// Marketr — Phase 7 F1 verification battery.
//
// Run: npx tsx scripts/verify-phase7-reallocation.mts
// Run 3x green before calling this done (spec §10 gates 1, 2, 4 + gate 3 E2E).
//
// Covers:
//   A. Reallocation battery (gate 1): curve fits w/ sane R², diminishing
//      marginals, multi-window agreement, lag-window enforcement,
//      measurement-health freeze, learning-viable floors, exploration slice
//      untouched, brand segmented out, anti-churn (≤20%/step, min shift,
//      72h cool-down).
//   B. SRA adversarial battery (gate 2): per-shift cap, cumulative ≥$1k
//      two-person, allowlist, expired, revoked-mid-flight (checkout
//      re-verification), band, cool-down, uncheckable signature — every
//      denial logged with reasons.
//   C. Breaker battery (gate 4): all five breakers freeze the right scope;
//      acknowledgment + cool-down required to resume; breakers provably
//      cannot authorize spend.
//   D. Audit log: hash chain verifies; tampering breaks it.
//   E. Mode-(a) E2E (gate 3): snapshot → proposal → human approval → Phase 5
//      approval object → checkout re-verification → executed move.
//   F. Geo-holdout planner.
//
// Strategy: pure logic + in-memory stores. No DB, no network, deterministic
// (seeded PRNG). Each run uses unique ids so runs never interfere.

import { readFile } from "node:fs/promises";

const curves = await import("@/lib/flywheel/reallocation/curves");
const optimizer = await import("@/lib/flywheel/reallocation/optimizer");
const sraMod = await import("@/lib/flywheel/reallocation/sra");
const breakers = await import("@/lib/flywheel/reallocation/breakers");
const auditMod = await import("@/lib/flywheel/reallocation/audit");
const checkout = await import("@/lib/flywheel/reallocation/checkout");
const storeMod = await import("@/lib/flywheel/reallocation/store");
const geo = await import("@/lib/flywheel/reallocation/geo");
const approvals = await import("@/lib/media/approvals");
import type {
  DataPoint,
  ReallocationProposal,
  SraEnvelope,
} from "@/lib/flywheel/reallocation/types";
import type { OptimizerChannel } from "@/lib/flywheel/reallocation/optimizer";
import type { BreakerSignals } from "@/lib/flywheel/reallocation/breakers";
import * as policy from "@/lib/flywheel/reallocation/policy";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Deterministic PRNG (mulberry32).
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
const NOW = new Date("2026-09-25T12:00:00Z");
const WS = `zz-f1-battery-${Date.now()}-${process.pid}`;
const SECRET = "battery-secret";

/** Synthetic channel: revenue = a·spend^b (concave) + noise. */
function makeChannel(
  channel: string,
  campaignRef: string,
  baseSpendCents: number,
  a: number,
  b: number,
  overrides: Partial<OptimizerChannel> = {},
): OptimizerChannel {
  const rnd = mulberry32(channel.length * 7919 + 13);
  const points: DataPoint[] = [];
  for (let d = 35; d >= 4; d--) {
    const spend = baseSpendCents * (1 + 0.25 * Math.sin(d * 0.7 + channel.length));
    const revenue = a * Math.pow(spend, b) * (1 + (rnd() - 0.5) * 0.1);
    points.push({
      ts: new Date(+NOW - d * DAY).toISOString(),
      spendCents: Math.round(spend),
      revenueCents: Math.max(1, Math.round(revenue)),
    });
  }
  return {
    channel,
    campaignRef,
    platform: "meta",
    currentDailyBudgetCents: baseSpendCents,
    targetCpaCents: 4500,
    isBrand: false,
    isExploration: false,
    floor: { workspaceId: WS, channel, learningViableMinCentsDay: 5000, stabilizationHours: 72 },
    dataPoints: points,
    health: {
      eventVolume: 1000,
      expectedEventMean: 1000,
      expectedEventStd: 80,
      platformSpendCents: baseSpendCents * 30,
      trackerSpendCents: Math.round(baseSpendCents * 30 * 1.02),
    },
    ...overrides,
  };
}

function craftSra(secret: string, overrides: Partial<SraEnvelope> = {}): SraEnvelope {
  const base = sraMod.createSraEnvelope(
    {
      workspaceId: WS,
      name: "battery-sra",
      channels: ["meta_prospecting", "tiktok_prospecting"],
      validUntil: new Date(+NOW + 7 * DAY).toISOString(),
      signerIds: ["u1", "u2"],
      createdBy: "u1",
      poolDailyBudgetCents: 2_000_000,
    },
    secret,
    NOW,
  );
  const { id: _i, signatureHash: _s, status: _st, createdAt: _c, revokedAt: _ra, revokedBy: _rb, ...unsigned } = base;
  const merged = { ...unsigned, ...overrides };
  return {
    ...merged,
    id: `sra_${Math.random().toString(36).slice(2)}`,
    status: "active" as const,
    signatureHash: sraMod.signSraEnvelope(merged, secret),
    createdAt: base.createdAt,
    revokedAt: null,
    revokedBy: null,
  };
}

function craftProposal(overrides: Partial<ReallocationProposal> = {}): ReallocationProposal {
  return {
    id: `prop_${Math.random().toString(36).slice(2)}`,
    workspaceId: WS,
    mode: "b",
    sraId: "sra_x",
    sourceChannel: "tiktok_prospecting",
    destChannel: "meta_prospecting",
    sourceCampaignRef: "tt_camp_1",
    destCampaignRef: "meta_camp_1",
    amountCents: 4000,
    marginalRoasDelta: 1.5,
    decisionRecord: {
      dataWindow: "7d+28d",
      lagDays: 3,
      curveParams: {},
      multiWindowAgreement: true,
      measurementHealth: "ok",
      marginalRoasSource: 1.2,
      marginalRoasDest: 2.7,
      marginalRoasDelta: 1.5,
      modelVersion: curves.MODEL_VERSION,
      rationale: "battery",
    },
    status: "proposed",
    humanApprovalId: null,
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

function policyCtx(
  proposal: ReallocationProposal,
  sra: SraEnvelope,
  overrides: Partial<policy.PolicyContext> = {},
): policy.PolicyContext {
  const base = 1_200_000;
  return {
    proposal,
    sra,
    consumedDailyCents: 0,
    consumedWeeklyCents: 0,
    channelBaselinesCents: new Map([
      ["meta_prospecting", base],
      ["tiktok_prospecting", 800_000],
    ]),
    projectedBudgetsCents: new Map([
      [proposal.sourceChannel, 800_000 - proposal.amountCents],
      [proposal.destChannel, base + proposal.amountCents],
    ]),
    lastMoveAt: new Map(),
    isRevoked: () => false,
    signatureValid: true,
    explorationChannels: new Set(),
    now: NOW,
    ...overrides,
  };
}

// ===========================================================================
// A. Reallocation battery (gate 1)
// ===========================================================================
console.log("\n[A] reallocation battery");

{
  // A1: curves fit on fixtures with sane R²; best form wins.
  const ch = makeChannel("meta_prospecting", "meta_camp_1", 12_000, 300, 0.62);
  const fit = curves.fitMarginalCurve({
    workspaceId: WS,
    channel: ch.channel,
    points: ch.dataPoints,
    dataWindow: "28d",
  });
  check("curve fits with sane R² (≥0.7 on clean concave fixture)", fit.curve.rSquared >= 0.7, `R²=${fit.curve.rSquared.toFixed(3)} type=${fit.curve.curveType}`);
  check("curve carries model version", fit.curve.modelVersion === curves.MODEL_VERSION);

  // A2: marginal ROAS diminishes with spend (never greedy last-click).
  const mLow = fit.calibratedMarginalAt(6000);
  const mHigh = fit.calibratedMarginalAt(24000);
  check("marginal ROAS diminishes with spend", mLow > mHigh, `${mLow.toFixed(2)} vs ${mHigh.toFixed(2)}`);

  // A3: optimizer proposes a shift with a full decision record.
  const chB = makeChannel("tiktok_prospecting", "tt_camp_1", 8000, 50, 0.75);
  const res = optimizer.runOptimizer({ workspaceId: WS, mode: "a", channels: [ch, chB], now: NOW });
  check("optimizer not frozen on healthy data", !res.frozen);
  check("optimizer emits exactly one equalization proposal", res.proposals.length === 1, `got ${res.proposals.length}`);
  const p = res.proposals[0];
  const dr = p.decisionRecord;
  check(
    "decision record is a complete audit answer",
    dr.dataWindow === "7d+28d" && dr.lagDays === 3 && dr.multiWindowAgreement === true &&
      dr.modelVersion === curves.MODEL_VERSION && Object.keys(dr.curveParams).length === 2 &&
      typeof dr.marginalRoasDelta === "number",
    JSON.stringify({ dataWindow: dr.dataWindow, lagDays: dr.lagDays }),
  );
  check("proposal moves from lower to higher marginal", dr.marginalRoasDest > dr.marginalRoasSource);

  // A4: anti-churn — ≤20% of source daily budget per step.
  const srcBudget = p.sourceChannel === ch.channel ? ch.currentDailyBudgetCents : chB.currentDailyBudgetCents;
  check("shift ≤20% of source daily budget", p.amountCents <= 0.2 * srcBudget + 1, `${p.amountCents} vs ${0.2 * srcBudget}`);

  // A5: multi-window agreement — disagreement kills the proposal.
  const chDisagree = makeChannel("meta_prospecting", "meta_camp_1", 12_000, 300, 0.62);
  // Corrupt the 7d window only (recent regime flip in the last 7 days).
  for (const pt of chDisagree.dataPoints) {
    if (+NOW - +new Date(pt.ts) < 7 * DAY) pt.revenueCents = Math.round(pt.revenueCents * 3);
  }
  const resDis = optimizer.runOptimizer({ workspaceId: WS, mode: "a", channels: [chDisagree, chB], now: NOW });
  check("multi-window disagreement → no proposal", resDis.proposals.length === 0);

  // A6: lag-window enforcement — today's partial spike must not move the plan.
  const chSpike = makeChannel("meta_prospecting", "meta_camp_1", 12_000, 300, 0.62);
  const chB2 = makeChannel("tiktok_prospecting", "tt_camp_1", 8000, 50, 0.75);
  chSpike.dataPoints.push({
    ts: NOW.toISOString(),
    spendCents: 12_000 * 50,
    revenueCents: 12_000 * 50 * 20, // absurd "today" that would flip marginals if used
  });
  const resSpike = optimizer.runOptimizer({ workspaceId: WS, mode: "a", channels: [chSpike, chB2], now: NOW });
  check(
    "fresh partials ignored (lag window enforced)",
    resSpike.proposals.length === 1 && resSpike.proposals[0].amountCents === p.amountCents,
    `amounts ${resSpike.proposals[0]?.amountCents} vs ${p.amountCents}`,
  );

  // A7: measurement-health freeze — degraded source = freeze, not reallocate.
  const chDegraded = makeChannel("meta_prospecting", "meta_camp_1", 12_000, 300, 0.62, {
    health: {
      eventVolume: 100, // way outside ±2σ of 1000±80
      expectedEventMean: 1000,
      expectedEventStd: 80,
      platformSpendCents: 360_000,
      trackerSpendCents: 360_000,
    },
  });
  const resDeg = optimizer.runOptimizer({ workspaceId: WS, mode: "a", channels: [chDegraded, chB], now: NOW });
  check("degraded measurement freezes the run", resDeg.frozen && resDeg.proposals.length === 0);

  // A8: cross-source disagreement also freezes.
  const chDisagreeSrc = makeChannel("meta_prospecting", "meta_camp_1", 12_000, 300, 0.62, {
    health: {
      eventVolume: 1000,
      expectedEventMean: 1000,
      expectedEventStd: 80,
      platformSpendCents: 360_000,
      trackerSpendCents: 200_000, // 44% disagreement
    },
  });
  const resDisSrc = optimizer.runOptimizer({ workspaceId: WS, mode: "a", channels: [chDisagreeSrc, chB], now: NOW });
  check("platform-vs-tracker disagreement freezes the run", resDisSrc.frozen);

  // A9: learning-viable floor — no headroom → no proposal.
  const lowA = makeChannel("aaa_low", "camp_a", 6000, 300, 0.62, {
    floor: { workspaceId: WS, channel: "aaa_low", learningViableMinCentsDay: 6000, stabilizationHours: 72 },
  });
  const highB = makeChannel("zzz_high", "camp_b", 8000, 50, 0.75);
  const resFloor = optimizer.runOptimizer({ workspaceId: WS, mode: "a", channels: [lowA, highB], now: NOW });
  // whichever channel is the source, draining it below/at floor must not happen
  const floorOk = resFloor.proposals.every((pp) => {
    const src = pp.sourceChannel === "aaa_low" ? lowA : highB;
    return src.currentDailyBudgetCents - pp.amountCents >= src.floor.learningViableMinCentsDay;
  });
  check("learning-viable floors respected (never drain below floor)", floorOk);

  // A10: exploration slice untouched.
  const chExp = makeChannel("meta_prospecting", "meta_camp_1", 12_000, 300, 0.62, { isExploration: true });
  const resExp = optimizer.runOptimizer({ workspaceId: WS, mode: "a", channels: [chExp, chB], now: NOW });
  check("exploration channel never touched", resExp.proposals.length === 0);

  // A11: brand spend segmented out of marginal math.
  const chBrand = makeChannel("meta_prospecting", "meta_camp_1", 12_000, 300, 0.62, { isBrand: true });
  const resBrand = optimizer.runOptimizer({ workspaceId: WS, mode: "a", channels: [chBrand, chB], now: NOW });
  const segmented = (resBrand.healthSnapshot.segmentedOut as string[] | undefined) ?? [];
  check("brand channel segmented out", resBrand.proposals.length === 0 && segmented.includes("meta_prospecting"));

  // A12: 72h cool-down per channel.
  const chCool = makeChannel("meta_prospecting", "meta_camp_1", 12_000, 300, 0.62, {
    lastMoveAt: new Date(+NOW - 3600_000).toISOString(),
  });
  const resCool = optimizer.runOptimizer({ workspaceId: WS, mode: "a", channels: [chCool, chB], now: NOW });
  check("cool-down blocks re-move within 72h", resCool.proposals.length === 0);

  // A13: min meaningful shift — sub-threshold headroom → no proposal.
  // aaa_tiny has the LOW marginal (would be the source) but only $4 of
  // headroom above its floor — below the $5 min meaningful shift.
  const tinySrc = makeChannel("aaa_tiny", "camp_a", 10_000, 50, 0.75, {
    floor: { workspaceId: WS, channel: "aaa_tiny", learningViableMinCentsDay: 9600, stabilizationHours: 72 },
  });
  const richDst = makeChannel("zzz_rich", "camp_b", 8000, 300, 0.62);
  const resTiny = optimizer.runOptimizer({ workspaceId: WS, mode: "a", channels: [tinySrc, richDst], now: NOW });
  check(
    "sub-threshold moves refused (learning reset > gain)",
    resTiny.proposals.length === 0,
    `got ${resTiny.proposals.length} proposals`,
  );
}

// ===========================================================================
// B. SRA adversarial battery (gate 2)
// ===========================================================================
console.log("\n[B] SRA adversarial battery");

{
  const sra = craftSra(SECRET);
  check("SRA signature verifies", sraMod.verifySraSignature(sra, SECRET));
  check("SRA signature fails with wrong secret", !sraMod.verifySraSignature(sra, "wrong"));
  check("SRA signature fails with no secret (uncheckable = deny)", !sraMod.verifySraSignature(sra, undefined));

  // B1: per-shift cap.
  const over = craftProposal({ amountCents: sra.perShiftCapCents + 1 });
  const v1 = policy.evaluatePolicy(policyCtx(over, sra));
  check("shift above per-shift cap denied", !v1.allow && v1.reasons.some((r) => r.startsWith("per_shift_cap:")));

  // B2: cumulative ≥$1k without two signers denied (ten $150 shifts can't dodge).
  // Craft a 1-signer envelope by re-signing (createSraEnvelope itself refuses
  // to mint one — the engine must still deny it live).
  const twoSigner = craftSra(SECRET);
  const { id: _i2, signatureHash: _s2, status: _st2, createdAt: _c2, revokedAt: _ra2, revokedBy: _rb2, ...unsigned2 } = twoSigner;
  const oneSignerUnsigned = { ...unsigned2, signerIds: ["u1"] };
  const oneSigner: SraEnvelope = {
    ...oneSignerUnsigned,
    id: twoSigner.id,
    status: "active",
    signatureHash: sraMod.signSraEnvelope(oneSignerUnsigned, SECRET),
    createdAt: twoSigner.createdAt,
    revokedAt: null,
    revokedBy: null,
  };
  const small = craftProposal({ amountCents: 15_000 });
  const v2 = policy.evaluatePolicy(policyCtx(small, oneSigner, { consumedDailyCents: 90_000 }));
  check(
    "cumulative ≥$1k without two signers denied",
    !v2.allow && v2.reasons.some((r) => r.startsWith("two_person:")),
    v2.reasons.join(" | "),
  );

  // B3: out-of-allowlist channel denied.
  const ool = craftProposal({ destChannel: "snapchat_spotlight", destCampaignRef: "snap_1" });
  const v3 = policy.evaluatePolicy(policyCtx(ool, sra));
  check("out-of-allowlist channel denied", !v3.allow && v3.reasons.some((r) => r.startsWith("allowlist:")));

  // B4: expired SRA denied (timeout means no).
  const expired = craftSra(SECRET, { validUntil: new Date(+NOW - 1000).toISOString() });
  const v4 = policy.evaluatePolicy(policyCtx(craftProposal(), expired));
  check("expired SRA denied", !v4.allow && v4.reasons.some((r) => r.includes("sra_not_active")));

  // B5: revoked SRA denied.
  const v5 = policy.evaluatePolicy(policyCtx(craftProposal(), sra, { isRevoked: () => true }));
  check("revoked SRA denied", !v5.allow && v5.reasons.some((r) => r.includes("sra_revoked")));

  // B6: revocation registry uncheckable = deny.
  const v6 = policy.evaluatePolicy(policyCtx(craftProposal(), sra, {
    isRevoked: () => { throw new Error("registry down"); },
  }));
  check("uncheckable revocation = deny", !v6.allow);

  // B7: band violation denied.
  const big = craftProposal({ amountCents: 200_000 }); // >10% of 1.2M baseline
  const v7 = policy.evaluatePolicy(policyCtx(big, craftSra(SECRET, { perShiftCapCents: 500_000 })));
  check("band violation denied", !v7.allow && v7.reasons.some((r) => r.startsWith("band:")));

  // B8: cool-down violation denied.
  const v8 = policy.evaluatePolicy(policyCtx(craftProposal(), sra, {
    lastMoveAt: new Map([["tiktok_prospecting", new Date(+NOW - 3600_000).toISOString()]]),
  }));
  check("cool-down violation denied", !v8.allow && v8.reasons.some((r) => r.startsWith("cooldown:")));

  // B9: valid proposal allowed.
  const v9 = policy.evaluatePolicy(policyCtx(craftProposal(), sra));
  check("valid proposal allowed", v9.allow, v9.reasons.join(" | "));

  // B10: denials logged with reasons (store).
  const store = storeMod.createMemoryReallocationStore();
  const savedSra = await store.createSra(sra);
  const savedProp = await store.createProposal({ ...craftProposal(), sraId: savedSra.id });
  const denied = policy.evaluatePolicy(policyCtx({ ...savedProp, amountCents: sra.perShiftCapCents + 1 }, savedSra));
  await store.appendPolicyDecision(denied.decision);
  const logged = await store.listPolicyDecisions(savedProp.id, WS);
  check(
    "every denial logged with reasons",
    logged.length === 1 && logged[0].decision === "deny" && logged[0].reasons.length > 0,
  );

  // B11: revoked mid-flight — checkout re-verification halts the move.
  const store2 = storeMod.createMemoryReallocationStore();
  const sra2 = await store2.createSra(craftSra(SECRET));
  const prop2 = await store2.createProposal({ ...craftProposal({ status: "policy_approved" }), sraId: sra2.id });
  // Revoke AFTER policy approval (mid-flight).
  const revoked2 = sraMod.revokeSra(sra2, "u1", NOW);
  await store2.updateSra(sra2.id, WS, { status: "revoked", revokedAt: revoked2.revokedAt, revokedBy: "u1" });
  const execRes = await checkout.executeModeBShift(prop2.id, WS, "u1", {
    store: store2,
    adapter: checkout.createFixturePlatformAdapter(),
    notify: async () => {},
    sraSecret: SECRET,
    isRevoked: (rid) => rid === sra2.revocationId,
    channelBaselinesCents: new Map([["meta_prospecting", 1_200_000], ["tiktok_prospecting", 800_000]]),
    lastMoveAt: new Map(),
    explorationChannels: new Set(),
    now: NOW,
  });
  check("revoked-mid-flight halted at checkout", !execRes.executed && /revok/i.test(execRes.haltReason ?? ""));
  const after = await store2.getProposal(prop2.id, WS);
  check("halted proposal marked policy_denied, never executed", after?.status === "policy_denied");

  // B12: expired-mid-flight also halted at checkout.
  const store3 = storeMod.createMemoryReallocationStore();
  const sra3 = await store3.createSra(craftSra(SECRET, { validUntil: new Date(+NOW - 1000).toISOString() }));
  const prop3 = await store3.createProposal({ ...craftProposal({ status: "policy_approved" }), sraId: sra3.id });
  const execRes3 = await checkout.executeModeBShift(prop3.id, WS, "u1", {
    store: store3,
    adapter: checkout.createFixturePlatformAdapter(),
    notify: async () => {},
    sraSecret: SECRET,
    isRevoked: () => false,
    channelBaselinesCents: new Map([["meta_prospecting", 1_200_000], ["tiktok_prospecting", 800_000]]),
    lastMoveAt: new Map(),
    explorationChannels: new Set(),
    now: NOW,
  });
  check("expired-mid-flight halted at checkout", !execRes3.executed);

  // B13: SRA creation rejects >30d validity (no perpetual envelopes).
  let threw = false;
  try {
    sraMod.createSraEnvelope(
      {
        workspaceId: WS, name: "bad", channels: ["a"],
        validUntil: new Date(+NOW + 60 * DAY).toISOString(),
        signerIds: ["u1"], createdBy: "u1", poolDailyBudgetCents: 100_000,
      },
      SECRET, NOW,
    );
  } catch {
    threw = true;
  }
  check("SRA validity >30d rejected", threw);

  // B14: SRA creation rejects empty allowlist.
  let threw2 = false;
  try {
    sraMod.createSraEnvelope(
      {
        workspaceId: WS, name: "bad", channels: [],
        validUntil: new Date(+NOW + 7 * DAY).toISOString(),
        signerIds: ["u1"], createdBy: "u1", poolDailyBudgetCents: 100_000,
      },
      SECRET, NOW,
    );
  } catch {
    threw2 = true;
  }
  check("empty allowlist rejected (none ≠ all)", threw2);
}

// ===========================================================================
// C. Breaker battery (gate 4)
// ===========================================================================
console.log("\n[C] breaker battery");

{
  const baseSignals: BreakerSignals = {
    channel: "meta_prospecting",
    cpa: 45, targetCpa: 50, spendCents: 50_000, inLearning: false,
    dailySpendCents: 4000, dailyBudgetCents: 12_000, hourOfDay: 15,
    eventVolume: 1000, expectedEventMean: 1000, expectedEventStd: 80,
    consecutiveDenials: 0, consecutiveFailures: 0,
    attributionModelChanged: false,
  };

  // C1: performance breaker.
  const t1 = breakers.evaluateBreakers({ ...baseSignals, cpa: 90, targetCpa: 50, spendCents: 20_000, inLearning: false });
  check("performance breaker fires (CPA>1.5×, spend>$100, not learning)", t1.some((t) => t.breakerType === "performance" && t.scope === "meta_prospecting"));
  const t1b = breakers.evaluateBreakers({ ...baseSignals, cpa: 90, targetCpa: 50, spendCents: 20_000, inLearning: true });
  check("performance breaker spares learning campaigns", !t1b.some((t) => t.breakerType === "performance"));

  // C2: velocity breaker.
  const t2 = breakers.evaluateBreakers({ ...baseSignals, hourOfDay: 10, dailySpendCents: 9900, dailyBudgetCents: 12_000 });
  check("velocity breaker fires (>80% before noon)", t2.some((t) => t.breakerType === "velocity"));

  // C3: measurement breaker → global freeze.
  const t3 = breakers.evaluateBreakers({ ...baseSignals, eventVolume: 100 });
  check("measurement breaker fires global", t3.some((t) => t.breakerType === "measurement" && t.scope === "global"));

  // C4: error-rate breaker.
  const t4 = breakers.evaluateBreakers({ ...baseSignals, consecutiveDenials: 6 });
  check("error-rate breaker fires on denial streak", t4.some((t) => t.breakerType === "error_rate" && t.scope === "global"));

  // C5: attribution-regime breaker.
  const t5 = breakers.evaluateBreakers({
    ...baseSignals, attributionModelChanged: true, attributionChangedAt: new Date(+NOW - 3600_000).toISOString(),
  }, NOW);
  check("attribution-regime breaker freezes for stabilization window", t5.some((t) => t.breakerType === "attribution_regime"));

  // C6: acknowledgment + cool-down required to resume.
  const event = breakers.tripToEvent(t3[0], WS, NOW);
  check("fired breaker freezes scope", breakers.isScopeFrozen([event], "meta_prospecting", NOW));
  const acked = breakers.acknowledgeBreaker(event, "u1", NOW);
  check("acknowledged but cool-down pending → still frozen", breakers.isScopeFrozen([acked], "meta_prospecting", NOW));
  const cooled = { ...acked, cooldownUntil: new Date(+NOW - 1000).toISOString() };
  check("cool-down elapsed → scope clear", !breakers.isScopeFrozen([cooled], "meta_prospecting", NOW));

  // C7: breakers provably cannot authorize spend.
  const mod = await import("@/lib/flywheel/reallocation/breakers");
  const exported = Object.keys(mod);
  check(
    "breaker module exports no allow/authorize/approve path",
    !exported.some((n) => /allow|authoriz|approve|execute|spend/i.test(n)),
    exported.join(","),
  );
  const src = await readFile(new URL("../lib/flywheel/reallocation/breakers.ts", import.meta.url), "utf8");
  check(
    "breaker source contains no authorize/allow function",
    !/export\s+(async\s+)?function\s+(allow|authorize|approve)/i.test(src) && !/applyBudgetShift/.test(src),
  );
  // Behavioral: a trip can only ever produce a freeze, never a go-ahead.
  const trips = breakers.evaluateBreakers({ ...baseSignals, eventVolume: 100 });
  check("trips are freeze-only records (type+scope+reason)", trips.every((t) => t.breakerType && t.scope && t.reason));
}

// ===========================================================================
// D. Audit log
// ===========================================================================
console.log("\n[D] audit log");

{
  const store = storeMod.createMemoryReallocationStore();
  const audit = new auditMod.AuditLog(store.audit);
  const e1 = await audit.append(WS, "proposal_created", "optimizer", { proposalId: "p1" }, "corr_1", NOW);
  await audit.append(WS, "policy_decision", "policy-engine", { decision: "deny" }, "corr_1", NOW);
  await audit.append(WS, "breaker_fired", "watchdog", { type: "measurement" }, "corr_2", NOW);
  const v1 = await audit.verifyChain(WS);
  check("hash chain verifies", v1.ok);
  check("correlation IDs preserved", e1.correlationId === "corr_1");
  // Tamper: mutate one event's payload → chain breaks at that link.
  const events = await audit.list(WS);
  store.audit.__mutateForTest?.(events[1].id, { payload: { decision: "allow" } });
  const v2 = await audit.verifyChain(WS);
  check("tampering breaks the chain at the mutated link", !v2.ok && v2.brokenAt === events[1].id);
}

// ===========================================================================
// E. Mode-(a) E2E (gate 3)
// ===========================================================================
console.log("\n[E] mode-(a) E2E");

{
  const ch = makeChannel("meta_prospecting", "meta_camp_1", 12_000, 300, 0.62);
  const chB = makeChannel("tiktok_prospecting", "tt_camp_1", 8000, 50, 0.75);
  const res = optimizer.runOptimizer({ workspaceId: WS, mode: "a", channels: [ch, chB], now: NOW });
  check("E2E: optimizer proposes", res.proposals.length === 1);
  const store = storeMod.createMemoryReallocationStore();
  const saved = await store.createProposal(res.proposals[0]);

  // Human approval → materializes a Phase 5 per-buy approval object.
  const approvalStore = approvals.createMemoryApprovalStore();
  const created = await checkout.materializeModeAApproval(approvalStore, {
    proposal: saved,
    clientAdAccountId: "act_client_1",
    platform: "meta",
    createdBy: "f1-optimizer",
    currency: "USD",
  });
  check("E2E: Phase 5 approval object materialized", created.status === "draft" && created.bindingHash.length === 64);
  const submitted = await approvals.submitApproval(approvalStore, created.id, WS, "owner1");
  check("E2E: submitted", submitted.status === "pending");
  const decided = await approvals.approveApproval(approvalStore, {
    id: created.id,
    workspaceId: WS,
    approverId: "owner1",
    approverMediaRole: "owner",
    method: "sso",
    twoPersonThresholdCents: 100_000,
  });
  check("E2E: human approved", decided.status === "approved");
  await store.updateProposal(saved.id, WS, { status: "human_approved", humanApprovalId: decided.id });

  // Executor re-verification at checkout → move.
  const adapter = checkout.createFixturePlatformAdapter();
  const execRes = await checkout.executeModeAMove(decided.id, saved.id, WS, "owner1", {
    store,
    approvalStore,
    adapter,
    notify: async () => {},
    now: NOW,
  });
  check("E2E: move executed after re-verification", execRes.executed, execRes.haltReason);
  check("E2E: fixture adapter recorded the shift", adapter.shifts.length === 1 && adapter.shifts[0].amountCents === saved.amountCents);
  const final = await store.getProposal(saved.id, WS);
  check("E2E: proposal executed with decision record attached", final?.status === "executed" && final.decisionRecord.modelVersion === curves.MODEL_VERSION);

  // TOCTOU: tampered binding hash halts.
  const created2 = await checkout.materializeModeAApproval(approvalStore, {
    proposal: saved, clientAdAccountId: "act_client_1", platform: "meta", createdBy: "f1-optimizer",
  });
  await approvals.submitApproval(approvalStore, created2.id, WS, "owner1");
  await approvals.approveApproval(approvalStore, {
    id: created2.id, workspaceId: WS, approverId: "owner1", approverMediaRole: "owner",
    method: "sso", twoPersonThresholdCents: 100_000,
  });
  await approvalStore.update(created2.id, WS, { bindingHash: "0".repeat(64) });
  const haltRes = await checkout.executeModeAMove(created2.id, saved.id, WS, "owner1", {
    store, approvalStore, adapter, notify: async () => {}, now: NOW,
  });
  check("E2E: tampered binding hash HALTs execution", !haltRes.executed && /binding hash/i.test(haltRes.haltReason ?? ""));

  // Real adapter: honest not-configured.
  const real = checkout.createRealPlatformAdapter();
  let nc = false;
  try {
    await real.applyBudgetShift({ workspaceId: WS, sourceCampaignRef: "a", destCampaignRef: "b", amountCents: 100, idempotencyKey: "k", correlationId: "c" });
  } catch (e) {
    nc = e instanceof checkout.NotConfiguredError;
  }
  check("E2E: real adapter throws honest not-configured", nc);
}

// ===========================================================================
// F. Geo-holdout planner
// ===========================================================================
console.log("\n[F] geo-holdout planner");

{
  const markets = [1, 2, 3, 4, 5, 6].map((i) => ({
    id: `dma_${i}`,
    label: `DMA ${i}`,
    baselineSpendCents: 50_000 * i,
    baselineRevenueCents: 150_000 * i,
  }));
  const plan = geo.planGeoHoldout({ workspaceId: WS, channel: "meta_prospecting", markets, liftToDetect: 0.15 });
  check("holdout plan pairs all markets", plan.pairs.length === 3 && plan.unmatched.length === 0);
  check("holdout duration ≥ one business cycle", plan.weeks >= 2, `${plan.weeks} weeks`);
  const plan2 = geo.planGeoHoldout({ workspaceId: WS, channel: "meta_prospecting", markets, liftToDetect: 0.15 });
  check("holdout plan deterministic", JSON.stringify(plan.pairs) === JSON.stringify(plan2.pairs));
  check("calibration guidance present", /iroasCalibrationFactor/.test(plan.calibrationGuidance));
  let threw = false;
  try {
    geo.planGeoHoldout({ workspaceId: WS, channel: "x", markets: markets.slice(0, 2), liftToDetect: 0.15 });
  } catch {
    threw = true;
  }
  check("<4 markets rejected", threw);
}

// ===========================================================================
console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log("failures:", failures.join(", "));
  process.exit(1);
}
