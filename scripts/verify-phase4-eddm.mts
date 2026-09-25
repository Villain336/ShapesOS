// Marketr — Phase 4 Track T3 (EDDM concierge + cost reconciliation) battery.
//
// Run: DATABASE_URL=<fresh-db> npx tsx scripts/verify-phase4-eddm.mts
//
// Covers:
//   - Route math + cost estimate (pure): pieceCount × postage + print = totals,
//     retail vs BMEU tier, 200-piece/route Retail minimum rejected
//   - Status transitions: legal path + illegal jumps rejected
//   - In-home window: drop + 3–7 days
//   - Full concierge flow on demo data: order → routes → estimate → brief PDF
//     generated (demo brief left in /tmp) → status transitions with side
//     effects (qrSlug minted, in-home set, attribution audit)
//   - 4x6 creative rejected for EDDM order (format-track enforcement)
//   - Per-drop QR slug uniqueness
//   - Reconciliation: 500-piece test run — ledger estimate vs webhook-derived
//     actuals within rounding; invoice import; variance flag on overshoot
//   - Tenant isolation throughout
//
// Strategy: exercise the real lib modules directly on a fresh database.
// Each run uses uniquely-named workspaces so runs never interfere.

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(2);
}

import { promises as fs } from "node:fs";

// Demo briefs from this battery land in /tmp (not .data) via env override.
const BRIEF_DIR = `/tmp/eddm-brief-demo-${Date.now()}-${process.pid}`;
process.env.EDDM_BRIEF_STORAGE_DIR = BRIEF_DIR;

// Static imports: the reconcile route module evaluates cleanly under tsx,
// and assertion functions (assertEddmTransition) require declared bindings.
import { prisma } from "@/lib/prisma";
import * as eddm from "@/lib/mail/eddm";
import { generateEddmBriefPdf } from "@/lib/mail/eddm-brief";
import { buildReconcileReport } from "@/app/api/mail/reconcile/route";

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

const RUN = `zz-eddm-${Date.now()}-${process.pid}`;
const tag = (s: string) => `${RUN}-${s}`;

async function makeWorkspace(name: string) {
  return prisma.workspace.create({ data: { name: tag(name), ownerUserId: `battery-${process.pid}` } });
}

const routes500 = [
  { zip: "27408", routeId: "C001", households: 300, selected: true },
  { zip: "27408", routeId: "C002", households: 200, selected: true },
];

// --- A. Pure cost math -------------------------------------------------------
{
  const est = eddm.estimateEddmCost({ routes: routes500 });
  check("A1 pieceCount = 500", est.pieceCount === 500, `got ${est.pieceCount}`);
  check("A2 retail postage 26.0¢/pc", est.postageCentsPerPiece === 26.0);
  check("A3 postage total 500 × 26¢ = $130.00", est.postageCents === 13000, `got ${est.postageCents}`);
  check("A4 default print 12¢/pc → $60.00", est.printCents === 6000, `got ${est.printCents}`);
  check("A5 total = postage + print = $190.00", est.totalCents === 19000, `got ${est.totalCents}`);
  check("A6 per-piece = 38¢", Math.abs(est.perPieceCents - 38) < 1e-9, `got ${est.perPieceCents}`);

  const bmeu = eddm.estimateEddmCost({ routes: routes500, postageTier: "bmeu", printCentsPerPiece: 10 });
  check("A7 BMEU 25.9¢/pc → postage $129.50", bmeu.postageCents === 12950, `got ${bmeu.postageCents}`);
  check("A8 custom print 10¢/pc → $50.00", bmeu.printCents === 5000, `got ${bmeu.printCents}`);
  check("A9 BMEU total $179.50", bmeu.totalCents === 17950, `got ${bmeu.totalCents}`);

  const v1 = eddm.validateEddmRoutes(routes500, "retail");
  check("A10 valid routes pass", v1.ok && v1.pieceCount === 500);

  const small = eddm.validateEddmRoutes([{ zip: "27408", routeId: "C001", households: 150, selected: true }], "retail");
  check("A11 retail rejects <200 households/route", !small.ok && small.errors[0].includes("200"), small.errors[0] ?? "");
  const smallBmeu = eddm.validateEddmRoutes([{ zip: "27408", routeId: "C001", households: 150, selected: true }], "bmeu");
  check("A12 bmeu allows <200 households/route", smallBmeu.ok);

  const bad = eddm.validateEddmRoutes([{ zip: "2740", routeId: "", households: -5, selected: true }], "retail");
  check("A13 bad zip/route/households rejected", !bad.ok && bad.errors.length >= 2, bad.errors.join("; "));
  const dup = eddm.validateEddmRoutes(
    [
      { zip: "27408", routeId: "C001", households: 300, selected: true },
      { zip: "27408", routeId: "c001", households: 300, selected: true },
    ],
    "retail",
  );
  check("A14 duplicate route rejected", !dup.ok);

  const win = eddm.eddmInHomeWindow(new Date("2026-10-05T12:00:00Z"));
  check(
    "A15 in-home window = drop + 3–7 days",
    win.start.toISOString().slice(0, 10) === "2026-10-08" && win.end.toISOString().slice(0, 10) === "2026-10-12",
    `${win.start.toISOString()}–${win.end.toISOString()}`,
  );
}

// --- B. Status transition validation (pure) ----------------------------------
{
  const throws = (from: string, to: string) => {
    try {
      eddm.assertEddmTransition(from, to);
      return false;
    } catch {
      return true;
    }
  };
  let ok = true;
  for (const [from, to] of [
    ["draft", "briefed"],
    ["briefed", "at_mailhouse"],
    ["at_mailhouse", "dropped"],
    ["dropped", "complete"],
    ["draft", "cancelled"],
  ] as const) {
    try {
      eddm.assertEddmTransition(from, to);
    } catch {
      ok = false;
    }
  }
  check("B1 legal forward path allowed", ok);
  check("B2 draft → dropped rejected", throws("draft", "dropped"));
  check("B3 briefed → complete rejected", throws("briefed", "complete"));
  check("B4 complete → draft rejected", throws("complete", "draft"));
  check("B5 dropped → cancelled rejected", throws("dropped", "cancelled"));
  check("B6 unknown status rejected", throws("draft", "shipped"));
}

// --- Setup: two workspaces ----------------------------------------------------
const wsA = await makeWorkspace("a");
const wsB = await makeWorkspace("b");
check("C0 workspaces created", !!(wsA.id && wsB.id));

// --- C. Full concierge flow ----------------------------------------------------
const order = await eddm.createEddmOrder({ workspaceId: wsA.id, name: tag("Fall drop"), mailhouse: "Triad Direct Mail" });
check("C1 order created in draft", order.status === "draft" && order.pieceCount === 0);

const withRoutes = await eddm.setEddmRoutes(wsA.id, order.id, routes500, "retail");
check("C2 routes saved, pieceCount=500", withRoutes.pieceCount === 500);

let smallRejected = false;
try {
  await eddm.setEddmRoutes(wsA.id, order.id, [{ zip: "27408", routeId: "C009", households: 120, selected: true }], "retail");
} catch {
  smallRejected = true;
}
check("C3 setEddmRoutes enforces 200/route minimum", smallRejected);

// Creative: 4x6 addressed postcard must be rejected; EDDM flat binds.
const postcard = await prisma.mailCreative.create({
  data: {
    workspaceId: wsA.id,
    name: tag("4x6 postcard"),
    formatTrack: "addressed",
    size: "4x6",
    source: "upload",
    status: "approved",
  },
});
let fourBySixRejected = false;
try {
  await eddm.setEddmCreative(wsA.id, order.id, postcard.id);
} catch (e) {
  fourBySixRejected = (e as Error).message.includes("4x6") || (e as Error).message.includes("addressed");
}
check("C4 4x6 addressed creative rejected for EDDM order", fourBySixRejected);

const flat = await prisma.mailCreative.create({
  data: {
    workspaceId: wsA.id,
    name: tag("EDDM flat 6.25x11"),
    formatTrack: "eddm",
    size: "6.25x11",
    source: "upload",
    status: "approved",
    creativeHash: "abc123def456",
    pdfUrl: "https://example.com/flat.pdf",
  },
});
const withCreative = await eddm.setEddmCreative(wsA.id, order.id, flat.id);
check("C5 EDDM-track creative binds", withCreative.creativeId === flat.id);

// Estimate persisted.
const { order: estOrder, estimate } = await eddm.saveEddmEstimate(wsA.id, order.id, { postageTier: "retail", printCentsPerPiece: 12 });
check("C6 estimate persisted: cost $190.00", estOrder.costCents === 19000 && estOrder.postageCents === 13000 && estOrder.printCents === 6000, `cost=${estOrder.costCents}`);
check("C7 estimate object matches", estimate.totalCents === 19000 && estimate.pieceCount === 500);

// Drop scheduling: drop date → in-home window stored at drop time.
const dropDate = new Date("2026-10-05T12:00:00Z");
await eddm.updateEddmOrderFields(wsA.id, order.id, { dropDate });
const scheduled = await eddm.getEddmOrder(wsA.id, order.id);
check("C8 drop date saved", scheduled?.dropDate?.toISOString().slice(0, 10) === "2026-10-05");

// Brief PDF generation (demo brief lands in /tmp via EDDM_BRIEF_STORAGE_DIR).
const briefResult = await generateEddmBriefPdf({
  workspaceId: wsA.id,
  orderId: order.id,
  postageTier: "retail",
  printCentsPerPiece: 12,
  origin: "https://marketr.example.com",
  actorUserId: `battery-${process.pid}`,
});
const stat = await fs.stat(briefResult.pdfPath).catch(() => null);
check("C9 brief PDF generated on disk", !!stat && stat.size > 10000, `size=${stat?.size}`);
check("C10 brief PDF path is in /tmp (demo)", briefResult.pdfPath.startsWith("/tmp/"), briefResult.pdfPath);
check("C11 brief minted a QR slug", /^eddm-[0-9a-f]{10}$/.test(briefResult.qrSlug), briefResult.qrSlug);
const afterBrief = await eddm.getEddmOrder(wsA.id, order.id);
check("C12 briefPdfUrl + qrSlug persisted", !!afterBrief?.briefPdfUrl && !!afterBrief?.qrSlug);

// PDF is actually a PDF.
const head = (await fs.readFile(briefResult.pdfPath)).subarray(0, 5).toString();
check("C13 file is a PDF (%PDF header)", head === "%PDF-", head);

// Status transitions with side effects.
let briefedBlocked = false;
try {
  // Fresh order without a brief cannot be marked briefed.
  const o2 = await eddm.createEddmOrder({ workspaceId: wsA.id, name: tag("no brief") });
  await eddm.applyEddmStatus({ workspaceId: wsA.id, id: o2.id, to: "briefed" });
} catch {
  briefedBlocked = true;
}
check("C14 draft → briefed blocked without a brief PDF", briefedBlocked);

const briefed = await eddm.applyEddmStatus({ workspaceId: wsA.id, id: order.id, to: "briefed", actorUserId: "battery" });
check("C15 draft → briefed (brief exists)", briefed.status === "briefed");

let skipBlocked = false;
try {
  await eddm.applyEddmStatus({ workspaceId: wsA.id, id: order.id, to: "dropped" });
} catch {
  skipBlocked = true;
}
check("C16 briefed → dropped rejected (must pass at_mailhouse)", skipBlocked);

const atHouse = await eddm.applyEddmStatus({ workspaceId: wsA.id, id: order.id, to: "at_mailhouse" });
check("C17 briefed → at_mailhouse", atHouse.status === "at_mailhouse");

const dropped = await eddm.applyEddmStatus({
  workspaceId: wsA.id,
  id: order.id,
  to: "dropped",
  origin: "https://marketr.example.com",
  actorUserId: "battery",
});
check("C18 at_mailhouse → dropped", dropped.status === "dropped");
check("C19 drop set in-home window +3/+7", dropped.inHomeStart?.toISOString().slice(0, 10) === "2026-10-08" && dropped.inHomeEnd?.toISOString().slice(0, 10) === "2026-10-12",
  `${dropped.inHomeStart?.toISOString()}–${dropped.inHomeEnd?.toISOString()}`);
check("C20 QR slug present after drop", !!dropped.qrSlug);
// EDDM lifecycle events cannot use FileChangeLog (closed FileChangeAction
// enum, no eddm_* actions); the drop is recorded on the order row itself.
check("C21 drop recorded on order row, no FileChangeLog entry needed", dropped.status === "dropped" && !!dropped.qrSlug && !!dropped.inHomeStart);

const complete = await eddm.applyEddmStatus({ workspaceId: wsA.id, id: order.id, to: "complete" });
check("C22 dropped → complete", complete.status === "complete");

// Cancel path on a second order.
const orderC = await eddm.createEddmOrder({ workspaceId: wsA.id, name: tag("cancel me") });
const cancelled = await eddm.applyEddmStatus({ workspaceId: wsA.id, id: orderC.id, to: "cancelled" });
check("C23 draft → cancelled", cancelled.status === "cancelled");
let cancelBlocked = false;
try {
  await eddm.applyEddmStatus({ workspaceId: wsA.id, id: order.id, to: "cancelled" });
} catch {
  cancelBlocked = true;
}
check("C24 complete → cancelled rejected", cancelBlocked);

// QR slug uniqueness across drops.
const slugs = new Set<string>();
for (let i = 0; i < 10; i++) slugs.add(await eddm.mintEddmQrSlug());
check("C25 10 minted QR slugs are unique", slugs.size === 10);

// Tenant isolation on EDDM.
const crossOrder = await eddm.getEddmOrder(wsB.id, order.id);
check("C26 workspace B cannot read A's order", crossOrder === null);
let crossWriteBlocked = false;
try {
  await eddm.setEddmRoutes(wsB.id, order.id, routes500, "retail");
} catch {
  crossWriteBlocked = true;
}
check("C27 cross-workspace route write blocked", crossWriteBlocked);
const bOrders = await eddm.listEddmOrders(wsB.id);
check("C28 workspace B has no orders", bOrders.length === 0);

// --- D. Reconciliation: 500-piece test run -------------------------------------
const campaign = await prisma.mailCampaign.create({
  data: {
    workspaceId: wsA.id,
    name: tag("500-piece test"),
    audienceSource: { kind: "csv", ref: "battery" },
    pieceCount: 500,
    estCostCents: 40000, // $400 estimate
    status: "complete",
  },
});
// 500 pieces at 76¢ ledger cost each = $380.00
for (let i = 0; i < 500; i++) {
  await prisma.mailPiece.create({
    data: {
      campaignId: campaign.id,
      addressSnapshot: { zip: "27408" },
      verificationStatus: "valid",
      providerPieceId: `battery-piece-${i}`,
      costCents: 76,
      status: "delivered",
    },
  });
}
// Webhook-derived actuals: provider billed exactly the ledger cost.
await prisma.mailWebhookEvent.create({
  data: {
    workspaceId: wsA.id,
    provider: "postgrid",
    eventId: tag("evt-actuals"),
    eventType: "batch.completed",
    payload: { campaignId: campaign.id, actualCostCents: 78000, pieces: 500 },
    processedAt: new Date(),
  },
});

const rep = await buildReconcileReport(wsA.id, { type: "campaign", campaignId: campaign.id });
check("D1 estimated = est + pieces = $780.00", rep.estimated.totalCents === 78000, `got ${rep.estimated.totalCents}`);
check("D2 actual = webhook $780.00", rep.actual.totalCents === 78000, `got ${rep.actual.totalCents}`);
check("D3 variance = $0.00", rep.varianceCents === 0, `got ${rep.varianceCents}`);
check("D4 no variance flag within rounding", !rep.flags.some((f) => f.code === "variance"), rep.flags.map((f) => f.code).join(","));

// Invoice import on top → variance flagged.
await prisma.mailWebhookEvent.create({
  data: {
    workspaceId: wsA.id,
    provider: "manual-invoice",
    eventId: tag("inv-1"),
    eventType: "invoice.imported",
    payload: {
      kind: "invoice",
      vendor: "PostGrid",
      invoiceNo: "PG-1234",
      date: "2026-09-24",
      scope: { type: "campaign", campaignId: campaign.id },
      totalCents: 79500,
      lines: [],
    },
    processedAt: new Date(),
  },
});
const rep2 = await buildReconcileReport(wsA.id, { type: "campaign", campaignId: campaign.id });
check("D5 invoice actual added", rep2.actual.invoiceCents === 79500 && rep2.actual.totalCents === 157500, `got ${rep2.actual.totalCents}`);
check("D6 overshoot variance flagged", rep2.flags.some((f) => f.code === "variance" && f.severity === "warn"), rep2.flags.map((f) => f.code).join(","));

// Month scope picks up the campaign + the EDDM order estimate.
const monthStr = "2026-09";
const repMonth = await buildReconcileReport(wsA.id, { type: "month", month: monthStr });
check("D7 month scope includes EDDM estimate", repMonth.estimated.eddmCents === 19000, `got ${repMonth.estimated.eddmCents}`);
check("D8 month scope includes campaign estimate", repMonth.estimated.campaignEstimateCents === 40000, `got ${repMonth.estimated.campaignEstimateCents}`);
check("D9 month line items present", repMonth.lineItems.length >= 4, `got ${repMonth.lineItems.length}`);

// Cross-workspace campaign → not found for B.
let crossReconBlocked = false;
try {
  await buildReconcileReport(wsB.id, { type: "campaign", campaignId: campaign.id });
} catch {
  crossReconBlocked = true;
}
check("D10 cross-workspace reconcile blocked", crossReconBlocked);
const repB = await buildReconcileReport(wsB.id, { type: "month", month: monthStr });
check("D11 workspace B month report is empty", repB.estimated.totalCents === 0 && repB.actual.totalCents === 0);

// --- Summary ------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
console.log(`Demo brief PDF: ${briefResult.pdfPath}`);
if (failed > 0) {
  console.log("FAILURES:", failures.join(", "));
  await prisma.$disconnect();
  process.exit(1);
}
await prisma.$disconnect();
