// Marketr — Phase 6 SAFETY adversarial battery (O1/O2/R1 + authority spine).
//
// Run: DATABASE_URL=... npx tsx scripts/verify-phase6-safety.mts
// Run 3x green before calling this done.
//
// Exercises the REAL lib modules against the preview Postgres (dedicated
// battery workspace, cleaned up at the end): depth-1 no-send, depth-2
// human-click approvals, depth-3 checklist + two-person gates, binding
// tampering, revoked approvals, cross-workspace isolation, CASL block,
// suppression, daily caps, bounce circuit-breaker, PR journalist ruleset,
// review-reply approval gate, audit hash chain.
//
// Every case must FAIL CLOSED. A thrown expected error = pass; any send
// without approval = catastrophic fail.

import { prisma } from "../lib/prisma";
import {
  authorityApprovals, authorityAudit, authorityTablesReady,
} from "../lib/authority/db";
import {
  createMemoryAuthorityApprovalStore,
  verifyBinding, sha256Hex, ApprovalError,
} from "../lib/authority/approvals";
import { createMemoryAuthorityAuditStore } from "../lib/authority/audit";
import {
  prismaCampaignStore, createMemoryCampaignStore,
} from "../lib/authority/outreach/campaigns";
import { prismaDomainStore } from "../lib/authority/outreach/domains";
import {
  prismaProspectStore, qualifyProspect,
} from "../lib/authority/outreach/prospects";
import {
  prismaSequenceStore, createMemorySequenceStore,
  createDraft, sendNextStep, stopSequenceOnReply, recordHardBounce,
  approvalSecret as outreachApprovalSecret,
} from "../lib/authority/outreach/sequences";
import { approvalSecret as reviewsApprovalSecret } from "../lib/authority/reviews/gbpClient";
import {
  prismaSuppressionStore, suppressEmail, isEmailSuppressed,
} from "../lib/authority/outreach/suppression";
import {
  depth3Checklist, assertDepth3Enabled, assertNotCanadaCold,
  assertDailyCap, bounceAction, assertSpamCeiling, assertJournalistSendAllowed,
  DeliverabilityBlockedError,
} from "../lib/authority/guards";
import { assertDepth3EnabledSafe } from "../lib/authority/outreach/domains";
import { resolveSendingPartner } from "../lib/authority/fake";
import { blankRelationship, authorizeSend } from "../lib/authority/pr/relationships";
import { deAiPass, pitchTheGap } from "../lib/authority/pr/drafts";
import { assertPostable } from "../lib/authority/reviews/queue";
import { replyApprovalInput } from "../lib/authority/reviews/queue";
import { replyStateTransition, MAX_AUTO_REJECTION_RETRIES } from "../lib/authority/reviews/replyState";

const WS = `battery_phase6_safety_${Date.now().toString(36)}`;
const ACTOR = "battery_actor";
const SECRET = "battery-secret";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string) { passed += 1; console.log(`  ✓ ${name}`); }
function bad(name: string, detail: string) {
  failed += 1; failures.push(`${name}: ${detail}`);
  console.log(`  ✗ ${name} — ${detail}`);
}
async function expectThrow(name: string, fn: () => Promise<unknown> | unknown, match?: RegExp) {
  try {
    await fn();
    bad(name, "expected a throw, but it succeeded");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (match && !match.test(msg)) bad(name, `threw but message did not match ${match}: ${msg}`);
    else ok(name);
  }
}
function expectNoThrowSync(name: string, fn: () => unknown) {
  try { fn(); ok(name); } catch (err) {
    bad(name, `unexpected throw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
async function setup() {
  if (!(await authorityTablesReady())) throw new Error("authority tables not provisioned");
  const ws = await prisma.workspace.create({ data: { name: `Battery ${WS}`, ownerUserId: ACTOR } });
  const ws2 = await prisma.workspace.create({ data: { name: `Battery ${WS} (other)`, ownerUserId: ACTOR } });
  return { ws: ws.id, ws2: ws2.id };
}
async function teardown(wsIds: string[]) {
  // Scoped deletes; FK cascades handle children.
  await prisma.workspace.deleteMany({ where: { id: { in: wsIds } } });
}

async function main() {
  console.log("Phase 6 SAFETY battery — no-autonomous-publishing adversarial");
  const { ws, ws2 } = await setup();
  const stores = {
    campaigns: prismaCampaignStore(),
    domains: prismaDomainStore(),
    prospects: prismaProspectStore(),
    sequences: prismaSequenceStore(),
    suppression: prismaSuppressionStore(),
  };
  const partner = resolveSendingPartner({ fake: true });

  const draftInput = (over: Record<string, unknown> = {}) => ({
    campaignId: "", prospectId: "", workspaceId: ws, createdBy: ACTOR,
    subject: "Quick idea for {{company}}", body: "Hi — saw your team is hiring marketers.",
    unsubscribeUrl: "https://example.com/u", physicalAddress: "123 Main St, Raleigh NC",
    ...over,
  });

  // --- 1. Depth 1: prospecting only, zero send paths -----------------------
  console.log("\n[O1] depth-1 no-send");
  const c1 = await stores.campaigns.create(ws, { name: "D1 prospecting", depth: 1, createdBy: ACTOR });
  const p1 = (await stores.prospects.createMany(ws, c1.id, [{
    domain: "example.com", url: "https://example.com", email: "founder@example.com",
    emailVerified: true, qualityScore: 90, relevanceScore: 88,
  }]))[0];
  await stores.prospects.update(p1.id, ws, { status: "qualified" });
  await expectThrow("depth1 createDraft blocked", () =>
    createDraft(stores, draftInput({ campaignId: c1.id, prospectId: p1.id })), /prospecting only/);

  // --- 2. Depth 2: human click = per-send approval -------------------------
  console.log("\n[O1] depth-2 human-click send");
  const c2 = await stores.campaigns.create(ws, { name: "D2 human", depth: 2, createdBy: ACTOR });
  const p2 = (await stores.prospects.createMany(ws, c2.id, [{
    domain: "example.com", url: "https://example.com", email: "cto@example.com",
    emailVerified: true, qualityScore: 85, relevanceScore: 90,
  }]))[0];
  await stores.prospects.update(p2.id, ws, { status: "qualified" });
  const seq2 = await createDraft(stores, draftInput({ campaignId: c2.id, prospectId: p2.id }));
  ok("depth2 createDraft works");
  const sent = await sendNextStep({ ...stores, partner }, { workspaceId: ws, sequenceId: seq2.id, actor: ACTOR });
  if (sent.approvalId) ok("depth2 send created+executed per-send approval");
  else bad("depth2 send", "no approval id returned");
  const appr = await authorityApprovals.get(sent.approvalId!, ws);
  if (appr?.status === "executed" && appr.type === "outreach_send") ok("depth2 approval executed, type outreach_send");
  else bad("depth2 approval", `status=${appr?.status} type=${appr?.type}`);
  // Binding tamper on execute would halt — simulate with a fresh approval:
  const a3 = await authorityApprovals.create({ workspaceId: ws, type: "outreach_send", bindingJson: { to: "a@x.com" }, createdBy: ACTOR });
  await authorityApprovals.submit(a3.id, ws, ACTOR);
  await authorityApprovals.approve(a3.id, ws, ACTOR, SECRET);
  await expectThrow("tampered binding HALTS execute", () =>
    authorityApprovals.execute(a3.id, ws, { to: "evil@x.com" }), /binding/i);

  // --- 3. Depth 3: needs executed two-person activation --------------------
  console.log("\n[O1] depth-3 gates");
  const c3 = await stores.campaigns.create(ws, { name: "D3 auto", depth: 3, createdBy: ACTOR });
  const p3 = (await stores.prospects.createMany(ws, c3.id, [{
    domain: "example.com", url: "https://example.com", email: "vp@example.com",
    emailVerified: true, qualityScore: 92, relevanceScore: 91,
  }]))[0];
  await stores.prospects.update(p3.id, ws, { status: "qualified" });
  const seq3 = await createDraft(stores, draftInput({ campaignId: c3.id, prospectId: p3.id }));
  await expectThrow("depth3 send without activation blocked", () =>
    sendNextStep({ ...stores, partner }, { workspaceId: ws, sequenceId: seq3.id, actor: ACTOR }),
    /active campaign|depth3_activation/);

  // Two-person: one approver is not enough.
  const act = await authorityApprovals.create({
    workspaceId: ws, type: "depth3_activation",
    bindingJson: { campaignId: c3.id, sendingDomainId: "dom_x", depth: 3, dailyCap: 30, checklistHash: "abc" },
    createdBy: ACTOR,
  });
  await authorityApprovals.submit(act.id, ws, ACTOR);
  const partial = await authorityApprovals.approve(act.id, ws, ACTOR, SECRET);
  if (partial.status === "pending") ok("two-person: single approver leaves approval pending");
  else bad("two-person", `status=${partial.status} after one approver`);
  const partial2 = await authorityApprovals.approve(act.id, ws, ACTOR, SECRET);
  if (partial2.status === "pending") ok("two-person: same approver twice still pending");
  else bad("two-person repeat", `status=${partial2.status}`);
  const full = await authorityApprovals.approve(act.id, ws, "second_human", SECRET);
  if (full.status === "approved") ok("two-person: second distinct approver approves");
  else bad("two-person second", `status=${full.status}`);

  // --- 4. Revoked approval cannot execute ----------------------------------
  console.log("\n[authority] lifecycle");
  const ar = await authorityApprovals.create({ workspaceId: ws, type: "outreach_send", bindingJson: { x: 1 }, createdBy: ACTOR });
  await authorityApprovals.submit(ar.id, ws, ACTOR);
  await authorityApprovals.approve(ar.id, ws, ACTOR, SECRET);
  await authorityApprovals.revoke(ar.id, ws, ACTOR);
  await expectThrow("revoked approval cannot execute", () =>
    authorityApprovals.execute(ar.id, ws, { x: 1 }), /revoked|approved/);

  // --- 5. Cross-workspace isolation ----------------------------------------
  console.log("\n[isolation]");
  const xw = await authorityApprovals.create({ workspaceId: ws, type: "outreach_send", bindingJson: { x: 1 }, createdBy: ACTOR });
  const inOther = await authorityApprovals.get(xw.id, ws2);
  if (inOther === null) ok("approval invisible from other workspace");
  else bad("cross-workspace approval", "visible in ws2");
  const cInOther = await stores.campaigns.get(c2.id, ws2);
  if (cInOther === null) ok("campaign invisible from other workspace");
  else bad("cross-workspace campaign", "visible in ws2");
  const pInOther = await stores.prospects.get(p2.id, ws2);
  if (pInOther === null) ok("prospect invisible from other workspace");
  else bad("cross-workspace prospect", "visible in ws2");

  // --- 6. Depth-3 checklist gates ------------------------------------------
  console.log("\n[O1] depth-3 checklist");
  // Production entry point: assertDepth3EnabledSafe derives isGmailFree +
  // warmupStage from the domain row (the raw checklist fn takes precomputed fields).
  const row = (over: Record<string, unknown> = {}) => ({
    domain: "send.example.com", isPrimary: false, spfOk: true, dkimOk: true,
    dmarcPolicy: "reject", warmupStartedAt: new Date(Date.now() - 45 * 86400_000),
    warmupStage: 45, trackingCnameOk: true, ...over,
  });
  expectNoThrowSync("checklist passes on healthy secondary domain", () => assertDepth3EnabledSafe(row()));
  await expectThrow("primary domain blocked", () => assertDepth3EnabledSafe(row({ isPrimary: true })), /primary/i);
  await expectThrow("gmail free account blocked", () => assertDepth3EnabledSafe(row({ domain: "gmail.com" })), /gmail/i);
  await expectThrow("warmup <30d blocked", () =>
    assertDepth3EnabledSafe(row({ warmupStartedAt: new Date(Date.now() - 5 * 86400_000), warmupStage: 5 })), /warmup/i);
  await expectThrow("missing DMARC blocked", () => assertDepth3EnabledSafe(row({ dmarcPolicy: "none" })), /dmarc/i);
  const fails = depth3Checklist({ ...row(), isGmailFree: true, isPrimary: true } as never);
  if (fails.length >= 2) ok("checklist names each failure");
  else bad("checklist failures", `expected >=2, got ${fails.length}`);

  // --- 7. CASL + suppression + caps + bounce -------------------------------
  console.log("\n[O1] rails");
  await expectThrow("Canada cold outreach blocked (CASL)", () => assertNotCanadaCold("ceo@shop.ca"), /canada|casl/i);
  const cRail = await stores.campaigns.create(ws, { name: "D2 rails", depth: 2, dailyCap: 1, createdBy: ACTOR });
  const mkProspect = async (email: string) => {
    const p = (await stores.prospects.createMany(ws, cRail.id, [{
      domain: "example.com", url: "https://example.com", email, emailVerified: true,
      qualityScore: 85, relevanceScore: 85,
    }]))[0];
    await stores.prospects.update(p.id, ws, { status: "qualified" });
    return p;
  };
  const pr1 = await mkProspect("one@example.com");
  const pr2 = await mkProspect("two@example.com");
  const prSupp = await mkProspect("suppressed@example.com");
  await suppressEmail(stores.suppression, { workspaceId: ws, email: "suppressed@example.com", kind: "global", source: "battery" });
  const sSupp = await createDraft(stores, draftInput({ campaignId: cRail.id, prospectId: prSupp.id }));
  await expectThrow("suppressed recipient blocked", () =>
    sendNextStep({ ...stores, partner }, { workspaceId: ws, sequenceId: sSupp.id, actor: ACTOR }), /suppressed/i);
  const s1 = await createDraft(stores, draftInput({ campaignId: cRail.id, prospectId: pr1.id }));
  await sendNextStep({ ...stores, partner }, { workspaceId: ws, sequenceId: s1.id, actor: ACTOR });
  const s2 = await createDraft(stores, draftInput({ campaignId: cRail.id, prospectId: pr2.id }));
  await expectThrow("daily cap enforced", () =>
    sendNextStep({ ...stores, partner }, { workspaceId: ws, sequenceId: s2.id, actor: ACTOR }), /cap/i);
  if (bounceAction(6) === "stop" && bounceAction(4) === "pause" && bounceAction(1) === "ok") ok("bounce circuit-breaker thresholds");
  else bad("bounce thresholds", "wrong mapping");
  await expectThrow("spam ceiling enforced", () => assertSpamCeiling(0.5), /spam/i);
  // stop-on-reply
  const sReply = await createDraft(stores, draftInput({ campaignId: cRail.id, prospectId: pr2.id }));
  await stopSequenceOnReply(
    { sequences: stores.sequences, prospects: stores.prospects, suppression: stores.suppression },
    { workspaceId: ws, sequenceId: sReply.id, replyId: "reply_1", actor: ACTOR });
  await expectThrow("stop-on-reply halts sequence", () =>
    sendNextStep({ ...stores, partner }, { workspaceId: ws, sequenceId: sReply.id, actor: ACTOR }), /stopped/i);

  // --- 8. PR journalist ruleset --------------------------------------------
  console.log("\n[O2] journalist ruleset");
  const rel = blankRelationship("Jane Reporter", "TechDaily");
  await expectThrow("attachments blocked", () =>
    authorizeSend(rel, { subject: "Short subject", hasAttachment: true, isBcc: false }), /attachment/i);
  await expectThrow("BCC blocked", () =>
    authorizeSend(rel, { subject: "Short subject", hasAttachment: false, isBcc: true }), /bcc/i);
  await expectThrow("subject >49 chars blocked", () =>
    authorizeSend(rel, { subject: "x".repeat(50), hasAttachment: false, isBcc: false }), /subject/i);
  expectNoThrowSync("1:1 clean send allowed", () =>
    authorizeSend(rel, { subject: "Short subject", hasAttachment: false, isBcc: false }));
  const ai = deAiPass("In today's fast-paced digital landscape, it's important to note that leveraging synergy is a game-changer.");
  if (ai.flags.length > 0) ok("de-AI pass flags robotic phrasing");
  else bad("de-AI pass", "no flags on obvious AI text");
  const human = deAiPass("We cut their ad spend 31% in six weeks. Here's the exact playbook we used.");
  if (human.flags.length === 0) ok("de-AI pass clears human copy");
  else bad("de-AI pass", `false positives: ${human.flags.join(",")}`);

  // --- 9. Review reply approval gate ----------------------------------------
  console.log("\n[R1] review reply gate");
  await expectThrow("post without approval blocked", () =>
    assertPostable({ status: "approved_draft" } as never, "pending"), /not approved/i);
  expectNoThrowSync("approved reply postable", () =>
    assertPostable({ status: "approved_draft" } as never, "approved"));
  const rInput = replyApprovalInput({
    workspaceId: ws, createdBy: ACTOR,
    queueItem: { id: "q1", reviewId: "r1", locationRef: "loc1", source: "gbp" },
    replyText: "Thanks for the kind words!",
  });
  const rr = await authorityApprovals.create(rInput);
  await authorityApprovals.submit(rr.id, ws, ACTOR);
  const rr1 = await authorityApprovals.approve(rr.id, ws, ACTOR, SECRET);
  if (rr1.status === "pending") ok("review_reply_post needs two approvers");
  else bad("review two-person", `status=${rr1.status}`);
  await authorityApprovals.approve(rr.id, ws, "second_human", SECRET);
  const rrFinal = (await authorityApprovals.get(rr.id, ws))!;
  if (rrFinal.status === "approved") ok("review_reply_post approved by two distinct humans");
  else bad("review two-person final", `status=${rrFinal.status}`);

  // ReviewReplyState: rejection → sanitize+redraft → human re-approval; 2nd rejection → human-only.
  console.log("\n[R1] ReviewReplyState machine");
  const qi = {
    id: "q1", workspaceId: ws, reviewId: "r1", locationRef: "loc1", source: "gbp",
    rating: 4, sentiment: "positive", reviewText: "Great!", reviewerName: "Pat",
    draftReply: "Thanks!", guardrailFlags: [] as string[], status: "posted",
    replyState: "posted", rejectionCount: 0,
  } as never;
  const t1 = replyStateTransition({ item: qi, polled: "REJECTED", redraft: () => "Sanitized: thank you!" });
  if (t1.action === "sanitized_redrafted" && t1.queueItem.status === "pending") {
    ok("1st rejection → sanitized redraft → back to human (pending)");
  } else bad("rejection-1", t1.action);
  if (t1.queueItem.guardrailFlags.includes("auto_sanitized_after_rejection")) {
    ok("sanitization flagged on the item");
  } else bad("sanitize flag", "missing");
  const t2 = replyStateTransition({
    item: { ...t1.queueItem, rejectionCount: 1 } as never, polled: "REJECTED", redraft: () => "x",
  });
  if (t2.action === "escalated" && t2.queueItem.status === "escalated") {
    ok("2nd rejection → human-only escalation");
  } else bad("rejection-2", t2.action);
  if (MAX_AUTO_REJECTION_RETRIES === 2) ok("max 2 auto-retries");
  else bad("max retries", String(MAX_AUTO_REJECTION_RETRIES));
  const t3 = replyStateTransition({ item: qi, polled: "APPROVED", redraft: () => "x" });
  if (t3.action === "confirmed") ok("APPROVED → confirmed");
  else bad("approved", t3.action);

  // --- 10. Audit hash chain -------------------------------------------------
  console.log("\n[authority] audit hash chain");
  const memAudit = createMemoryAuthorityAuditStore();
  memAudit.log({ workspaceId: ws, actor: ACTOR, action: "a", entityType: "t", entityId: "1", detail: {} });
  memAudit.log({ workspaceId: ws, actor: ACTOR, action: "b", entityType: "t", entityId: "2", detail: {} });
  if (memAudit.verifyChain().ok) ok("audit chain verifies");
  else bad("audit chain", "broken on honest log");
  const memAppr = createMemoryAuthorityApprovalStore();
  const ma = memAppr.create({ workspaceId: ws, type: "outreach_send", bindingJson: { a: 1 }, createdBy: ACTOR });
  if (verifyBinding(ma, { a: 1 }) && !verifyBinding(ma, { a: 2 })) ok("binding verify true/false");
  else bad("binding verify", "wrong result");
  await expectThrow("memory: approve in wrong state", () =>
    memAppr.approve(ma.id, ws, ACTOR, SECRET), /draft/);

  // --- 11. Fake providers are honest ----------------------------------------
  console.log("\n[fake-first]");
  const fakePartner = resolveSendingPartner({ provider: "smartlead", apiKey: null, fake: true });
  const fakeRes = await fakePartner.send({
    to: "a@b.com", subject: "s", body: "b", fromMailbox: "m", campaignId: "c", sequenceId: "q",
    unsubscribeUrl: "", physicalAddress: "",
  });
  if (fakeRes.messageId.startsWith("fake_")) ok("fake partner default, clearly-labeled message ids");
  else bad("fake partner", `messageId=${fakeRes.messageId}`);
  // Real key present but no live adapter yet → honest NotConfiguredError
  // (never a bare "unreachable", never a pretend-send).
  await expectThrow("real-key path throws honest NotConfiguredError", () =>
    Promise.resolve(resolveSendingPartner({ provider: "smartlead", apiKey: "sk_live_x", fake: false })), /not configured/i);

  // Approval HMAC secrets fail closed in production (no hardcoded fallback).
  // (process.env is NODE_ENV-readonly in types; mutate via a record cast.)
  const env = process.env as Record<string, string | undefined>;
  const savedAuth = env.AUTHORITY_APPROVAL_SECRET;
  const savedMkt = env.MARKETR_APPROVAL_SECRET;
  const savedNode = env.NODE_ENV;
  delete env.AUTHORITY_APPROVAL_SECRET;
  delete env.MARKETR_APPROVAL_SECRET;
  env.NODE_ENV = "production";
  await expectThrow("outreach approvalSecret fails closed in prod", () =>
    Promise.resolve(outreachApprovalSecret()), /not set/i);
  await expectThrow("reviews approvalSecret fails closed in prod", () =>
    Promise.resolve(reviewsApprovalSecret()), /not set/i);
  env.NODE_ENV = "development";
  if (outreachApprovalSecret() === "dev-insecure-secret") ok("dev fallback (loud warning) outside prod");
  else bad("dev fallback", "unexpected value");
  // Restore env for the rest of the battery.
  if (savedAuth !== undefined) env.AUTHORITY_APPROVAL_SECRET = savedAuth;
  if (savedMkt !== undefined) env.MARKETR_APPROVAL_SECRET = savedMkt;
  if (savedNode !== undefined) env.NODE_ENV = savedNode; else delete env.NODE_ENV;

  console.log(`\n${passed} passed, ${failed} failed`);
  await teardown([ws, ws2]);
  if (failed > 0) { console.log("FAILURES:", failures); process.exit(1); }
  console.log("SAFETY BATTERY GREEN");
}

main().catch(async (err) => {
  console.error("battery crashed:", err);
  process.exit(2);
});
