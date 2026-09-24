// Marketr — R6 prospecting & enrichment battery (Phase 3).
//
// Run: DATABASE_URL=<fresh-db> npx tsx scripts/verify-r6-prospecting.mts
// Run 3x green before calling this done.
//
// Covers:
//   - estimateRunCost (pure): ack threshold, capping, unknown providers
//   - Waterfall: ordered chain, stop-at-first-hit, per-lookup metering,
//     EnrichmentLookup audit rows, score bonus, tenant isolation
//   - ICP list building: ProspectList + prospects
//   - AI research: icebreakers/first lines persisted, metered, mock-labeled
//   - CRM sync: prospect → lead (enrichment badge, score bonus, timeline)
//   - R3 path: lead → sequence enrollment → approval gate → dispatch (fake)
//   - C2: revenue attributed back to the prospecting list campaign
//   - Tenant isolation throughout
//
// Strategy: exercise the real lib modules directly on a fresh database.
// Each run uses uniquely-named workspaces so runs never interfere.

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(2);
}

import { randomUUID } from "node:crypto";
import type { EnrichmentProvider, EnrichmentResult } from "@/lib/enrichment/provider";

const { prisma } = await import("@/lib/prisma");
const wf = await import("@/lib/enrichment/waterfall");
const research = await import("@/lib/enrichment/research");
const crmSync = await import("@/lib/enrichment/crm-sync");
const prov = await import("@/lib/enrichment/provider");
const seq = await import("@/lib/messaging/sequences");
const disp = await import("@/lib/messaging/dispatcher");
const consent = await import("@/lib/messaging/consent");
const qh = await import("@/lib/messaging/quiet-hours");
const touches = await import("@/lib/attribution/touches");
const revenue = await import("@/lib/attribution/revenue");
const report = await import("@/lib/attribution/report");
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

const RUN = `zz-r6-${Date.now()}-${process.pid}`;
const tag = (s: string) => `${RUN}-${s}`;

async function makeWorkspace(name: string) {
  return prisma.workspace.create({ data: { name: tag(name), ownerUserId: `battery-${process.pid}` } });
}

async function makePipeline(workspaceId: string) {
  return prisma.pipeline.create({
    data: { workspaceId, name: tag("pipe"), stages: stages.DEFAULT_STAGES as never, isDefault: true },
  });
}

// A provider that always misses — used to prove ordering + stop-at-first-hit.
class MissProvider implements EnrichmentProvider {
  readonly name = "missy";
  async lookup(): Promise<EnrichmentResult> {
    return { hit: false, costCents: 3, raw: { why: "test-miss" } };
  }
}

// --- A. estimateRunCost (pure function) -------------------------------------
{
  const e1 = wf.estimateRunCost("ws", 5);
  check("A1 estimate: small fake run needs no ack", e1.requiresAck === false && e1.estimatedTotalUsd === 0);
  check("A2 estimate: default chain is fake-only", JSON.stringify(e1.providerChain) === JSON.stringify(["fake"]));

  const e2 = wf.estimateRunCost("ws", 101, ["fake", "apollo"]);
  check("A3 estimate: >100 prospects requires ack", e2.requiresAck === true);
  check("A4 estimate: breakdown has per-provider costs", e2.breakdown.length === 2 && e2.breakdown[1].provider === "apollo" && e2.breakdown[1].perLookupUsd === 0.05);

  const e3 = wf.estimateRunCost("ws", 100000);
  check("A5 estimate: capped at MAX_PROSPECTS_PER_RUN", e3.prospectCount === wf.MAX_PROSPECTS_PER_RUN);

  const e4 = wf.estimateRunCost("ws", -5);
  check("A6 estimate: negative count → 0", e4.prospectCount === 0);

  const e5 = wf.estimateRunCost("ws", 10, ["nope"]);
  check("A7 estimate: unknown provider → $0 cost", e5.perProspectUsd === 0 && e5.estimatedTotalUsd === 0);

  // Quiet-hour math (fixed 2026-09-24: non-wrapping windows always read quiet).
  const d18 = new Date("2026-09-24T22:00:00Z"); // 18:00 EDT
  const d0230 = new Date("2026-09-25T06:30:00Z"); // 02:30 EDT
  check("A8 quiet: 18:00 not quiet in 02:00–03:00 window", qh.isQuietHour(d18, "America/New_York", 2, 3) === false);
  check("A9 quiet: 02:30 quiet in 02:00–03:00 window", qh.isQuietHour(d0230, "America/New_York", 2, 3) === true);
  check("A10 quiet: 22:00 ET quiet in 21:00–08:00 window", qh.isQuietHour(new Date("2026-09-25T02:00:00Z"), "America/New_York", 21, 8) === true);
  check("A11 quiet: 12:00 ET not quiet in 21:00–08:00 window", qh.isQuietHour(new Date("2026-09-24T16:00:00Z"), "America/New_York", 21, 8) === false);
  check("A12 quiet: degenerate window never quiet", qh.isQuietHour(d0230, "America/New_York", 3, 3) === false);
}

// --- Setup: two workspaces ---------------------------------------------------
const wsA = await makeWorkspace("a");
const wsB = await makeWorkspace("b");
const pipeA = await makePipeline(wsA.id);
check("B0 workspaces + pipeline created", !!(wsA.id && wsB.id && pipeA.id));

// Seed a credit pool: fresh workspaces start at 0 included credits, so
// seed like a paid plan to exercise the metering ledger honestly.
await prisma.creditBalance.create({
  data: { workspaceId: wsA.id, includedCredits: 100000, purchasedCredits: 0, usedCredits: 0, periodStart: new Date() },
});

// Quiet hours far from any real run time so dispatch isn't deferred.
await qh.updateMessagingSettings(wsA.id, { quietStart: 2, quietEnd: 3, timezone: "America/New_York" });

// --- B. ICP list building ----------------------------------------------------
const list = await prisma.prospectList.create({
  data: {
    workspaceId: wsA.id,
    name: tag("icp-list"),
    status: "ready",
    icp: { industries: ["SaaS / Software"], employeeRange: "11-50", geo: "US", titles: ["VP Marketing"] },
  },
});
check("B1 ProspectList created with ICP persisted", (list.icp as Record<string, unknown>).geo === "US");

const mkProspect = (email: string, name: string, company: string, listId = list.id, wsId = wsA.id) =>
  prisma.prospect.create({
    data: { workspaceId: wsId, listId, email, name, company, website: "https://example.com", dedupKey: `email:${email.toLowerCase()}:${randomUUID().slice(0, 8)}` },
  });

const p1 = await mkProspect("dana@example.com", "Dana Reyes", "Reyes Logistics");
check("B2 prospect created in list", p1.status === "new" && p1.listId === list.id);

// --- C. Waterfall: stop-at-first-hit, ordering, metering ---------------------
const r1 = await wf.runWaterfall(wsA.id, p1.id, [new MissProvider(), new prov.FakeEnrichmentProvider()]);
check("C1 waterfall enriched via fake after miss", r1.status === "enriched" && r1.hitProvider === "fake");
check("C2 waterfall attempted providers in order", r1.attempts.length === 2 && r1.attempts[0].provider === "missy" && r1.attempts[1].provider === "fake");
check("C3 attempts carry statuses", r1.attempts[0].status === "miss" && r1.attempts[1].status === "hit");

const lookups1 = await prisma.enrichmentLookup.findMany({ where: { prospectId: p1.id }, orderBy: { createdAt: "asc" } });
check("C4 EnrichmentLookup audit rows written", lookups1.length === 2 && lookups1[0].status === "miss" && lookups1[1].status === "hit");

const p2 = await mkProspect("evan@example.com", "Evan Cole", "Cole Freight");
const r2 = await wf.runWaterfall(wsA.id, p2.id, [new prov.FakeEnrichmentProvider(), new MissProvider()]);
check("C5 stop-at-first-hit: second provider never attempted", r2.attempts.length === 1 && r2.hitProvider === "fake");
const lookups2 = await prisma.enrichmentLookup.findMany({ where: { prospectId: p2.id } });
check("C6 stop-at-first-hit persisted: exactly one lookup row", lookups2.length === 1);

const meterRows = await prisma.usageEvent.findMany({ where: { workspaceId: wsA.id, action: "enrichment_lookup" } });
check("C7 per-lookup metering recorded in ledger", meterRows.length >= 3, `got ${meterRows.length}`);
check("C8 metering rows carry evidence refs", meterRows.every((m) => (m.evidenceRef ?? "").startsWith("prospect:")));

const p1After = await prisma.prospect.findUnique({ where: { id: p1.id } });
check("C9 prospect status → enriched", p1After?.status === "enriched");
check("C10 enrichment score bonus applied", (p1After?.score ?? 0) === wf.ENRICHMENT_HIT_SCORE_BONUS, `score=${p1After?.score}`);
const ed = (p1After?.enrichmentData ?? {}) as Record<string, unknown>;
check("C11 enrichmentData has company + hit provider", !!(ed.company as Record<string, unknown>)?.name && ed.lastHitProvider === "fake");

// No-signal prospect → failed, miss path, Json null result (the tsc fix).
const p3 = await prisma.prospect.create({ data: { workspaceId: wsA.id, listId: list.id, dedupKey: `email:nosignal-${RUN}@x.com` } });
const r3 = await wf.runWaterfall(wsA.id, p3.id, [new prov.FakeEnrichmentProvider()]);
check("C12 no-signal prospect → failed", r3.status === "failed" && r3.hitProvider === null);
const lookups3 = await prisma.enrichmentLookup.findMany({ where: { prospectId: p3.id } });
check("C13 miss lookup row persisted (DbNull result)", lookups3.length === 1 && lookups3[0].status === "miss");

// Tenant isolation on the waterfall itself.
let crossThrew = false;
try {
  await wf.runWaterfall(wsB.id, p1.id, [new prov.FakeEnrichmentProvider()]);
} catch {
  crossThrew = true;
}
check("C14 cross-workspace waterfall throws", crossThrew);
const bProspects = await prisma.prospect.findMany({ where: { workspaceId: wsB.id } });
check("C15 workspace B sees zero prospects", bProspects.length === 0);

// --- D. AI research -----------------------------------------------------------
const res = await research.researchProspect(wsA.id, p1.id);
check("D1 research returns icebreakers + first lines", res.icebreakers.length > 0 && res.firstLines.length > 0);
check("D2 research summary non-empty", res.summary.trim().length > 20);
check("D3 research mock-labeled without LLM key", res.mock === true && res.model === "mock");
const p1Res = await prisma.prospect.findUnique({ where: { id: p1.id }, select: { research: true } });
check("D4 research persisted on prospect", !!((p1Res?.research ?? {}) as Record<string, unknown>).summary);
const resMeter = await prisma.usageEvent.findMany({ where: { workspaceId: wsA.id, action: "prospect_research" } });
check("D5 research metered exactly once", resMeter.length === 1, `got ${resMeter.length}`);

// --- E. CRM sync: prospect → lead --------------------------------------------
const { lead } = await crmSync.convertToLead(wsA.id, p1.id);
check("E1 lead created from prospect", !!lead.id);
check("E2 lead sourceDetail names the prospecting list", lead.sourceDetail === `Prospecting list: ${list.name}`);
check("E3 enrichment badge in customFields", (lead.customFields as Record<string, unknown>)?.enrichmentProvider === "fake" && (lead.customFields as Record<string, unknown>)?.prospectId === p1.id);
check("E4 conversion score bonus applied", lead.score >= crmSync.CONVERSION_SCORE_BONUS, `score=${lead.score}`);
const acts = await prisma.leadActivity.findMany({ where: { leadId: lead.id } });
check("E5 timeline: enriched + converted entries", acts.some((a) => (a.body ?? "").includes("Enriched via fake")) && acts.some((a) => (a.body ?? "").includes("Converted from prospect list")));
const p1Conv = await prisma.prospect.findUnique({ where: { id: p1.id } });
check("E6 prospect marked converted + linked", p1Conv?.status === "converted" && p1Conv?.leadId === lead.id);

// Dedup: second prospect with same email links the existing lead.
const pDup = await mkProspect("dana@example.com", "Dana R.", "Reyes Logistics LLC");
const dupRes = await crmSync.convertToLead(wsA.id, pDup.id);
const leadCount = await prisma.lead.count({ where: { workspaceId: wsA.id, email: "dana@example.com" } });
check("E7 dedup: no duplicate lead created", dupRes.linkedExisting === true && leadCount === 1);

// --- F. R3 outbound path: enrollment → approval gate → dispatch -------------
const sequence = await prisma.nurtureSequence.create({
  data: {
    workspaceId: wsA.id,
    name: tag("seq"),
    status: "active",
    approvalPolicy: "manual",
    steps: [{ channel: "email", delayMinutes: 0, subject: "Quick intro", template: "Hi {{firstName}}, saw {{company}} — worth a chat?" }],
  },
});
check("F1 nurture sequence created", sequence.status === "active");

// Consent gate: no consent → message suppressed, never sent.
const enr0 = await seq.enrollLead(wsA.id, sequence.id, lead.id);
check("F2 lead enrolled in sequence", !!enr0.enrollmentId && enr0.alreadyEnrolled === false);
await seq.advanceEnrollments(wsA.id);
const suppressed = await prisma.outboundMessage.findMany({ where: { workspaceId: wsA.id, leadId: lead.id }, orderBy: { createdAt: "desc" } });
check("F3 no-consent → suppressed (no_consent)", suppressed.length > 0 && suppressed[0].status === "suppressed", `status=${suppressed[0]?.status}`);

// Opt in, re-enroll fresh path: new lead for the clean dispatch assertions.
const p4 = await mkProspect("fiona@example.com", "Fiona Park", "Park Supply Co");
await wf.runWaterfall(wsA.id, p4.id, [new prov.FakeEnrichmentProvider()]);
const { lead: lead2 } = await crmSync.convertToLead(wsA.id, p4.id);
await consent.setConsent(wsA.id, lead2.id, "email", "opted_in", "battery");
check("F4 consent opted_in recorded", (await consent.getConsent(wsA.id, lead2.id, "email")) === "opted_in");

const enr = await seq.enrollLead(wsA.id, sequence.id, lead2.id);
check("F5 second lead enrolled", !!enr.enrollmentId);
await seq.advanceEnrollments(wsA.id);
const approval = await prisma.approvalItem.findFirst({
  where: { workspaceId: wsA.id, kind: "sequence_send" },
  orderBy: { createdAt: "desc" },
});
check("F6 approval item opened (pending)", !!approval && approval.status === "pending");
const queued = await prisma.outboundMessage.findFirst({
  where: { workspaceId: wsA.id, leadId: lead2.id },
  orderBy: { createdAt: "desc" },
});
check("F7 message queued awaiting approval", !!queued && queued.status === "queued");

// Approval gate: dispatch BEFORE approval must not send.
await disp.dispatchDue(wsA.id);
const stillQueued = await prisma.outboundMessage.findUnique({ where: { id: queued!.id } });
check("F8 unapproved message NOT dispatched", stillQueued?.status === "queued", `status=${stillQueued?.status}`);

// Approve → dispatch → sent via fake provider, metered.
await disp.decideApproval(approval!.id, wsA.id, "approve", "battery");
await disp.dispatchDue(wsA.id);
const sent = await prisma.outboundMessage.findUnique({ where: { id: queued!.id } });
check("F9 approved message dispatched (sent/delivered)", sent?.status === "sent" || sent?.status === "delivered", `status=${sent?.status}`);
check("F10 fake provider recorded", (sent?.provider ?? "") === "fake");
const msgMeter = await prisma.usageEvent.findMany({ where: { workspaceId: wsA.id, action: "email_send" } });
check("F11 outbound email metered", msgMeter.length >= 1, `got ${msgMeter.length}`);

// Enrollment advanced past step 0 → completed (single-step sequence).
const enrAfter = await prisma.sequenceEnrollment.findUnique({ where: { id: enr.enrollmentId } });
check("F12 enrollment completed after dispatch", enrAfter?.status === "completed");

// Opt-out suppression: opted-out lead never sends.
const p5 = await mkProspect("gus@example.com", "Gus Hall", "Hall Metals");
await wf.runWaterfall(wsA.id, p5.id, [new prov.FakeEnrichmentProvider()]);
const { lead: lead3 } = await crmSync.convertToLead(wsA.id, p5.id);
await consent.setConsent(wsA.id, lead3.id, "email", "opted_out", "battery");
const blocked = await disp.queueMessage({
  workspaceId: wsA.id,
  leadId: lead3.id,
  channel: "email",
  kind: "sequence",
  subject: "Hi",
  body: "should never send",
});
check("F13 opted-out lead → suppressed (opt_out)", blocked.status === "suppressed");

// --- G. C2 attribution: revenue back to the prospecting source ---------------
await touches.logTouch({
  workspaceId: wsA.id,
  leadId: lead2.id,
  channel: "import",
  source: "prospecting",
  campaign: `Prospecting list: ${list.name}`,
  touchType: "first",
});
const before = { stage: lead2.stage, valueCents: lead2.valueCents };
await prisma.lead.update({ where: { id: lead2.id }, data: { stage: "won", valueCents: 50000 } });
const revRecorded = await revenue.maybeRecordWonRevenue({
  workspaceId: wsA.id,
  leadId: lead2.id,
  before,
  after: { stage: "won", valueCents: 50000 },
  actor: "battery",
});
check("G1 won revenue recorded on prospect-sourced lead", revRecorded === true);
const attr = await report.getAttributionReport(wsA.id, {});
const models = attr.report as unknown as Record<string, { channels: Array<{ channel: string; revenueCents: number }>; campaigns: Array<{ channel: string; campaign: string | null; revenueCents: number }> }>;
// Note: createLeadRecord logs an automatic capture touch (channel=import,
// campaign=null) at conversion, so it owns first-touch. The explicit
// prospecting touch shares credit under the linear model: 2 touches →
// $25,000 each.
const linear = models.linear;
const camp = linear.campaigns.find((c) => c.campaign === `Prospecting list: ${list.name}`);
check("G2 revenue attributed to prospecting list campaign (linear)", (camp?.revenueCents ?? 0) === 25000, `got ${camp?.revenueCents}`);
const chan = models.first_touch.channels.find((c) => c.channel === "import");
check("G3 revenue attributed to import channel", (chan?.revenueCents ?? 0) >= 50000, `got ${chan?.revenueCents}`);

// --- H. Tenant isolation ------------------------------------------------------
const crossLead = await prisma.lead.findFirst({ where: { id: lead2.id, workspaceId: wsB.id } });
check("H1 workspace B cannot read A's lead", crossLead === null);
const bLists = await prisma.prospectList.findMany({ where: { workspaceId: wsB.id } });
check("H2 workspace B has no prospect lists", bLists.length === 0);
const bLookups = await prisma.enrichmentLookup.findMany({ where: { workspaceId: wsB.id } });
check("H3 workspace B has no enrichment lookups", bLookups.length === 0);
const bUsage = await prisma.usageEvent.findMany({ where: { workspaceId: wsB.id } });
check("H4 workspace B has no metered usage", bUsage.length === 0);
const bApprovals = await prisma.approvalItem.findMany({ where: { workspaceId: wsB.id } });
check("H5 workspace B has no approval items", bApprovals.length === 0);

// --- Summary ------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:", failures.join(", "));
  await prisma.$disconnect();
  process.exit(1);
}
await prisma.$disconnect();
