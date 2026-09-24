// Marketr — Revenue attribution adversarial battery (Phase 2, C2).
//
// Run: DATABASE_URL=<redacted> npx tsx scripts/verify-attribution.mts
// Run 3x green on fresh DBs before calling this done.
//
// Covers:
//   A1 exact credit split (A/B/C, $300): first→A $300, last→C $300,
//      linear→$100/$100/$100 — at both the unit level (creditByModel) and
//      the report level (computeReport via getAttributionReport).
//   A2 remainder-cent preservation: $1.00 split 3 ways = 34/33/33.
//   A3 UTM capture: lead POST (createLeadRecord), public form
//      (handlePublicSubmit), CSV import (processImportRows) all record the
//      creation touch with channel/campaign from UTMs.
//   A4 won-transition revenue: moving a lead to Won records a revenue
//      activity; creating directly in Won records one; a repeated Won
//      update records no duplicate.
//   A5 touch dedup: duplicate submissions collapse via (leadId, dedupHash).
//   A6 tenant isolation: cross-workspace touch write/read blocked,
//      cross-workspace spend read/write blocked, foreign lead/content
//      association blocked.
//   A7 spend CRUD: tenant-scoped create/update/delete; overlap dedupe.
//   A8 CPL/CAC/ROAS math incl. $0-spend channels → null ratios.
//   A9 campaign + content attribution; content linked to workspace-owned
//      ContentItem pages only.
//   A10 timeline ordering (MIRROR of the route's where/orderBy).
//
// Strategy: exercise the real lib modules; route thin wrappers are mirrored
// where marked MIRROR. Each run uses uniquely-tagged workspaces.

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(2);
}

import { randomUUID } from "node:crypto";

const { prisma } = await import("@/lib/prisma");
const stages = await import("@/lib/crm/stages");
const dedup = await import("@/lib/crm/dedup");
const pubform = await import("@/lib/crm/public-form");
const { processImportRows } = await import("@/app/api/crm/leads/import/route");
const { createLeadRecord } = await import("@/lib/crm/leads");
const touchesLib = await import("@/lib/attribution/touches");
const modelsLib = await import("@/lib/attribution/models");
const revenueLib = await import("@/lib/attribution/revenue");
const spendLib = await import("@/lib/attribution/spend");
const reportLib = await import("@/lib/attribution/report");

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

const RUN = `zz-attr-battery-${Date.now()}-${process.pid}`;
const tag = (s: string) => `${RUN}-${s}`;

async function makeWorkspace() {
  return prisma.workspace.create({
    data: { name: tag("ws"), ownerUserId: `battery-${process.pid}` },
  });
}
async function makePipeline(workspaceId: string, name: string) {
  return prisma.pipeline.create({
    data: { workspaceId, name, stages: stages.DEFAULT_STAGES as never },
  });
}
async function makeContentItem(workspaceId: string, url: string) {
  const project = await prisma.project.create({
    data: { workspaceId, domain: tag("example.com") },
  });
  return prisma.contentItem.create({
    data: { projectId: project.id, publishedUrl: url },
  });
}

async function mustCreate(workspaceId: string, actor: string, input: Parameters<typeof createLeadRecord>[2]) {
  const res = await createLeadRecord(workspaceId, actor, input);
  if (!res.ok) throw new Error(`createLeadRecord failed: ${res.error}`);
  return res.lead;
}

const wsA = await makeWorkspace();
const wsB = await makeWorkspace();
const pipeA = await makePipeline(wsA.id, tag("pipe-a"));
const pipeB = await makePipeline(wsB.id, tag("pipe-b"));

// ── A1/A2: model credit math ─────────────────────────────────────────────────
{
  const mt = (id: string, channel: string, campaign: string | null = null): any => ({
    id, leadId: "lead-x", channel, campaign, contentId: null, occurredAt: new Date(),
  });
  const t = [mt("a", "paid_search", "q3"), mt("b", "organic"), mt("c", "referral", "q3")];
  const c = modelsLib.creditByModel(t, 30000);
  check("unit: first-touch credits A $300 only",
    c.first_touch[0] === 30000 && c.first_touch[1] === 0 && c.first_touch[2] === 0,
    JSON.stringify(c.first_touch));
  check("unit: last-touch credits C $300 only",
    c.last_touch[0] === 0 && c.last_touch[1] === 0 && c.last_touch[2] === 30000,
    JSON.stringify(c.last_touch));
  check("unit: linear splits $300 into $100/$100/$100",
    c.linear[0] === 10000 && c.linear[1] === 10000 && c.linear[2] === 10000,
    JSON.stringify(c.linear));

  const r = modelsLib.splitRevenue(100, 3);
  check("remainder cents preserved: $1.00/3 = 34/33/33",
    r[0] === 34 && r[1] === 33 && r[2] === 33 && r.reduce((x, y) => x + y, 0) === 100,
    JSON.stringify(r));

  // Report level: one lead, three ordered touches, won at $300.
  const ws = await makeWorkspace();
  const pipe = await makePipeline(ws.id, tag("pipe-report"));
  const lead = await prisma.lead.create({
    data: {
      workspaceId: ws.id, pipelineId: pipe.id, name: tag("abc-lead"),
      stage: "won", valueCents: 30000, source: "import",
      dedupKey: dedup.dedupKeyFor(tag("a@x.com"), null),
    },
  });
  const base = new Date("2026-08-01T10:00:00Z");
  for (const [i, ch] of (["paid_search", "organic", "referral"] as const).entries()) {
    await touchesLib.logTouch({
      workspaceId: ws.id, leadId: lead.id, channel: ch,
      touchType: "visit", occurredAt: new Date(base.getTime() + i * 3_600_000),
    });
  }
  const { report } = await reportLib.getAttributionReport(ws.id, {});
  const chOf = (m: keyof typeof report, channel: string) =>
    report[m].channels.find((x: any) => x.channel === channel);
  check("report: linear gives each channel $100",
    chOf("linear", "paid_search")?.revenueCents === 10000 &&
    chOf("linear", "organic")?.revenueCents === 10000 &&
    chOf("linear", "referral")?.revenueCents === 10000,
    JSON.stringify(report.linear.channels.map((x: any) => [x.channel, x.revenueCents])));
  check("report: first-touch gives paid_search $300",
    chOf("first_touch", "paid_search")?.revenueCents === 30000 &&
    chOf("first_touch", "organic")?.revenueCents === 0,
    JSON.stringify(report.first_touch.channels.map((x: any) => [x.channel, x.revenueCents])));
  check("report: last-touch gives referral $300",
    chOf("last_touch", "referral")?.revenueCents === 30000 &&
    chOf("last_touch", "paid_search")?.revenueCents === 0,
    JSON.stringify(report.last_touch.channels.map((x: any) => [x.channel, x.revenueCents])));
  check("report: totals attributed revenue = $300 under all models",
    report.linear.totals.attributedRevenueCents === 30000 &&
    report.first_touch.totals.attributedRevenueCents === 30000 &&
    report.last_touch.totals.attributedRevenueCents === 30000);
}

// ── A3: UTM capture on all three paths ────────────────────────────────────────
{
  const utm = {
    utm_source: "google", utm_medium: "cpc", utm_campaign: "brand-q3", utm_content: "ad1",
  };
  // 1) lead POST (createLeadRecord)
  const l1 = await mustCreate(wsA.id, tag("tester"), {
    pipelineId: pipeA.id, name: tag("post-lead"), source: "website_form", utm,
  });
  const t1 = await prisma.attributionTouch.findFirst({ where: { leadId: l1.id } });
  check("lead POST records a capture touch",
    !!t1 && t1.channel === "paid_search" && t1.campaign === "brand-q3" && t1.touchType === "first",
    JSON.stringify(t1 ? [t1.channel, t1.campaign, t1.touchType] : null));

  // 2) public form (handlePublicSubmit)
  pubform.resetPublicFormLimiter();
  const { token, prefix } = dedup.newFormToken();
  await prisma.leadCaptureForm.create({
    data: {
      workspaceId: wsA.id, pipelineId: pipeA.id, name: tag("form"),
      tokenHash: dedup.hashFormToken(token), tokenPrefix: prefix,
    },
  });
  const res = await pubform.handlePublicSubmit({
    token,
    rawBody: JSON.stringify({
      name: tag("public-lead"), email: tag("pub@example.com"), utm,
    }),
    ip: "9.9.9.9",
  });
  check("public form accepts submission", res.status === 201, String(res.status));
  const pubLead = await prisma.lead.findFirst({
    where: { workspaceId: wsA.id, email: tag("pub@example.com") },
  });
  const t2 = pubLead
    ? await prisma.attributionTouch.findFirst({ where: { leadId: pubLead.id } })
    : null;
  check("public form records a capture touch",
    !!t2 && t2.channel === "paid_search" && t2.campaign === "brand-q3",
    JSON.stringify(t2 ? [t2.channel, t2.campaign] : null));

  // 3) CSV import (processImportRows)
  const csvRows = [
    ["name", "email", "utm_source", "utm_medium", "utm_campaign", "utm_content", "content_id"],
    [tag("csv-lead"), tag("csv@example.com"), "google", "cpc", "brand-q3", "ad1", ""],
  ];
  const imp = await processImportRows(wsA.id, tag("importer"), pipeA, csvRows);
  check("csv import creates the lead", imp.created === 1, JSON.stringify(imp));
  const csvLead = await prisma.lead.findFirst({
    where: { workspaceId: wsA.id, email: tag("csv@example.com") },
  });
  const t3 = csvLead && await prisma.attributionTouch.findFirst({ where: { leadId: csvLead.id } });
  check("csv import records a capture touch with UTMs",
    !!t3 && t3.channel === "paid_search" && t3.campaign === "brand-q3",
    JSON.stringify(t3 ? [t3.channel, t3.campaign] : null));
  // CSV dedup preserved.
  const imp2 = await processImportRows(wsA.id, tag("importer"), pipeA, csvRows);
  check("csv import dedups re-imported rows",
    imp2.created === 0 && imp2.duplicates.length === 1, JSON.stringify(imp2));
}

// ── A4: won-transition revenue events ─────────────────────────────────────────
{
  // Move to won → revenue activity.
  const l = await mustCreate(wsA.id, tag("tester"), {
    pipelineId: pipeA.id, name: tag("won-move"), source: "import", valueCents: 50000,
  });
  await revenueLib.maybeRecordWonRevenue({
    workspaceId: wsA.id, leadId: l.id, actor: tag("tester"),
    before: { stage: "qualified", valueCents: 50000 },
    after: { stage: "won", valueCents: 50000 },
  });
  const acts = await prisma.leadActivity.findMany({
    where: { leadId: l.id, type: "revenue" },
  });
  check("won transition records one revenue activity",
    acts.length === 1 && (acts[0]?.body?.includes("$500") ?? false),
    JSON.stringify(acts.map((a) => a.body)));

  // Repeated won update → no duplicate.
  await revenueLib.maybeRecordWonRevenue({
    workspaceId: wsA.id, leadId: l.id, actor: tag("tester"),
    before: { stage: "won", valueCents: 50000 },
    after: { stage: "won", valueCents: 50000 },
  });
  const acts2 = await prisma.leadActivity.count({
    where: { leadId: l.id, type: "revenue" },
  });
  check("repeated won update records no duplicate revenue", acts2 === 1);

  // Created directly in won → revenue activity via createLeadRecord.
  const l2 = await mustCreate(wsA.id, tag("tester"), {
    pipelineId: pipeA.id, name: tag("direct-won"), source: "import", stage: "won", valueCents: 75000,
  });
  const acts3 = await prisma.leadActivity.count({
    where: { leadId: l2.id, type: "revenue" },
  });
  check("lead created directly in won records revenue", acts3 === 1);

  // Lead with no touches → unattributed revenue bucket.
  const orphan = await prisma.lead.create({
    data: {
      workspaceId: wsA.id, pipelineId: pipeA.id, name: tag("orphan"),
      stage: "won", valueCents: 10000, source: "import",
      dedupKey: dedup.dedupKeyFor(tag("orphan@x.com"), null),
    },
  });
  const { report: repA } = await reportLib.getAttributionReport(wsA.id, {});
  const unattributed = (repA.linear.totals as any).unattributedRevenueCents as number;
  check("won lead with no touches lands in unattributed revenue",
    unattributed >= 10000, String(unattributed));
  void orphan;
}

// ── A5: touch dedup ───────────────────────────────────────────────────────────
{
  const l = await mustCreate(wsA.id, tag("tester"), {
    pipelineId: pipeA.id, name: tag("dedup-lead"), source: "import",
  });
  const when = new Date("2026-09-01T12:00:00Z");
  await touchesLib.logTouch({
    workspaceId: wsA.id, leadId: l.id, channel: "paid_search",
    source: "google", medium: "cpc", campaign: "brand-q3",
    touchType: "visit", occurredAt: when,
  });
  await touchesLib.logTouch({
    workspaceId: wsA.id, leadId: l.id, channel: "paid_search",
    source: "google", medium: "cpc", campaign: "brand-q3",
    touchType: "visit", occurredAt: when,
  });
  const n = await prisma.attributionTouch.count({
    where: { leadId: l.id, channel: "paid_search" },
  });
  check("duplicate touch submissions collapse to one row", n === 1, String(n));
}

// ── A6: tenant isolation ──────────────────────────────────────────────────────
{
  const leadB = await prisma.lead.create({
    data: {
      workspaceId: wsB.id, pipelineId: pipeB.id, name: tag("b-lead"),
      stage: "new", source: "import",
      dedupKey: dedup.dedupKeyFor(tag("b@x.com"), null),
    },
  });
  // Cross-workspace touch write.
  let blocked = false;
  try {
    await touchesLib.logTouch({
      workspaceId: wsA.id, leadId: leadB.id, channel: "paid_search", touchType: "manual",
    });
  } catch { blocked = true; }
  check("cross-workspace touch write blocked", blocked);

  // Cross-workspace touch read: report for wsA must not see wsB touches.
  await touchesLib.logTouch({
    workspaceId: wsB.id, leadId: leadB.id, channel: "zzz_foreign_ch", touchType: "manual",
  });
  const { report } = await reportLib.getAttributionReport(wsA.id, {});
  check("report for wsA excludes wsB touches",
    !report.linear.channels.some((c: any) => c.channel === "zzz_foreign_ch"));

  // Timeline MIRROR: lead lookup scoped by workspaceId.
  const mirrorLookup = await prisma.lead.findFirst({
    where: { id: leadB.id, workspaceId: wsA.id }, select: { id: true },
  });
  check("cross-workspace timeline lead lookup blocked", mirrorLookup === null);

  // Cross-workspace spend.
  const spendB = await spendLib.createSpend(wsB.id, {
    channel: "paid_search", amountCents: 99900,
    periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-09-30"),
  });
  const upd = await spendLib.updateSpend(wsA.id, spendB.id, { amountCents: 1 });
  check("cross-workspace spend update blocked", upd === null);
  const del = await spendLib.deleteSpend(wsA.id, spendB.id);
  check("cross-workspace spend delete blocked", del === false);
  const listA = await spendLib.listSpend(wsA.id);
  check("cross-workspace spend list excludes foreign rows",
    !listA.some((s) => s.id === spendB.id));

  // Foreign content association.
  const itemB = await makeContentItem(wsB.id, `https://${tag("b")}.example.com/p`);
  const leadA = await mustCreate(wsA.id, tag("tester"), {
    pipelineId: pipeA.id, name: tag("content-foreign"), source: "import",
  });
  let contentBlocked = false;
  try {
    await touchesLib.logTouch({
      workspaceId: wsA.id, leadId: leadA.id, channel: "organic",
      contentId: itemB.id, touchType: "visit",
    });
  } catch { contentBlocked = true; }
  check("foreign content association blocked", contentBlocked);
}

// ── A7: spend CRUD + overlap dedupe ───────────────────────────────────────────
{
  const s1 = await spendLib.createSpend(wsA.id, {
    channel: "paid_search", campaign: "q3", amountCents: 50000,
    periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-09-30"),
    notes: "test",
  });
  check("spend create returns the row", !!s1.id && s1.amountCents === 50000);
  const u1 = await spendLib.updateSpend(wsA.id, s1.id, { amountCents: 60000 });
  check("spend update changes amount", u1?.amountCents === 60000);
  // Overlapping duplicate (same channel+campaign) — report counts once.
  await spendLib.createSpend(wsA.id, {
    channel: "paid_search", campaign: "q3", amountCents: 70000,
    periodStart: new Date("2026-09-15"), periodEnd: new Date("2026-10-15"),
  });
  const { report } = await reportLib.getAttributionReport(wsA.id, {
    from: new Date("2026-09-01"), to: new Date("2026-09-30"),
  });
  const paid = report.linear.channels.find((c: any) => c.channel === "paid_search");
  check("overlapping spend rows counted once in report",
    paid?.spendCents === 60000, JSON.stringify(paid?.spendCents));
  const gone = await spendLib.deleteSpend(wsA.id, s1.id);
  check("spend delete removes the row", gone === true);
  const gone2 = await spendLib.deleteSpend(wsA.id, s1.id);
  check("deleting missing spend row returns false", gone2 === false);
  // Validation: bad input rejected by zod.
  const bad = spendLib.SpendInputSchema.safeParse({
    channel: "", amountCents: -5,
    periodStart: new Date(), periodEnd: new Date("2020-01-01"),
  });
  check("spend input validation rejects bad rows", !bad.success);
}

// ── A8: CPL / CAC / ROAS math ─────────────────────────────────────────────────
{
  const ws = await makeWorkspace();
  const pipe = await makePipeline(ws.id, tag("pipe-math"));
  const win = { from: new Date("2026-09-01"), to: new Date("2026-09-30") };
  // Two paid_search leads (one won $300), one organic lead (won $200).
  const mathCases = [
    { utm: { utm_source: "google", utm_medium: "cpc" }, won: true, value: 30000 },
    { utm: { utm_source: "google", utm_medium: "cpc" }, won: false, value: 0 },
    { utm: { utm_source: "organic" }, won: true, value: 20000 },
  ];
  for (const [i, c] of mathCases.entries()) {
    await mustCreate(ws.id, tag("tester"), {
      pipelineId: pipe.id,
      name: tag(`math-${i}`), source: "import",
      stage: c.won ? "won" : "new", valueCents: c.value,
      utm: c.utm,
    });
  }
  await spendLib.createSpend(ws.id, {
    channel: "paid_search", amountCents: 50000,
    periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-09-30"),
  });
  const { report } = await reportLib.getAttributionReport(ws.id, win);
  const t = report.linear.totals;
  check("CPL = spend / leads (500/3)", t.cplCents !== null && Math.abs(t.cplCents - 16667) <= 1,
    String(t.cplCents));
  check("CAC = spend / customers (500/2)", t.cacCents === 25000, String(t.cacCents));
  check("ROAS = revenue / spend (500/500)", t.roas === 1, String(t.roas));
  const org = report.linear.channels.find((c: any) => c.channel === "organic_search");
  check("$0 spend → null CPL/CAC/ROAS (no fake infinity)",
    !!org && org.cplCents === null && org.cacCents === null && org.roas === null,
    JSON.stringify(org));
}

// ── A9: campaign + content attribution ────────────────────────────────────────
{
  const ws = await makeWorkspace();
  const pipe = await makePipeline(ws.id, tag("pipe-content"));
  const item = await makeContentItem(ws.id, `https://${tag("a")}.example.com/guide`);
  await mustCreate(ws.id, tag("tester"), {
    pipelineId: pipe.id,
    name: tag("content-lead"), source: "import", stage: "won", valueCents: 90000,
    utm: { utm_source: "google", utm_medium: "cpc", utm_campaign: "brand-q3" },
    contentId: item.id,
  });
  const { report } = await reportLib.getAttributionReport(ws.id, {});
  const camp = report.linear.campaigns.find(
    (c: any) => c.channel === "paid_search" && c.campaign === "brand-q3",
  );
  check("campaign attribution: brand-q3 gets the $900",
    camp?.revenueCents === 90000, JSON.stringify(camp?.revenueCents));
  const items = await reportLib.getContentReport(ws.id, {}, "linear");
  const row = items.find((i: any) => i.contentId === item.id);
  check("content attribution: page gets $900 + URL linked",
    row?.revenueCents === 90000 && row?.publishedUrl === item.publishedUrl,
    JSON.stringify(row));
}

// ── A10: timeline ordering (MIRROR of the route) ──────────────────────────────
{
  const l = await mustCreate(wsA.id, tag("tester"), {
    pipelineId: pipeA.id, name: tag("timeline-lead"), source: "import",
  });
  // Insert out of order.
  const times = [
    new Date("2026-09-10T10:00:00Z"),
    new Date("2026-09-01T10:00:00Z"),
    new Date("2026-09-05T10:00:00Z"),
  ];
  for (const [i, when] of times.entries()) {
    await touchesLib.logTouch({
      workspaceId: wsA.id, leadId: l.id, channel: `ch_${i}`,
      touchType: "visit", occurredAt: when,
    });
  }
  // MIRROR of GET /api/attribution/timeline where/orderBy.
  const rows = await prisma.attributionTouch.findMany({
    where: { leadId: l.id, workspaceId: wsA.id },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    take: 1000,
  });
  const ordered = rows.map((r) => r.occurredAt.getTime());
  const sorted = [...ordered].sort((a, b) => a - b);
  check("timeline returns touches in ascending time order",
    ordered.every((v, i) => v === sorted[i]), JSON.stringify(ordered));
}

await prisma.$disconnect();

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log("Failures:", failures.join(", "));
  process.exit(1);
}
