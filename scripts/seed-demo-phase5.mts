// Marketr — Phase 5 demo data for the preview server / screenshots.
// Seeds: a budget pool with ledger history, one executed buy (approved,
// two-person, executed in FAKE mode), one pending approval, per-placement
// QR/pURL tracking links with scan events, promo codes, a CallRail number,
// kill rules, and spend ledger entries for reconciliation.
// Run:  npx tsx scripts/seed-demo-phase5.mts   (from ~/workspace/marketr)
// Idempotent: skips when the demo pool already exists. Demo rows are all
// prefixed "Demo —" and use demo-* ids; existing Phase 3/4 records untouched.

import { createHash } from "node:crypto";
import fs from "node:fs";

const envFile = fs.readFileSync(".env", "utf8");
const adminEmail = (envFile.match(/^ADMIN_EMAIL=(.*)$/m)?.[1] ?? "")
  .replace(/^"|"$/g, "")
  .trim()
  .toLowerCase();
if (!adminEmail) throw new Error("ADMIN_EMAIL missing in .env");
const userId = `admin:${adminEmail}`;
const secondApprover = "demo:second-approver";

const { prisma } = await import("@/lib/prisma");
const { bindingHashOf } = await import("@/lib/media/approvals");

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

let wsRow = await prisma.workspace.findFirst({ where: { ownerUserId: userId } });
if (!wsRow) {
  // Fresh DB (the ephemeral preview database was wiped): recreate the admin
  // workspace the way getOrCreateWorkspace() would on first login.
  wsRow = await prisma.workspace.create({
    data: {
      name: `${adminEmail}'s workspace`,
      ownerUserId: userId,
      plan: "self_hosted",
      members: { create: { userId, role: "owner" } },
    },
  });
  console.log("created admin workspace", wsRow.id);
}
const ws = wsRow.id;
console.log("workspace", ws);

const existing = await prisma.budgetPool.findFirst({
  where: { workspaceId: ws, name: { startsWith: "Demo —" } },
});
if (existing) {
  console.log("demo pool exists, skipping seed:", existing.name);
  process.exit(0);
}

// --- Budget pool ------------------------------------------------------------
const pool = await prisma.budgetPool.create({
  data: {
    workspaceId: ws,
    clientId: "demo-acme-paving",
    name: "Demo — Q3 DOOH Pool",
    period: "monthly",
    capCents: 500000,
    remainingCents: 226580,
    encumberedCents: 95000,
    currency: "USD",
    platformAllowlist: ["blip", "blindspot", "spotify"],
    autoApproveThresholdCents: 0,
    virtualCardRef: "demo-vcard-ramp-001",
    cardProvider: "fake",
    status: "active",
    createdBy: userId,
  },
});
console.log("pool", pool.id);

const tx = async (
  kind: "encumber" | "spend" | "release" | "adjust",
  amountCents: number,
  runningRemaining: number,
  runningEncumbered: number,
  approvalId: string | null,
  note: string,
) =>
  prisma.poolTransaction.create({
    data: {
      poolId: pool.id,
      workspaceId: ws,
      approvalId,
      kind,
      amountCents,
      runningRemainingCents: runningRemaining,
      runningEncumberedCents: runningEncumbered,
      actor: userId,
      note,
    },
  });

// --- Executed buy approval (blip, $1,800 max, two-person approved) ------------
const creativeHash1 = sha256("demo-creative-blip-bulletin-v1");
const binding1 = {
  platform: "blip",
  clientAdAccountId: "demo-blip-acct-001",
  dealType: "auction",
  lineItems: [
    {
      inventory: "Blip — Greensboro digital bulletins (10 boards)",
      pricingModel: "per-blip",
      maxAllowedCents: 180000,
      flightStart: "2026-09-15",
      flightEnd: "2026-10-15",
      targetingSnapshot: { markets: ["Greensboro, NC"], dayparts: ["6a-10a", "3p-7p"] },
      creativeIds: ["demo-creative-001"],
      creativeHashes: [creativeHash1],
    },
  ],
  maxTotalSpendCents: 180000,
  currency: "USD",
  driftTolerance: { pricePct: 10, spendPct: 5 },
  creativeIds: ["demo-creative-001"],
  creativeHashes: [creativeHash1],
  flightStart: "2026-09-15",
  flightEnd: "2026-10-15",
  targetingSnapshot: { markets: ["Greensboro, NC"] },
  cancelTerms: "Cancel anytime; unspent budget returns to the pool.",
  operatorTermsVersion: "blip-tos-2026-09",
};
const approval1 = await prisma.mediaApproval.create({
  data: {
    workspaceId: ws,
    clientId: "demo-acme-paving",
    type: "buy",
    status: "executed",
    bindingJson: binding1,
    bindingHash: bindingHashOf(binding1 as never),
    maxSpendCents: 180000,
    currency: "USD",
    poolId: pool.id,
    createdBy: userId,
    approversJson: [
      { userId, decidedAt: new Date("2026-09-14T14:02:00Z").toISOString(), method: "sso", receipt: "demo-receipt-001" },
      { userId: secondApprover, decidedAt: new Date("2026-09-14T15:20:00Z").toISOString(), method: "sso", receipt: "demo-receipt-002" },
    ],
    twoPersonSatisfied: true,
    approvalMethod: "sso",
    approvedAt: new Date("2026-09-14T15:20:00Z"),
    executedAt: new Date("2026-09-15T09:00:00Z"),
  },
});
console.log("approval (executed)", approval1.id);

await tx("adjust", 500000, 500000, 0, null, "Demo — pool funded ($5,000 cap)");
await tx("encumber", 180000, 320000, 180000, approval1.id, "Demo — encumbered for Blip buy");
await tx("spend", 178420, 321580, 0, approval1.id, "Demo — Blip buy executed, actual $1,784.20");
await tx("release", 1580, 321580, 0, approval1.id, "Demo — released unused encumbrance");

const buy = await prisma.mediaBuy.create({
  data: {
    workspaceId: ws,
    approvalId: approval1.id,
    poolId: pool.id,
    platform: "blip",
    clientAdAccountId: "demo-blip-acct-001",
    status: "executed",
    platformCampaignRef: "demo-blip-camp-0042",
    executedAt: new Date("2026-09-15T09:00:00Z"),
    actualSpendCents: 178420,
    killRulesRegistered: ["demo-stop-loss", "demo-test-cap"],
  },
});
console.log("buy", buy.id);

// --- Pending approval (blindspot, $950 — awaiting second approver) -----------
const binding2 = {
  platform: "blindspot",
  clientAdAccountId: "demo-blindspot-acct-001",
  dealType: "auction",
  lineItems: [
    {
      inventory: "Blindspot — Raleigh-Durham transit shelters (25 units)",
      pricingModel: "per-play",
      maxAllowedCents: 95000,
      flightStart: "2026-10-01",
      flightEnd: "2026-10-31",
      targetingSnapshot: { markets: ["Raleigh-Durham, NC"] },
      creativeIds: ["demo-creative-002"],
      creativeHashes: [sha256("demo-creative-blindspot-shelter-v1")],
    },
  ],
  maxTotalSpendCents: 95000,
  currency: "USD",
  driftTolerance: { pricePct: 10, spendPct: 5 },
  creativeIds: ["demo-creative-002"],
  creativeHashes: [sha256("demo-creative-blindspot-shelter-v1")],
  flightStart: "2026-10-01",
  flightEnd: "2026-10-31",
  targetingSnapshot: { markets: ["Raleigh-Durham, NC"] },
  cancelTerms: "Cancel anytime; unspent budget returns to the pool.",
  operatorTermsVersion: "blindspot-tos-2026-09",
};
const approval2 = await prisma.mediaApproval.create({
  data: {
    workspaceId: ws,
    clientId: "demo-acme-paving",
    type: "buy",
    status: "pending",
    bindingJson: binding2,
    bindingHash: bindingHashOf(binding2 as never),
    maxSpendCents: 95000,
    currency: "USD",
    poolId: pool.id,
    createdBy: userId,
    approversJson: [
      { userId, decidedAt: new Date("2026-09-24T16:40:00Z").toISOString(), method: "sso", receipt: "demo-receipt-003" },
    ],
    twoPersonSatisfied: false,
    approvalMethod: "sso",
  },
});
await tx("encumber", 95000, 226580, 95000, approval2.id, "Demo — encumbered for Blindspot buy (pending)");
console.log("approval (pending)", approval2.id);

// --- Per-placement QR/pURL links --------------------------------------------
const links = [
  { slug: "demo-board-47", placementRef: "Blip board #47 — Wendover Ave", scans: 34 },
  { slug: "demo-board-52", placementRef: "Blip board #52 — Battleground Ave", scans: 21 },
  { slug: "demo-shelter-09", placementRef: "Transit shelter #09 — Downtown", scans: 12 },
];
for (const l of links) {
  const link = await prisma.trackingLink.create({
    data: {
      workspaceId: ws,
      buyId: buy.id,
      placementRef: l.placementRef,
      slug: l.slug,
      destinationUrl: "https://demo.example.com/paving-offer",
      utmJson: { utm_source: "dooh", utm_medium: "billboard", utm_campaign: "demo-q3-dooh", utm_content: l.slug },
      engine: "marketr",
      status: "active",
      scansCount: l.scans,
    },
  });
  const events = Math.min(l.scans, 8);
  for (let i = 0; i < events; i++) {
    await prisma.scanEvent.create({
      data: {
        linkId: link.id,
        occurredAt: new Date(Date.now() - i * 36e5 * 7),
        userAgent: "Demo scan event",
        ipHash: sha256(`demo-ip-${l.slug}-${i}`),
        referer: null,
      },
    });
  }
  console.log("link", l.slug, l.scans, "scans");
}

// --- Promo codes --------------------------------------------------------------
for (const [code, redemptions] of [["PAVE20", 9], ["PAVE10", 4]] as const) {
  const p = await prisma.promoCode.create({
    data: {
      workspaceId: ws,
      buyId: buy.id,
      code: `DEMO-${code}`,
      channelRef: "radio-demo-wfm",
      redemptionsCount: redemptions,
      status: "active",
    },
  });
  for (let i = 0; i < Math.min(redemptions, 5); i++) {
    await prisma.redemptionEvent.create({
      data: { promoCodeId: p.id, occurredAt: new Date(Date.now() - i * 36e5 * 11), orderRef: `demo-order-${i}` },
    });
  }
  console.log("promo", code, redemptions, "redemptions");
}

// --- CallRail number ------------------------------------------------------------
await prisma.mediaCallNumber.create({
  data: {
    workspaceId: ws,
    buyId: buy.id,
    provider: "callrail",
    numberE164: "+13365550142",
    stationRef: "Demo — WFMY radio spot",
    status: "active",
    callsCount: 17,
    totalDurationSec: 2140,
    firstCallAt: new Date("2026-09-16T10:00:00Z"),
    lastCallAt: new Date("2026-09-24T18:30:00Z"),
  },
});
console.log("call number created");

// --- Kill rules -----------------------------------------------------------------
for (const [name, action, condition] of [
  ["Demo — stop-loss: pause if CPA > $40", "pause", { metric: "cpa_cents", operator: ">", value: 4000 }],
  ["Demo — test-cap kill: pause after $150 test spend", "pause", { metric: "spend_cents", operator: ">=", value: 15000, window: "campaign" }],
  ["Demo — spend anomaly alert", "alert", { metric: "spend_velocity", operator: "anomaly", zscore: 3 }],
] as const) {
  await prisma.killRule.create({
    data: {
      workspaceId: ws,
      clientId: "demo-acme-paving",
      name,
      scopeJson: { platforms: ["blip", "blindspot"] },
      conditionJson: condition,
      window: "1h",
      action,
      cooldownMinutes: 60,
      enabled: true,
      createdBy: userId,
    },
  });
  console.log("kill rule", name);
}

// --- Spend ledger (reconciliation) ----------------------------------------------
for (const [kind, amountCents, note] of [
  ["estimate", 180000, "Demo — planner estimate for Blip buy"],
  ["encumbrance", 180000, "Demo — encumbered at approval"],
  ["spend", 178420, "Demo — actual platform spend"],
] as const) {
  await prisma.mediaSpendEntry.create({
    data: {
      workspaceId: ws,
      buyId: buy.id,
      kind,
      amountCents,
      approvalRef: approval1.id,
      note,
    },
  });
}
console.log("spend ledger entries created");

console.log("Phase 5 demo seed complete.");
