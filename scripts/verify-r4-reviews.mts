// Marketr — R4 review engine regression battery (Phase 3).
// Re-verifies the R4 engine after shared-code changes (quiet-hours fix).
// Run: DATABASE_URL=<fresh-db> npx tsx scripts/verify-r4-reviews.mts

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(2);
}

const { prisma } = await import("@/lib/prisma");
const eng = await import("@/lib/reviews/engine");
const resp = await import("@/lib/reviews/responder");
const disp = await import("@/lib/messaging/dispatcher");
const consent = await import("@/lib/messaging/consent");
const stages = await import("@/lib/crm/stages");

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const RUN = `zz-r4-${Date.now()}-${process.pid}`;
const tag = (s: string) => `${RUN}-${s}`;
const ws = await prisma.workspace.create({ data: { name: tag("ws"), ownerUserId: `battery-${process.pid}` } });
await prisma.creditBalance.create({
  data: { workspaceId: ws.id, includedCredits: 100000, purchasedCredits: 0, usedCredits: 0, periodStart: new Date() },
});
const pipe = await prisma.pipeline.create({
  data: { workspaceId: ws.id, name: tag("pipe"), stages: stages.DEFAULT_STAGES as never, isDefault: true },
});
const project = await prisma.project.create({ data: { workspaceId: ws.id, domain: "example.com" } });
const lead = await prisma.lead.create({
  data: { workspaceId: ws.id, pipelineId: pipe.id, name: "Rita Vale", email: "rita@example.com", phone: "+15551234567", stage: "new", score: 50 },
});
check("S0 setup", !!(ws.id && lead.id && project.id));

// Config: Google review link.
const cfg = await eng.upsertReviewConfig(ws.id, { site: "google", reviewUrl: "https://g.page/example/review", delayDays: 0, enabled: true });
check("R1 review config upserted", cfg.site === "google" && cfg.enabled === true && cfg.delayDays === 0);
const active = await eng.activeReviewConfig(ws.id);
check("R2 active config resolves google URL", active.reviewUrl.includes("g.page"));

// Consent-gated send: no consent → ReviewEngineError, no token minted.
let blockedErr: unknown = null;
try {
  await eng.sendReviewRequest({ workspaceId: ws.id, leadId: lead.id, channel: "sms", origin: "http://localhost:3000" });
} catch (e) { blockedErr = e; }
check("R3 no-consent review request blocked", blockedErr instanceof eng.ReviewEngineError && (blockedErr as { code: string }).code === "suppressed");
const noReqs = await eng.listReviewRequests(ws.id, {});
check("R4 no request row on blocked send", noReqs.length === 0);

// Opt in → request created + message queued behind approval.
await consent.setConsent(ws.id, lead.id, "sms", "opted_in", "battery");
const res = await eng.sendReviewRequest({ workspaceId: ws.id, leadId: lead.id, channel: "sms", origin: "http://localhost:3000", delayDays: 0 });
check("R5 review request created", !!res.reviewRequest.id && !!res.reviewRequest.token);
check("R6 page URL shaped", res.pageUrl === `http://localhost:3000/r/review/${res.reviewRequest.token}`);
check("R7 message queued with pending approval", res.message.status === "queued" && res.approval.status === "pending");
const token: string = res.reviewRequest.token;

// Approval gate: dispatch before approval must not send.
await disp.dispatchDue(ws.id);
const stillQueued = await prisma.outboundMessage.findUnique({ where: { id: res.message.id } });
check("R8 unapproved review SMS not dispatched", stillQueued?.status === "queued", `status=${stillQueued?.status}`);

// Approve → dispatch → sent via fake SMS.
await disp.decideApproval(res.approval.id, ws.id, "approve", "battery");
await disp.dispatchDue(ws.id);
const sentMsg = await prisma.outboundMessage.findUnique({ where: { id: res.message.id } });
check("R9 approved review SMS dispatched", sentMsg?.status === "sent" || sentMsg?.status === "delivered", `status=${sentMsg?.status}`);

// QR page flow: view → complete.
check("R10 reviewPageUrl helper", eng.reviewPageUrl("http://localhost:3000", token) === res.pageUrl);
await eng.markViewedByToken(token);
const viewed = await eng.getRequestByToken(token);
check("R11 viewed tracked", (viewed as { status: string }).status === "viewed");
await eng.markCompletedByToken(token);
const done = await eng.getRequestByToken(token);
check("R12 completed tracked", (done as { status: string }).status === "completed");
const qr = await eng.requestQrDataUrl("http://localhost:3000", token);
check("R13 QR data URL generated", qr.startsWith("data:image/png;base64,"));

// Funnel stats reflect the flow (statuses are terminal: completed absorbs viewed).
const funnel = await eng.funnelStats(ws.id);
check("R14 funnel counts", funnel.sent >= 1 && funnel.completed >= 1 && funnel.completionRate === 100, JSON.stringify(funnel));

// Expired-token path.
const expired = await eng.getRequestByToken("nope-not-a-token").catch(() => null);
check("R15 unknown token → null", expired === null);

// AI responder: draft behind approval.
const review = await prisma.review.create({
  data: { projectId: project.id, externalId: `ext-${RUN}`, businessName: "Example Co", author: "Sam", rating: 5, text: "Great service, highly recommend!" },
});
const draft = await resp.draftReviewResponse(ws.id, review.id);
check("R16 response draft generated", typeof draft.draftBody === "string" && draft.draftBody.length > 10);
check("R17 draft gated behind pending approval", draft.approval.status === "pending" && draft.approval.kind === "review_response");
await disp.decideApproval(draft.approval.id, ws.id, "approve", "battery");
const appr2 = await prisma.approvalItem.findUnique({ where: { id: draft.approval.id } });
check("R18 approval recorded", appr2?.status === "approved");
await resp.recordManualPost(ws.id, review.id, { postedBy: "battery" });
const reviewed = await prisma.review.findUnique({ where: { id: review.id } });
check("R19 review marked responded", reviewed?.responded === true);

// Cross-workspace: lead from another workspace cannot be targeted.
const ws2 = await prisma.workspace.create({ data: { name: tag("ws2"), ownerUserId: `battery-${process.pid}` } });
let crossErr: unknown = null;
try {
  await eng.sendReviewRequest({ workspaceId: ws2.id, leadId: lead.id, channel: "sms", origin: "http://localhost:3000" });
} catch (e) { crossErr = e; }
check("R20 cross-workspace lead send blocked", crossErr instanceof eng.ReviewEngineError);
const ws2reqs = await eng.listReviewRequests(ws2.id, {});
check("R21 workspace B sees no review requests", ws2reqs.length === 0);
let crossDraft: unknown = null;
try { await resp.draftReviewResponse(ws2.id, review.id); } catch (e) { crossDraft = e; }
check("R22 cross-workspace review draft blocked", crossDraft instanceof resp.ResponderError);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log("FAILURES:", failures.join(", ")); await prisma.$disconnect(); process.exit(1); }
await prisma.$disconnect();
