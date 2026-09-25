// Marketr — Phase 4 T1 mail engine battery (Direct Mail).
//
// Run: DATABASE_URL=<redacted> npx tsx scripts/verify-phase4-mail.mts
// Run 3x green before calling this done.
//
// Covers:
//   A. Fake provider (pure, no DB): deterministic verify fixtures,
//      estimates, render-only send, cancel, webhook sign/verify roundtrip,
//      Lob HMAC + PostGrid JWT signature roundtrips.
//   B. Service on a fresh DB, uniquely-named workspaces (runs never
//      interfere), exercising the REAL lib modules:
//      - build → verify (quarantine bad ZIP) → estimate → approval binding
//        (hash + count + max spend) → decide → execute
//      - consent at execute time: opted_out → suppressed(opt_out),
//        unknown → suppressed(no_consent), opted_in → sent
//      - refusal paths: creative-hash mismatch, over-count, over-spend,
//        no approval at all, no approval → no send
//      - re-execute after complete → throws (no double send)
//      - webhook duplicate + out-of-order → one attribution touch, no
//        status downgrade; bad signature → rejected
//      - tenant isolation (service guards are workspace-scoped)
//   C. Metered actions mail_piece / mail_verification are registered.
//
// Money posture asserted throughout: with no provider row the engine
// renders via the fake provider; NOTHING in this battery can spend real
// postage.

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

const { prisma } = await import("@/lib/prisma");
const fake = await import("@/lib/mail/fake");
const svc = await import("@/lib/mail/service");
const webhooks = await import("@/lib/mail/webhooks");
const consent = await import("@/lib/messaging/consent");
const { isMeteredAction } = await import("@/lib/metering/credits");
const stages = await import("@/lib/crm/stages");

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

const RUN = `zz-mail-${Date.now()}-${process.pid}`;
const tag = (s: string) => `${RUN}-${s}`;

// ── A. Fake provider (pure) ─────────────────────────────────────────────────
{
  console.log("A. FakeMailProvider (pure)");
  const p = new fake.FakeMailProvider();
  check("A1 name", p.name === "fake");

  const good = await p.verifyAddress({
    name: "Ada", line1: "123 Main St", city: "Greensboro", state: "NC", zip: "27401",
  });
  check("A2 valid address → valid", good.status === "valid", JSON.stringify(good));

  const badZip = await p.verifyAddress({
    name: "Bob", line1: "9 Elm St", city: "Raleigh", state: "NC", zip: "ABC",
  });
  check("A3 bad ZIP → quarantined", badZip.status === "quarantined", JSON.stringify(badZip));

  const undeliv = await p.verifyAddress({
    name: "Cy", line1: "1 undeliverable way", city: "Durham", state: "NC", zip: "27701",
  });
  check("A4 undeliverable → quarantined", undeliv.status === "quarantined");

  const ncoa = await p.verifyAddress({
    name: "Dee", line1: "5 ncoa lane", city: "Cary", state: "NC", zip: "27511",
  });
  check("A5 ncoa fixture → corrected + forwarding address",
    ncoa.status === "corrected" && !!ncoa.correctedAddress && ncoa.deliverability === "ncoa_changed",
    JSON.stringify(ncoa));

  const estPc = await p.estimateCost({ format: "postcard_4x6", count: 100, verifications: 0 });
  const estPcTotal = estPc.reduce((s, l) => s + l.cents, 0);
  check("A6 postcard estimate 85c/pc", estPcTotal === 85 * 100, `got ${estPcTotal}`);

  const estLt = await p.estimateCost({ format: "letter", count: 1, verifications: 0 });
  const estLtTotal = estLt.reduce((s, l) => s + l.cents, 0);
  check("A7 letter estimate 94c", estLtTotal === 94, `got ${estLtTotal}`);

  const estVer = await p.estimateCost({ format: "postcard_4x6", count: 10, verifications: 5 });
  check("A8 verification lookups surfaced as a line item",
    estVer.length === 2 && estVer[1].quantity === 5 && estVer[1].cents === 0);

  const send = await p.sendPiece(
    {
      address: { name: "Ada", line1: "123 Main St", city: "Greensboro", state: "NC", zip: "27401" },
      qrSlug: "qr-1",
      idempotencyKey: "k1",
      mergeVariables: { name: "Ada" },
    },
    { testMode: true },
  );
  check("A9 render-only send", send.renderedOnly === true && send.providerPieceId.startsWith("fake_"),
    JSON.stringify(send));

  await p.cancelPiece("fake_anything");
  check("A10 cancel resolves (no-op)", true);

  const body = JSON.stringify({ events: fake.simulateTrackingSequence("fake_piece_1", "a") });
  const sig = fake.signFakeMailWebhook(body);
  check("A11 webhook sign/verify", p.validateWebhookSignature({ rawBody: body, signature: sig }));
  check("A12 webhook bad sig rejected", !p.validateWebhookSignature({ rawBody: body, signature: "deadbeef" }));

  // Lob HMAC roundtrip (documented scheme; unverified against a live firing).
  const lob = await import("@/lib/mail/lob");
  const lobProv = new lob.LobProvider("test_placeholder", { webhookSecret: "whsec-test" });
  const lobTs = String(Math.floor(Date.now() / 1000));
  const lobSig = lob.signLobWebhook(body, lobTs, "whsec-test");
  check("A13 lob webhook sign/verify",
    lobProv.validateWebhookSignature({ rawBody: body, signature: lobSig, timestamp: lobTs }));
  const lobProvWrong = new lob.LobProvider("test_placeholder", { webhookSecret: "whsec-other" });
  check("A14 lob webhook wrong secret rejected",
    !lobProvWrong.validateWebhookSignature({ rawBody: body, signature: lobSig, timestamp: lobTs }));

  // PostGrid JWT roundtrip.
  const pg = await import("@/lib/mail/postgrid");
  const nowSec = Math.floor(Date.now() / 1000);
  const jwt = pg.signPostGridWebhookJwt(
    { id: "evt-x", type: "postcard.delivered", iat: nowSec, exp: nowSec + 300 },
    "whsec-pg",
  );
  const pgProv = new pg.PostGridProvider("test_placeholder", { webhookSecret: "whsec-pg" });
  check("A15 postgrid JWT verify (Bearer header)",
    pgProv.validateWebhookSignature({ rawBody: "{}", signature: `Bearer ${jwt}` }));
  check("A16 postgrid JWT verify (body token)",
    pgProv.validateWebhookSignature({ rawBody: "{}", signature: null, tokenFromBody: jwt }));
  check("A17 postgrid JWT tampered rejected",
    !pgProv.validateWebhookSignature({ rawBody: "{}", signature: `Bearer ${jwt}tampered` }));
  check("A18 postgrid JWT expired rejected", (() => {
    const old = pg.signPostGridWebhookJwt(
      { id: "evt-old", iat: nowSec - 900, exp: nowSec - 600 }, "whsec-pg");
    return !pgProv.validateWebhookSignature({ rawBody: "{}", signature: `Bearer ${old}` });
  })());
}

// ── B. Service (DB) ─────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.log(`\n${passed} passed, ${failed} failed (DB sections skipped: no DATABASE_URL)`);
  process.exit(failed > 0 ? 1 : 2);
}
console.log("B. Mail service (DB)");

async function makeWorkspace(name: string) {
  return prisma.workspace.create({ data: { name: tag(name), ownerUserId: `battery-${process.pid}` } });
}
async function makePipeline(workspaceId: string) {
  return prisma.pipeline.create({
    data: { workspaceId, name: tag("pipe"), stages: stages.DEFAULT_STAGES as never, isDefault: true },
  });
}

const ws = await makeWorkspace("mail-ws");
const ws2 = await makeWorkspace("mail-ws-other");
const pipe = await makePipeline(ws.id);

async function makeLead(name: string, zip: string) {
  return prisma.lead.create({
    data: {
      workspaceId: ws.id,
      pipelineId: pipe.id,
      name: tag(name),
      customFields: {
        address: { line1: `${tag(name)} St`, city: "Greensboro", state: "NC", zip },
      } as unknown as Prisma.InputJsonValue,
    },
  });
}

const leadIn = await makeLead("in", "27401");
const leadOut = await makeLead("out", "27402");
const leadUnknown = await makeLead("unknown", "27403");
await consent.setConsent(ws.id, leadIn.id, "mail", "opted_in", "battery");
await consent.setConsent(ws.id, leadOut.id, "mail", "opted_out", "battery");

const pdfBytes = Buffer.from(`%PDF-1.4 battery creative ${RUN}`);
const creativeHash = svc.creativeHashFor(pdfBytes);
const creative = await prisma.mailCreative.create({
  data: {
    workspaceId: ws.id,
    name: tag("creative"),
    formatTrack: "addressed",
    size: "4x6",
    source: "upload",
    creativeHash,
    status: "ready",
  },
});
check("B0 creative hash bound", creative.creativeHash === creativeHash);

const campaign = await prisma.mailCampaign.create({
  data: {
    workspaceId: ws.id,
    name: tag("campaign"),
    creativeId: creative.id,
    audienceSource: { kind: "unset" } as unknown as Prisma.InputJsonValue,
    createdBy: "battery",
  },
});

// Build: 4 candidates (In/Out/Unknown/BadZip), 1 skipped (blank row).
const build = await svc.buildPieces(ws.id, campaign.id, {
  kind: "csv",
  rows: [
    { name: "In", line1: "1 Main St", city: "Greensboro", state: "NC", zip: "27401", leadId: leadIn.id },
    { name: "Out", line1: "2 Main St", city: "Greensboro", state: "NC", zip: "27402", leadId: leadOut.id },
    { name: "Unknown", line1: "3 Main St", city: "Greensboro", state: "NC", zip: "27403", leadId: leadUnknown.id },
    { name: "BadZip", line1: "4 Main St", city: "Greensboro", state: "NC", zip: "ABC" },
    { name: "NoAddr", line1: "", city: "", state: "", zip: "" },
  ],
});
check("B1 build: created=4 skippedNoAddress=1 total=5",
  build.created === 4 && build.skippedNoAddress === 1 && build.total === 5, JSON.stringify(build));

const pieces = await prisma.mailPiece.findMany({ where: { campaignId: campaign.id }, orderBy: { createdAt: "asc" } });
check("B2 all pieces queued pre-verify", pieces.length === 4 && pieces.every((p) => p.status === "queued"));
check("B3 QR slugs minted + unique",
  pieces.every((p) => typeof p.qrSlug === "string" && p.qrSlug.length > 0) &&
  new Set(pieces.map((p) => p.qrSlug)).size === 4);

// Consent is enforced at execute time (opt-outs suppress queued pieces,
// same as SMS/email). Verify quarantines the bad ZIP first.
const verify = await svc.verifyAddresses(ws.id, campaign.id);
check("B4 verify: 3 valid + 1 quarantined",
  verify.valid === 3 && verify.quarantined === 1, JSON.stringify(verify));

const badZipPiece = pieces.find((p) => (p.addressSnapshot as { zip?: string }).zip === "ABC")!;
const afterVerify = await prisma.mailPiece.findUnique({ where: { id: badZipPiece.id } });
check("B5 bad-ZIP piece quarantined (never mailed)",
  afterVerify?.verificationStatus === "quarantined");

const est = await svc.estimateCampaign(ws.id, campaign.id);
check("B6 estimate: 3 sendable pieces", est.sendablePieces === 3 && est.pendingVerifications === 0,
  JSON.stringify({ sendablePieces: est.sendablePieces, pendingVerifications: est.pendingVerifications }));
check("B7 estimate math: 85c x 3 = 255c subtotal, margin preview, 510c total",
  est.subtotalCents === 255 && est.marginPreviewCents === 255 && est.totalWithMarginCents === 510,
  JSON.stringify({ subtotalCents: est.subtotalCents, marginPreviewCents: est.marginPreviewCents, totalWithMarginCents: est.totalWithMarginCents }));
check("B8 estimate line items carry provider basis",
  est.lineItems.length >= 1 && est.lineItems.every((l) => l.basis === "documented_estimate"));

const { approval } = await svc.requestApproval(ws.id, campaign.id, { requestedBy: "battery" });
check("B9 approval binds hash + count + max spend",
  approval.creativeHash === creativeHash && approval.pieceCount === 3 && approval.maxSpendCents === 510,
  JSON.stringify({ hash: approval.creativeHash === creativeHash, count: approval.pieceCount, max: approval.maxSpendCents }));
check("B10 campaign → pending_approval",
  (await prisma.mailCampaign.findUnique({ where: { id: campaign.id } }))?.status === "pending_approval");

const decided = await svc.decideApproval(ws.id, approval.id, "approve", "battery-admin");
check("B11 approve → approved", decided.status === "approved");
check("B12 campaign → approved",
  (await prisma.mailCampaign.findUnique({ where: { id: campaign.id } }))?.status === "approved");

// ── Refusal paths (each on its own campaign) ────────────────────────────────
async function refusalCampaign(rows: Array<{ name: string; zip: string }>) {
  const c = await prisma.mailCampaign.create({
    data: {
      workspaceId: ws.id,
      name: tag("refusal"),
      creativeId: creative.id,
      audienceSource: { kind: "unset" } as unknown as Prisma.InputJsonValue,
      createdBy: "battery",
    },
  });
  await svc.buildPieces(ws.id, c.id, {
    kind: "csv",
    rows: rows.map((r) => ({
      name: r.name, line1: "1 Main St", city: "Greensboro", state: "NC", zip: r.zip, leadId: leadIn.id,
    })),
  });
  await svc.verifyAddresses(ws.id, c.id);
  await prisma.mailCampaign.update({ where: { id: c.id }, data: { status: "approved" } });
  return c;
}
async function manualApproval(campId: string, overrides: Record<string, unknown>) {
  return prisma.mailApproval.create({
    data: {
      campaignId: campId,
      creativeHash,
      pieceCount: 99,
      maxSpendCents: 999999,
      status: "approved",
      approverId: "battery",
      decidedAt: new Date(),
      ...overrides,
    },
  });
}
async function expectRefusal(label: string, fn: () => Promise<unknown>, needle: string) {
  let err = "";
  try { await fn(); } catch (e) { err = e instanceof Error ? e.message : ""; }
  check(label, err.toLowerCase().includes(needle.toLowerCase()), err.slice(0, 140));
}

const cHash = await refusalCampaign([{ name: "H", zip: "27401" }]);
await manualApproval(cHash.id, { creativeHash: "deadbeef" });
await expectRefusal("B13 creative-hash mismatch refused",
  () => svc.executeCampaign(ws.id, cHash.id), "hash mismatch");

const cCount = await refusalCampaign([{ name: "C1", zip: "27401" }, { name: "C2", zip: "27402" }]);
await manualApproval(cCount.id, { pieceCount: 1 });
await expectRefusal("B14 over-count refused",
  () => svc.executeCampaign(ws.id, cCount.id), "exceeds approved");

const cSpend = await refusalCampaign([{ name: "S", zip: "27401" }]);
await manualApproval(cSpend.id, { maxSpendCents: 1 });
await expectRefusal("B15 over-spend refused",
  () => svc.executeCampaign(ws.id, cSpend.id), "exceeds approved max");

const cNone = await refusalCampaign([{ name: "N", zip: "27401" }]);
await expectRefusal("B16 no approval → no send",
  () => svc.executeCampaign(ws.id, cNone.id), "no approved");

const cDraft = await prisma.mailCampaign.create({
  data: {
    workspaceId: ws.id, name: tag("draft"), creativeId: creative.id,
    audienceSource: { kind: "unset" } as unknown as Prisma.InputJsonValue, createdBy: "battery",
  },
});
await expectRefusal("B17 unapproved campaign → no send",
  () => svc.executeCampaign(ws.id, cDraft.id), "must be approved");

// ── Happy path: no provider row → fake render (test mode), nothing mailed ──
const exec = await svc.executeCampaign(ws.id, campaign.id);
check("B18 execute: sent=1 suppressed=2 failed=0, test mode, render-only",
  exec.sent === 1 && exec.suppressed === 2 && exec.failed === 0 &&
  exec.mode === "test" && exec.renderedOnly === true,
  JSON.stringify(exec));

const after = await prisma.mailPiece.findMany({ where: { campaignId: campaign.id } });
const byLead = new Map(after.map((p) => [p.leadId, p]));
check("B19 opted_in lead → sent with fake piece id",
  byLead.get(leadIn.id)?.status === "sent" &&
  (byLead.get(leadIn.id)?.providerPieceId ?? "").startsWith("fake_"));
check("B20 opted_out lead → suppressed(opt_out)",
  byLead.get(leadOut.id)?.status === "suppressed" && byLead.get(leadOut.id)?.suppressionReason === "opt_out");
check("B21 no-consent lead → suppressed(no_consent)",
  byLead.get(leadUnknown.id)?.status === "suppressed" && byLead.get(leadUnknown.id)?.suppressionReason === "no_consent");
check("B22 quarantined piece never mailed",
  !!(afterVerify?.id && (await prisma.mailPiece.findUnique({ where: { id: afterVerify.id } }))?.status === "queued"));
check("B23 spend ledger: 85c actual on the one sent piece", exec.spendCents === 85,
  `got ${exec.spendCents}`);
check("B24 campaign → complete",
  (await prisma.mailCampaign.findUnique({ where: { id: campaign.id } }))?.status === "complete");

let reErr = "";
try { await svc.executeCampaign(ws.id, campaign.id); } catch (e) { reErr = e instanceof Error ? e.message : ""; }
check("B25 re-execute after complete refused (no double send)",
  /complete|approved/.test(reErr), reErr.slice(0, 120));

// ── Webhooks: duplicate + out-of-order → one touch, no downgrade ────────────
const sentPiece = byLead.get(leadIn.id)!;
const resourceId = sentPiece.providerPieceId!;
const seq = fake.simulateTrackingSequence(resourceId, RUN);
const eventIds = seq.map((e) => e.eventId);
const fire = (events: unknown[]) => {
  const b = JSON.stringify({ events });
  return webhooks.ingestMailWebhook({
    providerName: "fake", rawBody: b, signature: fake.signFakeMailWebhook(b),
  });
};

const w1 = await fire(seq);
check("B26 webhook sequence accepted", w1.accepted && w1.eventsApplied === 2,
  JSON.stringify({ accepted: w1.accepted, applied: w1.eventsApplied }));
const midPiece = await prisma.mailPiece.findUnique({ where: { id: sentPiece.id } });
check("B27 piece delivered + deliveredAt set",
  midPiece?.status === "delivered" && !!midPiece.deliveredAt);

const wDup = await fire([seq[1]]);
check("B28 duplicate event accepted, not re-applied",
  wDup.accepted && wDup.eventsApplied === 0);

const wOld = await fire([{
  eventId: `${RUN}-old-transit`,
  type: "in_transit",
  providerPieceId: resourceId,
  occurredAt: new Date().toISOString(),
}]);
eventIds.push(`${RUN}-old-transit`);
check("B29 out-of-order accepted, ledger row kept",
  wOld.accepted && wOld.eventsApplied === 0);
const finalPiece = await prisma.mailPiece.findUnique({ where: { id: sentPiece.id } });
check("B30 status stays delivered (no downgrade)", finalPiece?.status === "delivered");

const touchRows = await prisma.attributionTouch.count({
  where: { workspaceId: ws.id, leadId: leadIn.id, channel: "direct_mail" },
});
check("B31 one attribution touch (duplicate/out-of-order collapse)", touchRows === 1, `got ${touchRows}`);

const wBad = await webhooks.ingestMailWebhook({
  providerName: "fake",
  rawBody: JSON.stringify({ events: seq }),
  signature: "nope",
});
check("B32 bad webhook signature rejected", !wBad.accepted);

// ── Tenant isolation ────────────────────────────────────────────────────────
await expectRefusal("B33 cross-workspace execute blocked",
  () => svc.executeCampaign(ws2.id, campaign.id), "not found");
await expectRefusal("B34 cross-workspace audience build blocked",
  () => svc.buildPieces(ws2.id, campaign.id, { kind: "csv", rows: [] }), "not found");
await expectRefusal("B35 cross-workspace provider read blocked",
  () => svc.getMailProviderRow(ws2.id, randomUUID()), "not found");

// ── C. Metered actions ──────────────────────────────────────────────────────
console.log("C. Metering");
check("C1 mail_piece registered", isMeteredAction("mail_piece"));
check("C2 mail_verification registered", isMeteredAction("mail_verification"));

// ── Cleanup ─────────────────────────────────────────────────────────────────
await prisma.attributionTouch.deleteMany({ where: { workspaceId: { in: [ws.id, ws2.id] } } });
await prisma.mailWebhookEvent.deleteMany({ where: { eventId: { in: eventIds } } });
await prisma.mailApproval.deleteMany({ where: { campaign: { workspaceId: { in: [ws.id, ws2.id] } } } });
await prisma.mailPiece.deleteMany({ where: { campaign: { workspaceId: { in: [ws.id, ws2.id] } } } });
await prisma.mailCampaign.deleteMany({ where: { workspaceId: { in: [ws.id, ws2.id] } } });
await prisma.mailCreative.deleteMany({ where: { workspaceId: { in: [ws.id, ws2.id] } } });
await prisma.contactConsent.deleteMany({ where: { workspaceId: { in: [ws.id, ws2.id] } } });
await prisma.lead.deleteMany({ where: { workspaceId: { in: [ws.id, ws2.id] } } });
await prisma.pipeline.deleteMany({ where: { workspaceId: { in: [ws.id, ws2.id] } } });
await prisma.workspace.deleteMany({ where: { id: { in: [ws.id, ws2.id] } } });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:", failures.join(", "));
  process.exit(1);
}
