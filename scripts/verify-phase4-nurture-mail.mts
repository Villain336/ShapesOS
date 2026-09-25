// Marketr — Phase 4 R3-integration battery: direct mail as a nurture channel
// (T1-native).
//
// Run: DATABASE_URL=<redacted> npx tsx scripts/verify-phase4-nurture-mail.mts
// Run 3x green before calling this done.
//
// Covers:
//   - Pure: parseMailChannel, estimateInHomeWindow, renderCopy, mailMergeVars,
//     creativeHashFor (T1), extractAddressFromLead (T1), deterministicVerify +
//     estimateCost (T1 FakeMailProvider), parseSteps mail fields, stepDelayMs.
//   - E2E: queueMailPiece → MailCampaign + MailPiece + MailApproval (T1
//     requestApproval binds creativeHash + pieceCount + maxSpendCents) →
//     decideApproval → dispatchDueNurtureMail → executeCampaign → piece sent
//     (fake provider, rendered-only), metered mail_verification + mail_piece.
//   - Consent: opted_out → opt_out; unknown → no_consent (default-deny).
//   - Address: missing → invalid_address; bad zip → quarantined → suppressed,
//     campaign cancelled, never mailed.
//   - delayDays applied exactly once (mailDate ≈ now + delayDays).
//   - In-home anchoring: sequence follow-up anchors on inHomeEnd.
//   - Daily cap (workspace + sequence) applies to mail steps.
//   - Money gate: pending_approval campaign never sends.
//   - Tenant isolation.
//   - Triggered kinds: missed_call / speed_to_lead ride the same queue path.
//
// Strategy: exercise the real lib modules directly on a fresh database.
// Each run uses uniquely-named workspaces so runs never interfere.

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(2);
}

const { prisma } = await import("@/lib/prisma");
const seq = await import("@/lib/messaging/sequences");
const disp = await import("@/lib/messaging/dispatcher");
const consent = await import("@/lib/messaging/consent");
const qh = await import("@/lib/messaging/quiet-hours");
const mail = await import("@/lib/messaging/mail-channel");
const t1 = await import("@/lib/mail/service");
const { FakeMailProvider, deterministicVerify } = await import("@/lib/mail/fake");
const { pieceCentsFor } = await import("@/lib/mail/provider");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, extra?: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}${extra ? ` — ${extra}` : ""}`);
    console.error(`FAIL: ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

function approx(name: string, actual: number, expected: number, tolMs: number) {
  check(name, Math.abs(actual - expected) <= tolMs, `actual=${actual} expected≈${expected} tol=${tolMs}`);
}

// ---------------------------------------------------------------------------
// PURE (no database)
// ---------------------------------------------------------------------------

console.log("== pure ==");

// parseMailChannel
check("parseMailChannel postcard", mail.parseMailChannel("postcard") === "postcard");
check("parseMailChannel letter", mail.parseMailChannel("letter") === "letter");
check("parseMailChannel sms → null", mail.parseMailChannel("sms") === null);
check("parseMailChannel garbage → null", mail.parseMailChannel("POSTCARD") === null);

// estimateInHomeWindow: date-based, [lo, hi] transit
{
  const base = new Date("2026-09-24T12:00:00Z");
  const w = mail.estimateInHomeWindow(base, 2, 7);
  check("in-home mailDate passthrough", w.mailDate.getTime() === base.getTime());
  approx("in-home start = +2d", w.inHomeStart.getTime(), base.getTime() + 2 * 86_400_000, 1);
  approx("in-home end = +7d", w.inHomeEnd.getTime(), base.getTime() + 7 * 86_400_000, 1);
  const w2 = mail.estimateInHomeWindow(base);
  approx("in-home defaults [2,7]", w2.inHomeEnd.getTime(), base.getTime() + 7 * 86_400_000, 1);
}

// renderCopy
{
  const out = mail.renderCopy("Hi {{firstName}}, {{addressCity}} {{missing}}!", {
    firstName: "Jane",
    addressCity: "Greensboro",
  });
  check("renderCopy merge fields", out === "Hi Jane, Greensboro !", out);
}

// mailMergeVars
{
  const vars = mail.mailMergeVars(
    { name: "Jane Doe", company: "Acme" },
    { name: "Jane Doe", line1: "123 Main St", city: "Greensboro", state: "NC", zip: "27401" },
  );
  check("mergeVars firstName", vars.firstName === "Jane");
  check("mergeVars addressLine1", vars.addressLine1 === "123 Main St");
  check("mergeVars addressZip", vars.addressZip === "27401");
  check("mergeVars short aliases", vars.city === "Greensboro" && vars.state === "NC" && vars.zip === "27401");
}

// creativeHashFor: stable sha256 hex
{
  const h1 = t1.creativeHashFor("hello");
  const h2 = t1.creativeHashFor("hello");
  check("creativeHashFor stable", h1 === h2);
  check("creativeHashFor 64-hex", /^[0-9a-f]{64}$/.test(h1), h1);
  check("creativeHashFor differs", t1.creativeHashFor("hello") !== t1.creativeHashFor("world"));
}

// extractAddressFromLead (T1): nested + flat + missing
{
  const nested = t1.extractAddressFromLead({
    name: "Jane",
    customFields: { address: { line1: "123 Main St", city: "Greensboro", state: "NC", zip: "27401" } },
  });
  check("extract nested address", nested?.zip === "27401" && nested?.line1 === "123 Main St");
  const flat = t1.extractAddressFromLead({
    name: "Jane",
    customFields: { street: "9 Elm St", town: "Raleigh", state: "NC", postalCode: "27601" },
  });
  check("extract flat address", flat?.city === "Raleigh" && flat?.line1 === "9 Elm St");
  const missing = t1.extractAddressFromLead({ name: "Jane", customFields: {} });
  check("extract missing → null", missing === null);
}

// deterministicVerify (T1 fake)
{
  const good = { name: "J", line1: "123 Main St", city: "Greensboro", state: "NC", zip: "27401" };
  check("verify valid", deterministicVerify(good).status === "valid");
  check(
    "verify casing → corrected",
    deterministicVerify({ ...good, city: "greensboro", state: "nc" }).status === "corrected",
  );
  check("verify bad zip → quarantined", deterministicVerify({ ...good, zip: "ABC" }).status === "quarantined");
  check(
    "verify undeliverable → quarantined",
    deterministicVerify({ ...good, line1: "1 Undeliverable Way" }).status === "quarantined",
  );
  const ncoa = deterministicVerify({ ...good, line1: "5 NCOA Moved Ln" });
  check("verify ncoa → corrected", ncoa.status === "corrected" && !!ncoa.correctedAddress);
}

// FakeMailProvider estimateCost: documented table (85¢ postcard 4x6, 94¢ letter)
{
  const p = new FakeMailProvider();
  const pc = await p.estimateCost({ format: "postcard_4x6", count: 1, verifications: 0 });
  const pcTotal = pc.reduce((s, l) => s + l.cents, 0);
  check("fake estimate postcard_4x6 = 85¢", pcTotal === 85, JSON.stringify(pc));
  check("fake line items use cents", pc.every((l) => typeof l.cents === "number"));
  const lt = await p.estimateCost({ format: "letter", count: 1, verifications: 0 });
  check("fake estimate letter = 94¢", lt.reduce((s, l) => s + l.cents, 0) === 94, JSON.stringify(lt));
  check("pieceCentsFor matches", pieceCentsFor("lob", "postcard_4x6") === 85 && pieceCentsFor("lob", "letter") === 94);
}

// resolveMailProvider: no row → fake, test mode
{
  const r = await t1.resolveMailProvider("ws-that-does-not-exist");
  check("resolveMailProvider fallback fake", r.providerName === "fake" && r.mode === "test");
}

// parseSteps mail fields
{
  const steps = seq.parseSteps([
    { channel: "postcard", delayMinutes: 0, template: "Hi {{firstName}}", creativeId: "cr_1", delayDays: 3, inHomeWindowDays: [3, 9] },
    { channel: "sms", delayMinutes: 60, template: "hello" },
  ]);
  check("parseSteps keeps mail fields", steps[0].delayDays === 3 && steps[0].creativeId === "cr_1");
  check("parseSteps transit tuple", JSON.stringify((steps[0] as { inHomeWindowDays?: [number, number] }).inHomeWindowDays) === "[3,9]");
  check("stepDelayMs mail = delayDays", seq.stepDelayMs(steps[0]) === 3 * 86_400_000);
  check("stepDelayMs sms = delayMinutes", seq.stepDelayMs(steps[1]) === 60 * 60_000);
}

// queueMessage rejects mail channels (T1-native: use queueMailPiece)
{
  let threw = "";
  try {
    await disp.queueMessage({ workspaceId: "x", leadId: "y", channel: "postcard", kind: "manual", body: "hi" });
  } catch (e) {
    threw = e instanceof Error ? e.message : "";
  }
  check("queueMessage rejects postcard", threw.includes("queueMailPiece"), threw);
}

console.log(`pure: ${passed} passed, ${failed} failed`);

// ---------------------------------------------------------------------------
// DB-BACKED (real T1 service: campaign + piece + approval + execute)
// ---------------------------------------------------------------------------

console.log("== db ==");

const RUN = Date.now().toString(36);

async function mkWorkspace(suffix: string) {
  const ws = await prisma.workspace.create({
    data: { name: `mail-battery-${RUN}-${suffix}`, ownerUserId: "battery" },
  });
  // Seed a generous credit pool so T1's metering (mail_verification /
  // mail_piece) can record charges — production workspaces get caps from
  // their plan; the battery must not trip the spend guard.
  await prisma.spendCap.upsert({
    where: { workspaceId: ws.id },
    create: { workspaceId: ws.id, capCredits: 100_000 },
    update: { capCredits: 100_000 },
  });
  return ws;
}

async function mkPipeline(workspaceId: string) {
  return prisma.pipeline.create({
    data: {
      workspaceId,
      name: "battery",
      stages: [{ id: "new", label: "New", color: "violet" }],
      isDefault: true,
    },
  });
}

const GOOD_ADDR = { line1: "123 Main St", city: "Greensboro", state: "NC", zip: "27401" };

async function mkLead(
  workspaceId: string,
  pipelineId: string,
  name: string,
  address: Record<string, string> | null = GOOD_ADDR,
  mailConsent: "opted_in" | "opted_out" | "unknown" = "opted_in",
) {
  const lead = await prisma.lead.create({
    data: {
      workspaceId,
      pipelineId,
      name,
      customFields: address ? { address } : {},
    },
  });
  await consent.setConsent(workspaceId, lead.id, "mail", mailConsent, "battery");
  return lead;
}

async function approveCampaign(workspaceId: string, campaignId: string) {
  const approval = await prisma.mailApproval.findFirstOrThrow({
    where: { campaignId, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
  return t1.decideApproval(workspaceId, approval.id, "approve", "battery");
}

const ws = await mkWorkspace("a");
const pipe = await mkPipeline(ws.id);

// --- happy path: queue → approve → dispatch → sent ---
const leadA = await mkLead(ws.id, pipe.id, "Alice Ample");
const before = Date.now();
const q = await mail.queueMailPiece({
  workspaceId: ws.id,
  leadId: leadA.id,
  channel: "postcard",
  copy: { headline: "Hi {{firstName}}", body: "Welcome to {{addressCity}}, {{firstName}}!", cta: "Reply YES" },
  delayDays: 0,
  sequenceId: "seq-1",
  enrollmentId: "enr-1",
  stepIndex: 0,
  requestedBy: "battery",
});
check("queue happy path not suppressed", !q.suppressed, q.suppressionReason);
check("queue returns campaign+piece+approval", !!q.campaignId && !!q.pieceId && !!q.approvalId);

const camp = await prisma.mailCampaign.findUniqueOrThrow({
  where: { id: q.campaignId! },
  include: { pieces: true, approvals: true },
});
check("campaign pending_approval", camp.status === "pending_approval", camp.status);
check("campaign one piece", camp.pieces.length === 1);
check("campaign in-home set", !!camp.inHomeStart && !!camp.inHomeEnd);
approx("in-home start = mailDate+2d", camp.inHomeStart!.getTime(), q.inHome!.inHomeStart.getTime(), 5000);
approx("in-home end = mailDate+7d", camp.inHomeEnd!.getTime(), q.inHome!.inHomeEnd.getTime(), 5000);

const aud = camp.audienceSource as Record<string, unknown>;
check("audienceSource nurture_step", aud.kind === "nurture_step" && aud.channel === "postcard");
check("audienceSource carries sequence ctx", aud.sequenceId === "seq-1" && aud.stepIndex === 0);
// delayDays applied exactly once: mailDate ≈ now + 0d (NOT doubled)
approx("mailDate = now + delayDays (once)", new Date(aud.mailDate as string).getTime(), before, 60_000);

const piece = camp.pieces[0];
check("piece queued", piece.status === "queued", piece.status);
check("piece verified valid|corrected", piece.verificationStatus === "valid" || piece.verificationStatus === "corrected", piece.verificationStatus);
check("piece qrSlug minted", !!piece.qrSlug && piece.qrSlug.startsWith("nrt-"));
check("piece address snapshot", (piece.addressSnapshot as { zip?: string }).zip === "27401");

const approval = camp.approvals[0];
check("approval pending", approval.status === "pending");
check("approval binds pieceCount=1", approval.pieceCount === 1);
check("approval binds maxSpend>0", approval.maxSpendCents > 0, String(approval.maxSpendCents));
check("approval binds creativeHash", !!approval.creativeHash && approval.creativeHash.length === 64);
// estimate: 85¢ subtotal, 2x hosted margin → maxSpend 170¢
check("estCostCents = 85 (fake postcard)", q.estCostCents === 85, String(q.estCostCents));
check("maxSpendCents = 170 (2x margin)", q.maxSpendCents === 170, String(q.maxSpendCents));

// money gate: pending_approval campaign never sends
{
  const r = await mail.dispatchDueNurtureMail(ws.id);
  check("unapproved campaign not attempted", r.attempted === 0, JSON.stringify(r));
  const still = await prisma.mailPiece.findUniqueOrThrow({ where: { id: piece.id } });
  check("piece still queued", still.status === "queued");
}

await approveCampaign(ws.id, camp.id);
const approvedCamp = await prisma.mailCampaign.findUniqueOrThrow({ where: { id: camp.id } });
check("campaign approved after decide", approvedCamp.status === "approved");

const dr = await mail.dispatchDueNurtureMail(ws.id);
check("dispatch attempted 1", dr.attempted === 1, JSON.stringify(dr));
check("dispatch sent 1", dr.sent === 1, JSON.stringify(dr));

const sentPiece = await prisma.mailPiece.findUniqueOrThrow({ where: { id: piece.id } });
check("piece sent", sentPiece.status === "sent", sentPiece.status);
check("piece providerPieceId fake_*", !!sentPiece.providerPieceId && sentPiece.providerPieceId.startsWith("fake_"), sentPiece.providerPieceId ?? "");
check("piece costCents = 85", sentPiece.costCents === 85, String(sentPiece.costCents));
check("piece sentAt set", !!sentPiece.sentAt);
const doneCamp = await prisma.mailCampaign.findUniqueOrThrow({ where: { id: camp.id } });
check("campaign complete", doneCamp.status === "complete", doneCamp.status);
check("campaign actualCostCents = 85", doneCamp.actualCostCents === 85, String(doneCamp.actualCostCents));

// metering: T1 meters mail_verification + mail_piece (exactly once each)
{
  const events = await prisma.usageEvent.findMany({
    where: { workspaceId: ws.id, action: { in: ["mail_verification", "mail_piece"] } },
  });
  check("metered mail_verification once", events.filter((e) => e.action === "mail_verification").length === 1, String(events.length));
  check("metered mail_piece once", events.filter((e) => e.action === "mail_piece").length === 1);
  const mv = events.find((e) => e.action === "mail_verification");
  check("mail_verification credits = 5", mv?.credits === 5, String(mv?.credits));
  const mp = events.find((e) => e.action === "mail_piece");
  check("mail_piece credits = 85 (pass-through)", mp?.credits === 85, String(mp?.credits));
}

// --- consent gates ---
{
  const optedOut = await mkLead(ws.id, pipe.id, "Oscar Out", GOOD_ADDR, "opted_out");
  const r1 = await mail.queueMailPiece({ workspaceId: ws.id, leadId: optedOut.id, channel: "postcard", copy: { body: "hi" }, delayDays: 0 });
  check("opted_out → suppressed opt_out", r1.suppressed && r1.suppressionReason === "opt_out", r1.suppressionReason);
  check("opted_out creates no campaign", !r1.campaignId);

  const unknown = await mkLead(ws.id, pipe.id, "Uma Unknown", GOOD_ADDR, "unknown");
  const r2 = await mail.queueMailPiece({ workspaceId: ws.id, leadId: unknown.id, channel: "letter", copy: { body: "hi" }, delayDays: 0 });
  check("unknown → suppressed no_consent", r2.suppressed && r2.suppressionReason === "no_consent", r2.suppressionReason);
}

// --- address gates ---
{
  const noAddr = await mkLead(ws.id, pipe.id, "Nora Noaddr", null);
  const r = await mail.queueMailPiece({ workspaceId: ws.id, leadId: noAddr.id, channel: "postcard", copy: { body: "hi" }, delayDays: 0 });
  check("missing address → invalid_address", r.suppressed && r.suppressionReason === "invalid_address", r.suppressionReason);

  const badZip = await mkLead(ws.id, pipe.id, "Zed Badzip", { ...GOOD_ADDR, zip: "XYZ" });
  const r2 = await mail.queueMailPiece({ workspaceId: ws.id, leadId: badZip.id, channel: "postcard", copy: { body: "hi" }, delayDays: 0 });
  check("bad zip → quarantined → suppressed", r2.suppressed && r2.suppressionReason === "invalid_address", r2.suppressionReason);
  check("quarantine verification recorded", r2.verificationStatus === "quarantined");
  const qc = await prisma.mailCampaign.findUniqueOrThrow({ where: { id: r2.campaignId! } });
  check("quarantined campaign cancelled", qc.status === "cancelled", qc.status);
  const qp = await prisma.mailPiece.findUniqueOrThrow({ where: { id: r2.pieceId! } });
  check("quarantined piece suppressed", qp.status === "suppressed" && qp.suppressionReason === "invalid_address");
}

// --- Studio creative path ---
{
  const creative = await prisma.mailCreative.create({
    data: {
      workspaceId: ws.id,
      name: "battery creative",
      channelTemplate: "print",
      formatTrack: "addressed",
      size: "6x9",
      source: "upload",
      creativeHash: t1.creativeHashFor("pdf-bytes"),
      status: "ready",
    },
  });
  const leadC = await mkLead(ws.id, pipe.id, "Cora Creative");
  const r = await mail.queueMailPiece({
    workspaceId: ws.id, leadId: leadC.id, channel: "postcard",
    copy: { body: "hi" }, creativeId: creative.id, delayDays: 0,
  });
  check("studio creative accepted", !r.suppressed);
  const c2 = await prisma.mailCampaign.findUniqueOrThrow({ where: { id: r.campaignId! } });
  check("campaign uses studio creative", c2.creativeId === creative.id);
}

// --- triggered kinds ride the same path ---
{
  const leadT = await mkLead(ws.id, pipe.id, "Tina Trigger");
  for (const kind of ["missed_call", "speed_to_lead"] as const) {
    const r = await mail.queueMailPiece({
      workspaceId: ws.id, leadId: leadT.id, channel: "letter",
      copy: { body: "hi" }, delayDays: 0, kind,
    });
    check(`${kind} queued`, !r.suppressed, r.suppressionReason);
    const c = await prisma.mailCampaign.findUniqueOrThrow({ where: { id: r.campaignId! } });
    check(`${kind} in audienceSource`, (c.audienceSource as Record<string, unknown>).nurtureKind === kind);
  }
}

// --- workspace daily cap (shared counter) ---
{
  const wsCap = await mkWorkspace("cap");
  const pipeCap = await mkPipeline(wsCap.id);
  await qh.updateMessagingSettings(wsCap.id, { dailyCap: 1 }, "battery");
  const l1 = await mkLead(wsCap.id, pipeCap.id, "Cap One");
  const l2 = await mkLead(wsCap.id, pipeCap.id, "Cap Two");
  const q1 = await mail.queueMailPiece({ workspaceId: wsCap.id, leadId: l1.id, channel: "postcard", copy: { body: "hi" }, delayDays: 0 });
  check("cap ws: first queued", !q1.suppressed, q1.suppressionReason);
  await approveCampaign(wsCap.id, q1.campaignId!);
  const d1 = await mail.dispatchDueNurtureMail(wsCap.id);
  check("cap ws: first sent", d1.sent === 1, JSON.stringify(d1));
  const q2 = await mail.queueMailPiece({ workspaceId: wsCap.id, leadId: l2.id, channel: "postcard", copy: { body: "hi" }, delayDays: 0 });
  check("cap ws: second suppressed cap_exceeded", q2.suppressed && q2.suppressionReason === "cap_exceeded", q2.suppressionReason);
}

// --- sequence integration: mail step → campaign; follow-up anchors on inHomeEnd ---
{
  const wsSeq = await mkWorkspace("seq");
  const pipeSeq = await mkPipeline(wsSeq.id);
  const leadS = await mkLead(wsSeq.id, pipeSeq.id, "Selma Sequence");
  const sequence = await prisma.nurtureSequence.create({
    data: {
      workspaceId: wsSeq.id,
      name: "battery seq",
      status: "active",
      steps: [
        { channel: "postcard", delayMinutes: 0, template: "Hi {{firstName}} from {{addressCity}}", delayDays: 0, inHomeWindowDays: [2, 7] },
        { channel: "sms", delayMinutes: 30, template: "follow-up" },
      ],
    },
  });
  const enr = await seq.enrollLead(wsSeq.id, sequence.id, leadS.id);
  check("enrolled", enr.enrollmentId !== undefined);
  // SMS consent for the follow-up step's later queueing isn't needed for the mail assertion,
  // but give it anyway so the sequence can proceed naturally.
  await consent.setConsent(wsSeq.id, leadS.id, "sms", "opted_in", "battery");
  const adv = await seq.advanceEnrollments(wsSeq.id);
  check("advance ran mail step", adv.advanced === 1 || adv.completed === 1, JSON.stringify(adv));

  const campS = await prisma.mailCampaign.findFirstOrThrow({
    where: { workspaceId: wsSeq.id, audienceSource: { path: ["kind"], equals: "nurture_step" } },
    orderBy: { createdAt: "desc" },
  });
  check("sequence mail step created campaign", campS.status === "pending_approval", campS.status);
  const audS = campS.audienceSource as Record<string, unknown>;
  check("campaign linked to sequence", audS.sequenceId === sequence.id);

  // Follow-up anchors on inHomeEnd + next-step delay (30 min)
  const enrAfter = await prisma.sequenceEnrollment.findFirstOrThrow({
    where: { sequenceId: sequence.id, leadId: leadS.id },
  });
  check("enrollment advanced to step 1", enrAfter.currentStep === 1, String(enrAfter.currentStep));
  const expectedNext = campS.inHomeEnd!.getTime() + 30 * 60_000;
  approx("nextRunAt = inHomeEnd + 30min", enrAfter.nextRunAt!.getTime(), expectedNext, 60_000);

  // sequence-level daily cap counts the mail campaign
  const seqCount = await mail.sequenceMailSendsToday(wsSeq.id, sequence.id);
  check("sequenceMailSendsToday counts mail", seqCount === 1, String(seqCount));

  // cancelled campaigns (quarantined address) don't consume the sequence cap
  const badSeqLead = await mkLead(wsSeq.id, pipeSeq.id, "Bad Addr", { ...GOOD_ADDR, zip: "XYZ" });
  await mail.queueMailPiece({
    workspaceId: wsSeq.id, leadId: badSeqLead.id, channel: "postcard",
    copy: { body: "hi" }, delayDays: 0, sequenceId: sequence.id,
  });
  const seqCount2 = await mail.sequenceMailSendsToday(wsSeq.id, sequence.id);
  check("cancelled excluded from sequence cap", seqCount2 === 1, String(seqCount2));

  // approve + full dispatcher sweep sends it
  await approveCampaign(wsSeq.id, campS.id);
  const dr = await disp.dispatchDue(wsSeq.id);
  check("dispatchDue sends approved mail", dr.sent === 1, JSON.stringify(dr));
}

// --- tenant isolation ---
{
  const wsB = await mkWorkspace("b");
  const rowsB = await mail.getNurtureMailPieces(wsB.id);
  check("tenant B sees no pieces", rowsB.length === 0, String(rowsB.length));
  const rowsA = await mail.getNurtureMailPieces(ws.id);
  check("tenant A sees its pieces", rowsA.length > 0, String(rowsA.length));
  check("ledger row shape", rowsA[0].qrSlug?.startsWith("nrt-") === true && !!rowsA[0].mailDate);
  let threw = "";
  try {
    await mail.queueMailPiece({ workspaceId: wsB.id, leadId: leadA.id, channel: "postcard", copy: { body: "hi" }, delayDays: 0 });
  } catch (e) {
    threw = e instanceof Error ? e.message : "";
  }
  check("cross-workspace lead rejected", threw.includes("Lead not found"), threw);
}

// --- consent matrix API includes mail ---
{
  const m = await consent.getConsent(ws.id, leadA.id, "mail");
  check("getConsent mail opted_in", m === "opted_in", String(m));
}

console.log(`\ndb: done`);
console.log(`\nTOTAL: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log("failures:");
  for (const f of failures) console.log(` - ${f}`);
}
await prisma.$disconnect();
process.exit(failed ? 1 : 0);
