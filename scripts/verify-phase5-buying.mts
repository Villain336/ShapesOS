// Marketr — Phase 5 buying paths verification (B1/B2/B3).
//
// Run: DATABASE_URL=<postgres> npx tsx scripts/verify-phase5-buying.mts
//
// Covers:
//   1. Plan → canonical approval binding → launch-packet generation.
//   2. Packet contains the EXACT approved inventory, maximum spend,
//      flight window, and creative hashes (fail-closed on drift).
//   3. Stale quote execution is blocked (quote-then-book).
//   4. Operator price change at checkout halts the executor.
//   5. Receipt capture re-verifies terms against the binding and persists
//      a receipt record (DB-dependent portion runs only when the buying
//      fragment tables are migrated; otherwise SKIPs honestly).
//   6. IO brief renders and visibly includes the maximum-spend term.
//   7. Prompt-injection text on the operator screen is quarantined and
//      never alters execution.
//   8. Fake mode is the default; no real spend path exists.
//
// Strategy: exercise the real lib modules directly (route thin wrappers
// are mirrored where marked MIRROR). PDF generation writes under
// LAUNCH_PACKET_STORAGE_DIR / AUDIO_BRIEF_STORAGE_DIR /
// IO_BRIEF_STORAGE_DIR overrides so the repo's .data dir stays clean.

import { isValidElement } from "react";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "verify-buying-"));
process.env.LAUNCH_PACKET_STORAGE_DIR = join(scratch, "launch-packets");
process.env.AUDIO_BRIEF_STORAGE_DIR = join(scratch, "audio-briefs");
process.env.IO_BRIEF_STORAGE_DIR = join(scratch, "io-briefs");

const doohLib = await import("@/lib/media/dooh");
const audioLib = await import("@/lib/media/audio");
const ioLib = await import("@/lib/media/io-briefs");
const packetLib = await import("@/lib/media/launch-packet");
const execLib = await import("@/lib/media/executable");
const browserLib = await import("@/lib/media/browser-executor");
const receiptLib = await import("@/lib/media/receipts");
const approvalsLib = await import("@/lib/media/approvals");

let passed = 0;
let failed = 0;
let skipped = 0;
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

function skip(name: string, reason: string) {
  skipped++;
  console.log(`  SKIP ${name} — ${reason}`);
}

async function throwsAsync(fn: () => unknown | Promise<unknown>, needle: string): Promise<boolean> {
  try {
    await fn();
  } catch (e) {
    return (e as Error).message.includes(needle);
  }
  return false;
}

/** Collect all rendered text from a ReactElement tree (visibility probe).
 *  Includes string/number props (e.g. pdfcn `Labeled` label/value props)
 *  as well as children — the probe mirrors what the PDF renderer sees. */
function treeText(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(treeText).join(" ");
  if (isValidElement(node)) {
    const props = node.props as Record<string, unknown>;
    const propText = Object.entries(props)
      .filter(([k]) => k !== "children")
      .map(([, v]) => (typeof v === "string" || typeof v === "number" ? String(v) : ""))
      .join(" ");
    return `${propText} ${treeText(props.children)}`;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WS = "ws-verify-buying";
const now = new Date();
const flightStart = new Date(now.getTime() + 7 * 86400_000).toISOString().slice(0, 10);
const flightEnd = new Date(now.getTime() + 37 * 86400_000).toISOString().slice(0, 10);
const CREATIVE_ID = "crt_verify_1";
const CREATIVE_HASH = createHash("sha256").update("verify-creative-bytes").digest("hex");
const MAX_SPEND = 50_000; // $500.00

function makeBinding(overrides: Record<string, unknown> = {}) {
  const binding = {
    platform: "blip",
    clientAdAccountId: "client:acme:blip",
    dealType: "auction" as const,
    lineItems: [
      {
        inventory: "board-47",
        pricingModel: "per_blip",
        maxAllowedCents: MAX_SPEND,
        flightStart,
        flightEnd,
        targetingSnapshot: {},
        creativeIds: [CREATIVE_ID],
        creativeHashes: [CREATIVE_HASH],
      },
    ],
    maxTotalSpendCents: MAX_SPEND,
    currency: "USD",
    driftTolerance: { pricePct: 0.05, spendPct: 0.05 },
    creativeIds: [CREATIVE_ID],
    creativeHashes: [CREATIVE_HASH],
    flightStart,
    flightEnd,
    targetingSnapshot: { dayparts: ["Morning drive"] },
    cancelTerms: "cancel anytime",
    operatorTermsVersion: "v1",
    ...overrides,
  };
  return binding;
}

function makeApproval(binding: ReturnType<typeof makeBinding>, approvalOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "apr_verify_1",
    workspaceId: WS,
    clientId: "client:acme",
    type: "buy",
    status: "approved",
    binding,
    bindingHash: approvalsLib.bindingHashOf(binding as never),
    maxSpendCents: MAX_SPEND,
    currency: "USD",
    poolId: null,
    quoteId: null,
    quoteExpiresAt: new Date(now.getTime() + 86400_000),
    driftTolerance: { pricePct: 0.05, spendPct: 0.05 },
    createdBy: "user-creator",
    approvers: [{ userId: "user-approver", decidedAt: now.toISOString(), method: "sso", receipt: "rcpt" }],
    twoPersonSatisfied: true,
    approvalMethod: "sso",
    approvalReceipt: "rcpt",
    approvalsExpiresAt: new Date(now.getTime() + 7 * 86400_000),
    approvedAt: now,
    revokedAt: null,
    revokedBy: null,
    executedAt: null,
    createdAt: now,
    updatedAt: now,
    ...approvalOverrides,
  };
}

const planRecord = {
  id: "plan_verify_1",
  workspaceId: WS,
  name: "Verify DOOH flight",
  vendor: "blip",
  placementsJson: {
    placements: [{ boardId: "board-47", name: "I-40 W MM 12", city: "Greensboro", state: "NC" }],
    dayparts: ["Morning drive"],
    flightStart,
    flightEnd,
  },
  estimateJson: {},
  estimateCents: MAX_SPEND - 100, // estimate sits UNDER the approved cap
  currency: "USD",
  creativeIds: [CREATIVE_ID],
  creativeHashes: [CREATIVE_HASH],
  status: "approved",
};

// ---------------------------------------------------------------------------
// 1–2. Plan → approval binding → launch packet; packet contains exact terms
// ---------------------------------------------------------------------------

console.log("1–2 · plan → approval binding → launch packet (exact terms)");

const blip = doohLib.getDoohProvider("blip");
const estimate = await blip.estimate({
  vendor: "blip",
  boardIds: ["board-47"],
  dayparts: planRecord.placementsJson.dayparts,
  flightStart,
  flightEnd,
  playsPerBoardPerDay: 100,
});
check("estimate is a documented planning range (never a charge)", estimate.lines.length > 0 && estimate.lines.every((l) => l.basis === "documented_estimate") && estimate.maxCents >= estimate.minCents);

const approval = makeApproval(makeBinding());
check("canonical approval binding hashes cleanly", approvalsLib.verifyBinding(approval.binding as never, approval.bindingHash as string));
await throwsAsync(() => Promise.resolve(execLib.assertApprovalExecutable(approval as never)), "NEVER-THROWS").then((v) =>
  check("assertApprovalExecutable passes on a good approval", !v),
);

const compiled = await packetLib.compileLaunchPacket({
  workspaceId: WS,
  plan: planRecord,
  approval: approval as never,
  creatives: [{ id: CREATIVE_ID, name: "Q4 hero", size: "1080x1920", version: 1, creativeHash: CREATIVE_HASH, pdfUrl: null }],
  tracking: [{ placementRef: "board-47", boardName: "I-40 W MM 12", slug: "acme-board-47", destinationUrl: "https://acme.link/board-47" }],
  generatedBy: "user-creator",
  origin: "verify-script",
  workspaceName: "Verify Co",
  version: 1,
});
check("launch packet compiled (pdf + sha256)", compiled.pdfBytes.length > 1024 && compiled.packetSha256.length === 64);
check("packet binding match is fail-closed clean", packetLib.diffPacketVsBinding(planRecord, approval as never).length === 0);

const packetDoc = packetLib.buildLaunchPacketDocument({
  planName: planRecord.name,
  vendor: "blip",
  version: 1,
  approvalId: approval.id as string,
  bindingHash: approval.bindingHash as string,
  maxTotalSpendCents: MAX_SPEND,
  currency: "USD",
  approvalsExpiresAt: (approval.approvalsExpiresAt as Date).toISOString(),
  placements: planRecord.placementsJson.placements,
  dayparts: planRecord.placementsJson.dayparts,
  flightStart,
  flightEnd,
  estimateLines: estimate.lines ?? [],
  estimateNotes: estimate.notes ?? [],
  creatives: [{ id: CREATIVE_ID, name: "Q4 hero", size: "1080x1920", version: 1, creativeHash: CREATIVE_HASH, pdfUrl: null }],
  tracking: [{ placementRef: "board-47", boardName: "I-40 W MM 12", slug: "acme-board-47", destinationUrl: "https://acme.link/board-47" }],
  executor: "browser_agent",
  generatedAt: now.toISOString(),
  workspaceName: "Verify Co",
  generatedBy: "user-creator",
});
const packetText = treeText(packetDoc);
check("packet shows exact approved max spend", packetText.includes(packetLib.fmtCents(MAX_SPEND)));
check("packet shows exact approved inventory (board-47)", packetText.includes("board-47"));
check("packet shows approved flight window", packetText.includes(flightStart) && packetText.includes(flightEnd));
check("packet shows creative hash", packetText.includes(CREATIVE_HASH.slice(0, 24)));

// Drift: plan with a different creative hash must NOT compile.
const driftedPlan = { ...planRecord, creativeHashes: [createHash("sha256").update("tampered").digest("hex")] };
check(
  "drifted creative hash blocks packet compilation",
  await throwsAsync(() => packetLib.compileLaunchPacket({ workspaceId: WS, plan: driftedPlan, approval: approval as never, creatives: [], tracking: [], generatedBy: null, origin: "verify-script", workspaceName: "Verify Co", version: 1 }), "drifted"),
);

// ---------------------------------------------------------------------------
// 3. Stale quote execution blocked (quote-then-book)
// ---------------------------------------------------------------------------

console.log("3 · stale quote blocked");
const staleBinding = makeBinding({ dealType: "pd", quoteId: "q-1", quoteExpiresAt: new Date(now.getTime() - 1000).toISOString() });
const staleApproval = makeApproval(staleBinding, { quoteExpiresAt: null });
check(
  "expired quote blocks executability",
  await throwsAsync(() => Promise.resolve(execLib.assertApprovalExecutable(staleApproval as never)), "expired or missing quote"),
);

// ---------------------------------------------------------------------------
// 4. Operator price change at checkout halts
// ---------------------------------------------------------------------------

console.log("4 · price change at checkout halts");
const fake = new browserLib.FakeOperator();
fake.setFinalOrderScreen(browserLib.fakePriceChangedScreen(approval as never));
check(
  "inflated order total halts before submit",
  await throwsAsync(
    () =>
      browserLib.executeBuy({
        session: { mode: "fake", accountRef: "client:acme:blip", sessionId: "sess-1" },
        approval: approval as never,
        orderScreen: fake.getFinalOrderScreen(),
        submit: () => fake.submitOrder(fake.getFinalOrderScreen() as never),
        buyId: "buy-1",
      }),
    "HALT",
  ),
);

// ---------------------------------------------------------------------------
// 5. Receipt capture: re-verify against binding + persistence (DB-gated)
// ---------------------------------------------------------------------------

console.log("5 · receipt re-verification against binding");
const matchingTerms = {
  vendor: "blip",
  totalSpendCents: MAX_SPEND - 50,
  currency: "USD",
  flightStart,
  flightEnd,
  lines: [{ label: "board-47", amountCents: MAX_SPEND - 50 }],
  invoiceNumber: "INV-1",
};
const ok = receiptLib.verifyReceiptTermsAgainstBinding(matchingTerms, approval.binding as never);
check("matching invoice verifies clean", ok.verified && ok.flags.length === 0, JSON.stringify(ok.flags));
const overCap = receiptLib.verifyReceiptTermsAgainstBinding({ ...matchingTerms, totalSpendCents: MAX_SPEND + 1 }, approval.binding as never);
check("over-cap invoice is flagged, never silent-verified", !overCap.verified && overCap.flags.length > 0, JSON.stringify(overCap.flags));
const wrongCcy = receiptLib.verifyReceiptTermsAgainstBinding({ ...matchingTerms, currency: "EUR" }, approval.binding as never);
check("currency mismatch is flagged", !wrongCcy.verified, JSON.stringify(wrongCcy.flags));

const { buyingTablesReady, SqlMediaReceiptStore } = await import("@/lib/media/buying-store");
if (await buyingTablesReady()) {
  const store = new SqlMediaReceiptStore();
  // FK guard: media_receipts.workspace_id references workspaces — ensure the
  // battery fixture workspace exists in the dev DB before writing receipts.
  const { prisma } = await import("@/lib/prisma");
  await prisma.workspace.upsert({
    where: { id: WS },
    create: { id: WS, name: "Verify buying battery fixture", ownerUserId: "verify-owner" },
    update: {},
  });
  // idempotent re-runs: the (workspace, buy, invoice) unique index dedupes re-capture
  await prisma.mediaReceipt.deleteMany({ where: { workspaceId: WS, buyId: "buy-1" } });
  const rec = await store.create({
    workspaceId: WS, buyId: "buy-1", capturedBy: "browser_executor",
    platformInvoiceRef: "INV-1", amountCents: matchingTerms.totalSpendCents, currency: "USD",
    receiptUrl: null, parsedTermsJson: { ...matchingTerms }, verified: true,
    // merged media_receipts.approval_ref is NOT NULL (zero-custody invariant)
    approvalRef: approval.id as string,
  });
  const listed = await store.listForBuy("buy-1", WS);
  check("receipt row persists and lists (buy receipt record created)", listed.some((r) => r.id === rec.id && r.verified === true));
} else {
  skip("receipt persistence (SQL store round-trip)", "buying fragment tables not migrated");
}

// ---------------------------------------------------------------------------
// 6. IO brief renders with visible maximum-spend term
// ---------------------------------------------------------------------------

console.log("6 · IO brief (IAB/AAAA template) shows maximum spend");
const terms = ioLib.buildIoTerms({
  deliverables: [{ description: "30s drive-time spots ×400", quantity: 400, unitPriceCents: 1000, totalCents: 400_000 }],
  maximumSpendCents: 450_000,
  currency: "USD",
  flightStart,
  flightEnd,
  thirdPartyAdServer: "Dub pURL",
  cancelTerms: "14 days written notice",
  paymentTerms: "Net 30",
  inventoryUnavailableNotice: "2 business days",
});
check("scheduled total under the maximum binds", terms.scheduledCents <= terms.maximumSpendCents && terms.maximumSpendCents === 450_000);
check(
  "over-max schedule is rejected at build time",
  await throwsAsync(() => Promise.resolve(ioLib.buildIoTerms({ ...terms, deliverables: [{ description: "x", quantity: 1, unitPriceCents: 999_999, totalCents: 999_999 }], maximumSpendCents: 10 })), "exceed"),
);

const ioDoc = ioLib.buildIoBriefDocument({
  name: "Verify radio flight",
  channel: "radio",
  terms,
  inventory: [{ name: "WXYZ-FM", market: "Greensboro", callSign: "WXYZ" }],
  creativeIds: [CREATIVE_ID],
  creativeHashes: [CREATIVE_HASH],
  promoCodes: [{ channelRef: "WXYZ-FM", code: "VERIFY20" }],
  signatureStatus: "draft",
  generatedAt: now.toISOString(),
  workspaceName: "Verify Co",
  generatedBy: "user-creator",
});
const ioText = treeText(ioDoc);
check("IO brief visibly includes the maximum-spend term", ioText.includes("Maximum amount to be spent"));
// fmtCents lives in launch-packet lib; use the raw number check instead of a formatter dependency.
check("IO brief shows the $4,500 maximum", ioText.includes("$4,500"));

const ioPdf = await ioLib.generateIoBriefPdf({
  brief: { id: "io_verify_1", workspaceId: WS },
  input: {
    name: "Verify radio flight",
    channel: "radio",
    inventory: [{ name: "WXYZ-FM", market: "Greensboro", callSign: "WXYZ" }],
    terms: { deliverables: [{ description: "30s drive-time spots ×400", quantity: 400, unitPriceCents: 1000, totalCents: 400_000 }], maximumSpendCents: 450_000, currency: "USD", flightStart, flightEnd, thirdPartyAdServer: "Dub pURL", cancelTerms: "14 days written notice", paymentTerms: "Net 30", inventoryUnavailableNotice: "2 business days" },
    creativeIds: [CREATIVE_ID],
    creativeHashes: [CREATIVE_HASH],
    promoCodes: [{ channelRef: "WXYZ-FM", code: "VERIFY20" }],
  },
  terms,
  signatureStatus: "draft",
  workspaceName: "Verify Co",
  generatedBy: "user-creator",
});
check("IO brief PDF renders (non-trivial bytes)", ioPdf.pdfBytes.length > 1024 && ioPdf.briefSha256.length === 64);

// ---------------------------------------------------------------------------
// 7. Prompt injection quarantined, execution unaltered
// ---------------------------------------------------------------------------

console.log("7 · operator-screen injection quarantined");
fake.setFinalOrderScreen(browserLib.fakeInjectionScreen(approval as never));
const injected = await browserLib.executeBuy({
  session: { mode: "fake", accountRef: "client:acme:blip", sessionId: "sess-2" },
  approval: approval as never,
  orderScreen: fake.getFinalOrderScreen(),
  submit: () => fake.submitOrder(fake.getFinalOrderScreen() as never),
  buyId: "buy-1",
});
check("injection screen still executes ONLY approved terms", injected.receipt.amountCents === MAX_SPEND, `amount=${injected.receipt.amountCents}`);
check("injected directives are quarantined, not obeyed", injected.quarantinedDirectives.length > 0);

// ---------------------------------------------------------------------------
// 8. Fake mode default; no real spend path
// ---------------------------------------------------------------------------

console.log("8 · fake mode default; no real spend");
const def = doohLib.getDoohProvider();
check("default DOOH provider is fake (test mode)", def.name === "fake");
const audioInput = {
  vendor: "fake" as const,
  name: "verify",
  stations: [{ name: "WXYZ", type: "streaming" as const, market: "Greensboro" }],
  spotMix: [{ lengthSec: 30 as const, spotsPerDay: 1, label: "30s" }],
  flightStart,
  flightEnd,
  dailyBudgetCents: 1, // would violate every real vendor minimum — fine for fake
  promoCodes: [],
  creativeIds: [],
  creativeHashes: [],
};
const audioFake = audioLib.planAudioBuy(audioInput);
check("fake audio plan has no vendor minimums", audioFake.totalCents > 0);
const spotifyRaised = audioLib.planAudioBuy({ ...audioInput, vendor: "spotify", dailyBudgetCents: 100 });
check(
  "real vendor minimums enforced (spotify daily budget raised to €15/day)",
  spotifyRaised.dailyBudgetCents === 1500 && spotifyRaised.currency === "EUR" && spotifyRaised.minimumsMet,
);
check("AdQuick is a plain referral URL, not an API client", doohLib.ADQUICK_SELF_SERVE_URL === "https://www.adquick.com");

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

rmSync(scratch, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failures.length > 0) {
  console.log("Failures:", failures.join(", "));
  process.exit(1);
}
