// Marketr — Phase 5 cross-track integration battery.
//
// Run: DATABASE_URL=<redacted> npx tsx scripts/verify-phase5-integration.mts
//
// End-to-end, against the REAL migrated Postgres stores (SqlPoolStore,
// SqlApprovalStore, SqlKillRuleStore, SqlMediaReceiptStore, PrismaMediaStore):
//   1.  pool → proposal → two-person (OTP) approval → encumbrance → preflight
//       → execute → receipt → variance 0
//   2.  creative swap halts
//   3.  spend increase invalidates the binding
//   4.  revoked approval refuses execution
//   5.  stale quote blocks; re-quote passes
//   6.  spend-anomaly sweeper fires (alert + pause)
//   7.  tracking-link scan ledger, promo redemption ledger, CallRail ledger
//   8.  reconciliation variance 0 + report-card caveats
//   9.  styled custom-glyph round-mask QR + real decoder exact URL match
//   10. emergency stop freezes pools + revokes pending approvals
//   11. full audit export + hash-chain verification
//   12. structural invariants: zero custody, autopilot never buys,
//       no AdQuick API code

const poolsLib = await import("@/lib/media/pools");
const apprLib = await import("@/lib/media/approvals");
const safetyLib = await import("@/lib/media/safety");
const execLib = await import("@/lib/media/executor");
const killLib = await import("@/lib/media/killswitch");
const cardsLib = await import("@/lib/media/cards");
const receiptTermsLib = await import("@/lib/media/receipts");
const dbLib = await import("@/lib/media/db");
const buyingStoreLib = await import("@/lib/media/buying-store");
const storeLib = await import("@/lib/media/store");
const linksLib = await import("@/lib/media/links");
const promoLib = await import("@/lib/media/promo");
const callrailLib = await import("@/lib/media/callrail");
const reconLib = await import("@/lib/media/reconciliation");
const reportLib = await import("@/lib/media/report");
const qrDesigner = await import("@/lib/studio/qr-designer");
const { prisma } = await import("@/lib/prisma");
const { ADQUICK_SELF_SERVE_URL } = await import("@/lib/media/dooh");
import type * as apprTypes from "@/lib/media/approvals";
import type * as killTypes from "@/lib/media/killswitch";

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

async function throwsAsync(fn: () => Promise<unknown>, needle: string): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    return e instanceof Error && e.message.includes(needle);
  }
}

const WS = "ws-verify-integration";
const CLIENT = "client:acme-integration";
const BUY = "buy-int-1";
const CREATOR = "user-creator-int";
const ALICE = "user-alice-int";
const BOB = "user-bob-int";
const now = new Date();
const flightStart = now.toISOString().slice(0, 10);
const flightEnd = new Date(now.getTime() + 30 * 86400_000).toISOString().slice(0, 10);
const CREATIVE_HASH = safetyLib.sha256Hex("creative-bytes-board-47");
const RECEIPT_SECRET = "integration-test-secret";

await prisma.workspace.deleteMany({ where: { id: WS } }); // fixture reset — FKs cascade
await prisma.workspace.upsert({
  where: { id: WS },
  create: { id: WS, name: "Integration battery fixture", ownerUserId: "verify-owner" },
  update: {},
});

const stores = dbLib.mediaStores();
const approvalStore = stores.approvals;
const poolStore = stores.pools;
const killStore = stores.killRules;
const receiptStore = new buyingStoreLib.SqlMediaReceiptStore();
const mediaStore = await storeLib.getMediaStore();
const otpStore = new safetyLib.OtpChallengeStore();

function makeBinding(overrides: Partial<apprTypes.BuyBinding> = {}): apprTypes.BuyBinding {
  return {
    platform: "blip",
    clientAdAccountId: "client:acme:blip",
    dealType: "auction",
    lineItems: [
      {
        inventory: "board-47",
        pricingModel: "plays",
        maxAllowedCents: 150_000,
        flightStart,
        flightEnd,
        targetingSnapshot: { geo: "Greensboro, NC", dayparts: ["am-drive"] },
        creativeIds: ["cr-1"],
        creativeHashes: [CREATIVE_HASH],
      },
    ],
    maxTotalSpendCents: 150_000,
    currency: "USD",
    driftTolerance: { pricePct: 0.05, spendPct: 0.05 },
    creativeIds: ["cr-1"],
    creativeHashes: [CREATIVE_HASH],
    flightStart,
    flightEnd,
    targetingSnapshot: { geo: "Greensboro, NC" },
    cancelTerms: "cancel anytime before flight start",
    operatorTermsVersion: "blip-tos-2026-01",
    ...overrides,
  };
}

const encumberOnApproval =
  (poolId: string) =>
  async (approval: apprTypes.MediaApproval): Promise<{ alertsFired: number[] }> => {
    const r = await poolsLib.encumberForApproval(poolStore, {
      poolId,
      workspaceId: WS,
      approvalId: approval.id,
      amountCents: approval.maxSpendCents,
      platform: approval.binding.platform,
      actor: "system",
    });
    return { alertsFired: r.alertsFired };
  };

async function approveWithOtp(
  approvalId: string,
  approverId: string,
  poolId: string | null,
): Promise<apprTypes.MediaApproval> {
  const ch = otpStore.mint();
  return apprLib.approveApproval(approvalStore, {
    id: approvalId,
    workspaceId: WS,
    approverId,
    approverMediaRole: "owner",
    method: "otp",
    otpChallengeId: ch.challengeId,
    otpCode: ch.code,
    otpStore,
    receiptSecret: RECEIPT_SECRET,
    twoPersonThresholdCents: 100_000,
    ...(poolId ? { onApproved: encumberOnApproval(poolId) } : {}),
  });
}

// ---------------------------------------------------------------------------
// 12. Structural invariants (checked first — everything else assumes them)
// ---------------------------------------------------------------------------
console.log("12 · structural invariants");
check(
  "zero custody: card adapters run in test mode, never live",
  cardsLib.cardAdapterMode() === "test",
  `mode=${cardsLib.cardAdapterMode()}`,
);
check(
  "zero custody: test-mode issuance yields a fake namespaced ref — no real card, no money moves",
  (await cardsLib.cardProviderFor("brex").issueCard({
    poolId: "pool-int-fixture",
    workspaceId: WS,
    limitCents: 500_000,
    currency: "USD",
    providerAccountRef: "client:acme:brex", // must be the CLIENT's account, never the agency's
    memo: "integration battery",
  })).cardRef.startsWith("vcard_brex_test_"),
);
check(
  "zero custody: live issuance without provider keys is unreachable",
  await throwsAsync(
    () =>
      cardsLib
        .cardProviderFor("brex", { ...process.env, MEDIA_CARD_MODE: "live" } as NodeJS.ProcessEnv)
        .issueCard({
          poolId: "pool-int-fixture",
          workspaceId: WS,
          limitCents: 500_000,
          currency: "USD",
          providerAccountRef: "client:acme:brex",
          memo: "integration battery",
        }),
    "not configured",
  ),
);
check(
  "autopilot never buys: dooh_buy rung is supervised-only",
  safetyLib.MODULE_RUNGS.dooh_buy.rung === "supervised" &&
    safetyLib.MODULE_RUNGS.dooh_buy.neverAutopilot === true,
);
check(
  "autopilot never buys: execution without a human approval is blocked",
  await throwsAsync(
    async () => safetyLib.requireHumanSupervisedApproval("dooh_buy", null),
    "Autopilot",
  ),
);
check(
  "no AdQuick API code: referral is a plain URL constant, no key, no client",
  ADQUICK_SELF_SERVE_URL === "https://www.adquick.com" &&
    !ADQUICK_SELF_SERVE_URL.includes("?") &&
    !ADQUICK_SELF_SERVE_URL.includes("api"),
  ADQUICK_SELF_SERVE_URL,
);

// ---------------------------------------------------------------------------
// 1. Happy path: pool → proposal → two-person approval → encumbrance →
//    preflight → execute → receipt → variance 0
// ---------------------------------------------------------------------------
console.log("1 · happy path (pool → approval → encumbrance → preflight → execute → receipt)");

const pool = await poolsLib.createPool(poolStore, {
  workspaceId: WS,
  clientId: CLIENT,
  name: "ACME Q4 DOOH",
  period: "campaign",
  capCents: 500_000,
  platformAllowlist: ["blip"],
  createdBy: CREATOR,
});
check("pool created with full cap", pool.remainingCents === 500_000 && pool.status === "active");

let a = await apprLib.createApproval(approvalStore, {
  workspaceId: WS,
  clientId: CLIENT,
  type: "buy",
  binding: makeBinding(),
  poolId: pool.id,
  createdBy: CREATOR,
  createdByMediaRole: "media_buyer",
});
a = await apprLib.submitApproval(approvalStore, a.id, WS, CREATOR);
check("approval submitted (draft → pending)", a.status === "pending");

a = await approveWithOtp(a.id, ALICE, pool.id);
check("first approver recorded, buy stays pending (two-person)", a.status === "pending" && a.approvers.length === 1);

a = await approveWithOtp(a.id, BOB, pool.id);
check("second approver completes two-person approval", a.status === "approved" && a.twoPersonSatisfied);

const poolAfter = await poolStore.get(pool.id, WS);
check(
  "approval encumbered max spend from the pool",
  poolAfter !== null && poolAfter.encumberedCents === 150_000 && poolAfter.remainingCents === 350_000,
  poolAfter ? `enc=${poolAfter.encumberedCents} rem=${poolAfter.remainingCents}` : "pool missing",
);

const hooks = execLib.defaultTestHooks({
  rehashCreatives: async () => ({ "cr-1": CREATIVE_HASH }),
  now: () => now,
});
const deps = {
  approvalStore,
  poolStore,
  hooks,
  buyStore: stores.buys,
  receiptSecret: RECEIPT_SECRET,
};
const pre = await execLib.runPreflight(a.id, WS, deps);
check("preflight passes on the clean happy path", pre.ok, pre.haltReason ?? "");

const execResult = await execLib.executeBuy(a.id, WS, "user-executor-int", deps);
check("executor executes the approved buy", execResult.executed === true);
const aAfterExec = await approvalStore.get(a.id, WS);
check("approval status → executed", aAfterExec?.status === "executed");

const matchingTerms = {
  vendor: "blip",
  totalSpendCents: 150_000,
  currency: "USD",
  flightStart,
  flightEnd,
  lines: [{ label: "board-47", amountCents: 150_000 }],
  invoiceNumber: "INV-INT-1",
};
const tv = receiptTermsLib.verifyReceiptTermsAgainstBinding(matchingTerms, a.binding as never);
check("receipt terms verify against the binding", tv.verified && tv.flags.length === 0, JSON.stringify(tv.flags));

const receipt = await receiptStore.create({
  workspaceId: WS,
  buyId: BUY,
  capturedBy: "browser_executor",
  platformInvoiceRef: "INV-INT-1",
  amountCents: 150_000,
  currency: "USD",
  receiptUrl: null,
  parsedTermsJson: { ...matchingTerms },
  verified: true,
  approvalRef: a.id, // merged media_receipts.approval_ref NOT NULL — zero-custody trace
});
const varianceCents = (receipt.amountCents ?? 0) - a.maxSpendCents;
check("receipt persists with approvalRef; variance 0", receipt.approvalRef === a.id && varianceCents === 0);

// ---------------------------------------------------------------------------
// 2. Creative swap halts
// ---------------------------------------------------------------------------
console.log("2 · creative swap halts");
async function approvedBuy(
  tag: string,
  bindingOverrides: Partial<apprTypes.BuyBinding> = {},
  maxSpend = 10_000,
): Promise<apprTypes.MediaApproval> {
  const binding = makeBinding({
    ...bindingOverrides,
    maxTotalSpendCents: maxSpend,
    lineItems: [
      {
        inventory: "board-47",
        pricingModel: "plays",
        maxAllowedCents: maxSpend,
        flightStart,
        flightEnd,
        targetingSnapshot: { geo: "Greensboro, NC" },
        creativeIds: ["cr-1"],
        creativeHashes: [CREATIVE_HASH],
      },
    ],
  });
  let ap = await apprLib.createApproval(approvalStore, {
    workspaceId: WS,
    clientId: CLIENT,
    type: "buy",
    binding,
    poolId: pool.id,
    createdBy: CREATOR,
    createdByMediaRole: "media_buyer",
  });
  ap = await apprLib.submitApproval(approvalStore, ap.id, WS, CREATOR);
  // sub-threshold buys: single approver, no OTP needed
  ap = await apprLib.approveApproval(approvalStore, {
    id: ap.id,
    workspaceId: WS,
    approverId: ALICE,
    approverMediaRole: "owner",
    method: "sso",
    receiptSecret: RECEIPT_SECRET,
    twoPersonThresholdCents: 100_000,
    onApproved: encumberOnApproval(pool.id),
  });
  return ap;
}

const b = await approvedBuy("swap");
const swapPre = await execLib.runPreflight(
  b.id,
  WS,
  {
    ...deps,
    hooks: execLib.defaultTestHooks({
      rehashCreatives: async () => ({ "cr-1": "tampered-hash-000000" }),
      now: () => now,
    }),
  },
);
check(
  "swapped creative fails preflight (creative-hash)",
  !swapPre.ok && swapPre.haltReason?.includes("CREATIVE SWAP") === true,
  swapPre.haltReason ?? "",
);
const swapExec = await execLib.executeBuy(
  b.id,
  WS,
  "user-executor-int",
  {
    ...deps,
    hooks: execLib.defaultTestHooks({
      rehashCreatives: async () => ({ "cr-1": "tampered-hash-000000" }),
      now: () => now,
    }),
  },
);
check(
  "swapped creative never executes; status stays approved",
  swapExec.executed === false && (await approvalStore.get(b.id, WS))?.status === "approved",
);

// ---------------------------------------------------------------------------
// 3. Spend increase invalidates the binding
// ---------------------------------------------------------------------------
console.log("3 · spend increase invalidates binding");
const c = await approvedBuy("spend-bump");
check(
  "untampered binding hash verifies",
  apprLib.verifyBinding(c.binding, c.bindingHash) === true,
);
// Store layer refuses binding mutation outright (immutability by design).
await approvalStore.update(c.id, WS, {
  binding: { ...c.binding, maxTotalSpendCents: c.binding.maxTotalSpendCents + 1_000 },
} as never);
const cStill = await approvalStore.get(c.id, WS);
check(
  "approval update cannot mutate the binding (store-level immutability)",
  cStill !== null && cStill.binding.maxTotalSpendCents === c.binding.maxTotalSpendCents,
);
// True TOCTOU: an out-of-band write (race/attacker) tampers binding_json
// directly in the DB, bypassing the service layer.
await prisma.$executeRawUnsafe(
  `UPDATE media_approvals SET binding_json = $1::jsonb WHERE id = $2 AND workspace_id = $3`,
  JSON.stringify({ ...c.binding, maxTotalSpendCents: c.binding.maxTotalSpendCents + 1_000 }),
  c.id,
  WS,
);
const cTampered = await approvalStore.get(c.id, WS);
check(
  "post-approval spend increase breaks the binding hash (TOCTOU)",
  cTampered !== null && apprLib.verifyBinding(cTampered.binding, cTampered.bindingHash) === false,
);
const cPre = await execLib.runPreflight(c.id, WS, deps);
check(
  "tampered binding fails preflight (binding-integrity)",
  !cPre.ok && cPre.haltReason?.includes("BINDING TAMPERED") === true,
  cPre.haltReason ?? "",
);

// ---------------------------------------------------------------------------
// 4. Revoked approval refuses execution
// ---------------------------------------------------------------------------
console.log("4 · revoked approval refuses");
const d = await approvedBuy("revoke");
const dEncBefore = (await poolStore.get(pool.id, WS))?.encumberedCents ?? 0;
await apprLib.revokeApproval(approvalStore, d.id, WS, ALICE, "owner", "client paused campaign", async (ap) => {
  await poolsLib.releaseEncumbrance(poolStore, {
    poolId: pool.id,
    workspaceId: WS,
    approvalId: ap.id,
    amountCents: ap.maxSpendCents,
    actor: ALICE,
    reason: "revocation releases encumbrance",
  });
});
const dRevoked = await approvalStore.get(d.id, WS);
check("approval revoked", dRevoked?.status === "revoked");
const dEncAfter = (await poolStore.get(pool.id, WS))?.encumberedCents ?? 0;
check("revocation releases the encumbrance", dEncAfter === dEncBefore - d.maxSpendCents, `before=${dEncBefore} after=${dEncAfter}`);
const dPre = await execLib.runPreflight(d.id, WS, deps);
check(
  "revoked approval fails preflight (approval-alive)",
  !dPre.ok && dPre.haltReason?.includes("status=revoked") === true,
  dPre.haltReason ?? "",
);

// ---------------------------------------------------------------------------
// 5. Stale quote blocks; re-quote passes
// ---------------------------------------------------------------------------
console.log("5 · stale quote blocks, re-quote passes");
function pdBinding(quoteId: string, quoteExpiresAt: string): apprTypes.BuyBinding {
  return makeBinding({
    dealType: "pd",
    quoteId,
    quoteExpiresAt,
    maxTotalSpendCents: 10_000,
    lineItems: [
      {
        inventory: "shelter-main-st-03",
        pricingModel: "4-week",
        maxAllowedCents: 10_000,
        flightStart,
        flightEnd,
        targetingSnapshot: { geo: "Greensboro, NC" },
        creativeIds: ["cr-1"],
        creativeHashes: [CREATIVE_HASH],
      },
    ],
  });
}
const e = await apprLib.createApproval(approvalStore, {
  workspaceId: WS, clientId: CLIENT, type: "buy", binding: pdBinding("Q-INT-1", new Date(now.getTime() - 86400_000).toISOString()),
  poolId: pool.id, createdBy: CREATOR, createdByMediaRole: "media_buyer",
}).then((ap) => apprLib.submitApproval(approvalStore, ap.id, WS, CREATOR));
await apprLib.approveApproval(approvalStore, {
  id: e.id, workspaceId: WS, approverId: ALICE, approverMediaRole: "owner", method: "sso",
  receiptSecret: RECEIPT_SECRET, twoPersonThresholdCents: 100_000, onApproved: encumberOnApproval(pool.id),
});
const staleQuoteHooks = execLib.defaultTestHooks({
  rehashCreatives: async () => ({ "cr-1": CREATIVE_HASH }),
  refetchQuote: async (quoteId) =>
    quoteId === "Q-INT-1"
      ? { quoteId, expiresAt: new Date(now.getTime() - 3600_000), priceCents: 10_000 }
      : null,
  now: () => now,
});
const ePre = await execLib.runPreflight(e.id, WS, { ...deps, hooks: staleQuoteHooks });
check(
  "stale quote blocks execution (quote-then-book)",
  !ePre.ok && ePre.checks.some((ch) => ch.name === "quote" && !ch.ok),
  ePre.haltReason ?? "",
);

const f = await apprLib.createApproval(approvalStore, {
  workspaceId: WS, clientId: CLIENT, type: "buy", binding: pdBinding("Q-INT-2", new Date(now.getTime() + 7 * 86400_000).toISOString()),
  poolId: pool.id, createdBy: CREATOR, createdByMediaRole: "media_buyer",
}).then((ap) => apprLib.submitApproval(approvalStore, ap.id, WS, CREATOR));
await apprLib.approveApproval(approvalStore, {
  id: f.id, workspaceId: WS, approverId: ALICE, approverMediaRole: "owner", method: "sso",
  receiptSecret: RECEIPT_SECRET, twoPersonThresholdCents: 100_000, onApproved: encumberOnApproval(pool.id),
});
const freshQuoteHooks = execLib.defaultTestHooks({
  rehashCreatives: async () => ({ "cr-1": CREATIVE_HASH }),
  refetchQuote: async (quoteId) =>
    quoteId === "Q-INT-2"
      ? { quoteId, expiresAt: new Date(now.getTime() + 7 * 86400_000), priceCents: 10_000 }
      : null,
  now: () => now,
});
const fPre = await execLib.runPreflight(f.id, WS, { ...deps, hooks: freshQuoteHooks });
check(
  "re-quoted buy passes the quote check",
  fPre.checks.some((ch) => ch.name === "quote" && ch.ok),
  JSON.stringify(fPre.checks.filter((ch) => !ch.ok).map((ch) => ch.name)),
);

// ---------------------------------------------------------------------------
// 6. Spend-anomaly sweeper fires
// ---------------------------------------------------------------------------
console.log("6 · spend-anomaly sweeper");
for (const rule of killLib.defaultRulePack(WS, CLIENT, "system")) {
  await killStore.create(rule);
}
const firedActions: killTypes.FiredAction[] = [];
const anomalyFired = await killLib.evaluateRules(
  killStore,
  WS,
  [
    {
      poolId: pool.id,
      platform: "blip",
      buyId: BUY,
      approvalId: a.id,
      spendCents: 120_000,
      dailySpendPct: 85,
      hourOfDay: 9,
      cpa: 1.0,
      conversions: 5,
      ctr: 0.4,
      ctrDecayPct: 5,
      failures: 0,
      ts: now,
    },
  ],
  { now: () => now, onAction: async (fa) => { firedActions.push(fa); } },
);
check(
  "spend-anomaly (85% of daily budget before noon) fires an alert",
  anomalyFired.some((fa) => fa.ruleName === "spend-anomaly alert" && fa.action === "alert"),
  JSON.stringify(anomalyFired.map((fa) => fa.ruleName)),
);
const fired2: killTypes.FiredAction[] = [];
const exhaustedFired = await killLib.evaluateRules(
  killStore,
  WS,
  [
    {
      poolId: pool.id,
      platform: "blip",
      buyId: BUY,
      approvalId: a.id,
      spendCents: 500_000,
      dailySpendPct: 100,
      hourOfDay: 14,
      cpa: 1.0,
      conversions: 5,
      ctr: 0.4,
      ctrDecayPct: 5,
      failures: 0,
      ts: now,
    },
  ],
  { now: () => new Date(now.getTime() + 3 * 3600_000), onAction: async (fa) => { fired2.push(fa); } },
);
check(
  "pool-exhausted snapshot fires a pause action",
  exhaustedFired.some((fa) => fa.ruleName === "pool-exhausted pause-all" && fa.action === "pause"),
  JSON.stringify(exhaustedFired.map((fa) => fa.ruleName)),
);

// ---------------------------------------------------------------------------
// 7. Attribution ledgers: link scans, promo redemptions, CallRail webhook
// ---------------------------------------------------------------------------
console.log("7 · attribution ledgers");
const engine = new linksLib.MarketrLinkEngine(mediaStore, "brand.link");
const link = await engine.createLink({
  workspaceId: WS,
  buyId: BUY,
  placementRef: "board-47",
  destinationUrl: "https://acme.example/offer",
});
await engine.recordScan({ workspaceId: WS, slug: link.slug, userAgent: "ua-1", ip: "1.2.3.4" });
await engine.recordScan({ workspaceId: WS, slug: link.slug, userAgent: "ua-1", ip: "1.2.3.4" });
await engine.recordScan({ workspaceId: WS, slug: link.slug, userAgent: "ua-2", ip: "5.6.7.8" });
const scans = await mediaStore.listScanEvents(link.id);
check("tracking link scan ledger records 3 scans", scans.length === 3, `got ${scans.length}`);

const promoSvc = promoLib.createPromoService(mediaStore);
const codes = await promoSvc.generate({ workspaceId: WS, buyId: BUY, channelRefs: ["qr-board-47"], prefix: "INT" });
await promoSvc.redeem(WS, codes[0].code, "order-1");
await promoSvc.redeem(WS, codes[0].code, "order-2");
const promos = await promoSvc.list(WS, BUY);
const rollup = promoLib.promoRollup(promos);
check("promo redemption ledger records 2 redemptions", rollup.totalRedemptions === 2, `got ${rollup.totalRedemptions}`);

const callSvc = callrailLib.createCallRailService(mediaStore, new callrailLib.FakeCallRailProvider());
const num = await callSvc.provisionTrackingNumber({ workspaceId: WS, buyId: BUY, stationRef: "board-47", areaCode: "336" });
const evt = (eventId: string, callId: string, type: string, occurredAt: string) => ({
  eventId, callId, type, trackingNumberE164: num.numberE164,
  callerE164: "+19195550100", durationSec: 95, occurredAt, raw: { eventId },
});
const postCall = (events: unknown[]) => {
  const rawBody = JSON.stringify({ events });
  return callSvc.ingestWebhook({ rawBody, signature: callrailLib.signFakeCallRailWebhook(rawBody), workspaceId: WS });
};
const w1 = await postCall([evt("evt-int-a-started", "call-IA", "started", "2026-09-20T10:00:00Z"), evt("evt-int-a-done", "call-IA", "completed", "2026-09-20T10:02:00Z")]);
check("CallRail webhook ledger accepts the call", w1.accepted === true && w1.eventsApplied === 1, JSON.stringify(w1));
const callStats = await callSvc.pollCallStats(WS, BUY);
check("call ledger reports the completed call", callStats.calls === 1, JSON.stringify(callStats));

// ---------------------------------------------------------------------------
// 8. Reconciliation variance 0 + report-card caveats
// ---------------------------------------------------------------------------
console.log("8 · reconciliation + report card");
await reconLib.recordSpend(mediaStore, {
  workspaceId: WS,
  buyId: BUY,
  kind: "spend",
  amountCents: 150_000,
  approvalRef: a.id,
  note: "executed buy converted encumbrance",
});
const recon = await reconLib.reconcileBuy(
  mediaStore,
  {
    name: "fake-platform-feed",
    getActualSpend: async () => [
      { platform: "blip", invoiceRef: "INV-INT-1", amountCents: 150_000, periodStart: flightStart, periodEnd: flightEnd },
    ],
  },
  WS,
  BUY,
);
check("reconciliation variance is 0 (ledger == platform actuals)", recon.varianceCents === 0, `variance=${recon.varianceCents}`);

const card = reportLib.buildReportCard({
  buyId: BUY,
  buyLabel: "Blip DOOH — board-47 (integration)",
  flightStart,
  flightEnd,
  links: {
    buyId: BUY,
    links: 1,
    totalScans: scans.length,
    byPlacement: [{ placementRef: "board-47", slug: link.slug, scans: scans.length }],
  },
  promo: rollup,
  calls: callStats,
  lift: {
    query: { brandQuery: "acme", baselineStart: flightStart, baselineEnd: flightStart, flightStart, flightEnd, boardMetros: ["Greensboro, NC"], holdoutMetros: [] },
    source: "gsc",
    baselineDays: 30,
    flightDays: 30,
    metros: [],
    netLiftPct: null,
    hasHoldout: false,
    devices: [
      { device: "mobile", baselineDaily: 10, flightDaily: 12, liftPct: 20 },
      { device: "desktop", baselineDaily: 8, flightDaily: 8, liftPct: 0 },
    ],
    verdict: "Directional lift only — no causal claim without holdouts.",
  },
  direct: { baselineDaily: 100, flightDaily: 112, liftPct: 12, note: "directional" },
  gbp: {
    baseline: { directionRequests: 20, calls: 5, websiteClicks: 30 },
    flight: { directionRequests: 24, calls: 6, websiteClicks: 33 },
    liftPct: { directionRequests: 20, calls: 20, websiteClicks: 10 },
    note: "directional",
  },
  recon,
});
check(
  "report card carries the attribution caveats (never silent about limits)",
  card.caveats.length > 0 && card.caveats.every((cav) => reportLib.ATTRIBUTION_CAVEATS.includes(cav)),
  `${card.caveats.length} caveats`,
);

// ---------------------------------------------------------------------------
// 9. Styled custom-glyph round-mask QR + real decode exact URL match
// ---------------------------------------------------------------------------
console.log("9 · styled QR (custom glyph, round mask) + real decode");
const qrUrl = "https://brand.link/board-47-int";
const qr = await qrDesigner.designQr({
  targetUrl: qrUrl,
  stylePrompt: "playful rounded dot modules in deep teal on cream",
  shapeMask: "round",
  glyphKind: "dots",
});
check(
  "styled QR renders with the requested round mask + dot glyphs",
  qr.ok === true && qr.png !== null && qr.spec.shapeMask === "round" && qr.spec.moduleGlyph === "dots",
  qr.fatal ?? qr.attempts.join(" | "),
);
check(
  "real decoder reads back the EXACT target URL",
  qr.scanTest.passed === true && qr.scanTest.decoded === qrUrl,
  `decoded=${qr.scanTest.decoded}`,
);

// ---------------------------------------------------------------------------
// 10. Emergency stop: freezes pools, revokes pending approvals
// ---------------------------------------------------------------------------
console.log("10 · emergency stop");
const pool2 = await poolsLib.createPool(poolStore, {
  workspaceId: WS,
  clientId: CLIENT,
  name: "ACME backup pool",
  period: "campaign",
  capCents: 100_000,
  platformAllowlist: ["blip"],
  createdBy: CREATOR,
});
let g = await apprLib.createApproval(approvalStore, {
  workspaceId: WS, clientId: CLIENT, type: "buy",
  binding: makeBinding({
    maxTotalSpendCents: 5_000,
    lineItems: [
      {
        inventory: "board-47",
        pricingModel: "plays",
        maxAllowedCents: 5_000,
        flightStart,
        flightEnd,
        targetingSnapshot: { geo: "Greensboro, NC" },
        creativeIds: ["cr-1"],
        creativeHashes: [CREATIVE_HASH],
      },
    ],
  }),
  poolId: pool2.id, createdBy: CREATOR, createdByMediaRole: "media_buyer",
});
g = await apprLib.submitApproval(approvalStore, g.id, WS, CREATOR);
const stop = await killLib.emergencyStop(
  {
    workspaceId: WS,
    clientId: CLIENT,
    reason: "integration battery emergency-stop drill",
    actor: ALICE,
    actorMediaRole: "owner",
  },
  {
    poolStore,
    approvalStore,
    pauseAllClientEntities: async () => ({ paused: 3 }),
    now: () => now,
  },
);
check("emergency stop freezes every active pool", stop.poolsFrozen.length >= 2, JSON.stringify(stop.poolsFrozen));
check("emergency stop revokes the pending approval", stop.approvalsRevoked.includes(g.id), JSON.stringify(stop.approvalsRevoked));
check("emergency stop pauses platform entities", stop.entitiesPaused === 3);
check("emergency stop exports an audit trail", (stop.auditTrail.approvals as unknown[]).length > 0);
const gAfter = await approvalStore.get(g.id, WS);
check("revoked-by-stop approval refuses preflight", !(await execLib.runPreflight(g.id, WS, deps)).ok && gAfter?.status === "revoked");

// ---------------------------------------------------------------------------
// 11. Full audit export + hash-chain verification
// ---------------------------------------------------------------------------
console.log("11 · audit export + hash-chain verification");
const trail = await killLib.exportAuditTrail(approvalStore, poolStore, WS, CLIENT);
const trailEvents = trail.events as Record<string, apprTypes.ApprovalEvent[]>;
let chainOk = true;
let chainCount = 0;
for (const [approvalId, events] of Object.entries(trailEvents)) {
  let prev = "GENESIS";
  for (const ev of events) {
    const ts = new Date(ev.ts).toISOString();
    const payloadHash = safetyLib.sha256Hex(apprLib.canonicalize(ev.detail ?? {}));
    const expected = apprLib.eventHashFor(prev, {
      approvalId,
      ts,
      actor: ev.actor,
      action: ev.action,
      payloadHash,
    });
    if (ev.prevHash !== prev || ev.eventHash !== expected || ev.payloadHash !== payloadHash) {
      chainOk = false;
      console.log(`  chain break: approval=${approvalId} event=${ev.id} action=${ev.action}`);
      break;
    }
    prev = ev.eventHash;
    chainCount++;
  }
  if (!chainOk) break;
}
check("every exported approval event verifies against the hash chain", chainOk && chainCount > 0, `${chainCount} events verified`);
check(
  "export covers the executed buy, the halted swap, and the emergency stop",
  Object.keys(trailEvents).includes(a.id) &&
    Object.keys(trailEvents).includes(b.id) &&
    Object.values(trailEvents).flat().some((ev) => ev.action === "emergency_stop"),
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("failures:", failures.join(", "));
  process.exit(1);
}
console.log("ALL INTEGRATION CHECKS PASSED");
