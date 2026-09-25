// Marketr — Phase 8 G2 verification battery (SPEC-PHASE8.md §10 gate 2).
//
// Run: npx tsx scripts/verify-phase8-campaign.mts
// Run 3x green before calling this done.
//
// Covers:
//   A. Campaign CRUD (create with 12-stage pipeline, update, status)
//   B. Attach mail + outreach + media-buy fragments; stage pipeline reflects
//      all three; budget roll-up sums; stage-ref updates; surgical detach
//   C. Roll-up report: per-fragment provenance labels, no silent semantic
//      mismatch (no "conversions" total)
//   D. Hierarchy: 3 levels resolve; 4th rejected; cycle rejected
//   E. Messy historical fixtures -> proposals with match signals
//   F. Proposer creates ZERO links automatically
//   G. Expected-link precision >= 95%
//   H. Human confirmation gate: approve materializes link w/ provenance,
//      reject records negative signal (no re-proposal)
//   I. Fragment history untouched (checksums before/after)
//   J. RLS: cross-workspace reads blocked; fail-closed without the tenant GUC
//
// Strategy: a scratch database on the preview cluster (created/dropped by
// this script — the preview DB is never touched). Fragment tables are
// faithful stubs (exact DDL via pg_dump --schema-only from the preview DB,
// FKs dropped for seed simplicity) in scripts/phase8-campaign-stubs.sql,
// then the real G2 migration is applied on top (tables + RLS policies).
// Lib modules are imported AFTER process.env.DATABASE_URL points at scratch.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";

const execFileAsync = promisify(execFile);

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

async function expectCampaignError(name: string, fn: () => Promise<unknown>, code: string) {
  try {
    await fn();
    check(name, false, `expected CampaignError(${code}) but it succeeded`);
  } catch (e) {
    const ok = e instanceof Error && (e as { code?: string }).code === code;
    check(name, ok, ok ? "" : `wrong error: ${e instanceof Error ? `${e.name}(${e.message})` : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// DB bootstrap (no @/ imports yet — DATABASE_URL must point at scratch first)
// ---------------------------------------------------------------------------

type StageView = { key: string; status: string; linkedRefs: Array<{ linkedType: string; linkedId: string }> };
const stagesOf = (c: { stages: unknown }): StageView[] => (c.stages ?? []) as StageView[];

const PGBIN = `${process.env.HOME}/.local/lib/python3.12/site-packages/pgserver/pginstall/bin`;
const SCRATCH_DB = "marketr_campaign_battery";
const REPO = "/home/hatch/workspace/marketr";

function dbParts() {
  const env = readFileSync(`${REPO}/.env`, "utf8");
  const m = env.match(/^DATABASE_URL=(.+)$/m);
  if (!m) throw new Error("DATABASE_URL not found in .env");
  const raw = m[1].trim().replace(/^["']|["']$/g, "");
  const u = new URL(raw);
  return {
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    host: u.hostname,
    port: u.port || "5432",
  };
}

async function psql(db: string, sql: string): Promise<string> {
  const p = dbParts();
  const { stdout } = await execFileAsync(`${PGBIN}/psql`, [
    "-h", p.host, "-p", p.port, "-U", p.user, "-d", db,
    "-v", "ON_ERROR_STOP=1", "-tA", "-c", sql,
  ], { env: { ...process.env, PGPASSWORD: p.password } });
  return stdout.trim();
}

async function psqlFile(db: string, file: string) {
  const p = dbParts();
  await execFileAsync(`${PGBIN}/psql`, [
    "-h", p.host, "-p", p.port, "-U", p.user, "-d", db,
    "-v", "ON_ERROR_STOP=1", "-q", "-f", file,
  ], { env: { ...process.env, PGPASSWORD: p.password } });
}

const FRAGMENT_TABLES = [
  "mail_campaign", "outreach_campaigns", "outreach_sequences",
  "outreach_prospects", "outreach_events", "media_buys", "ctv_campaigns",
  "experiments", "recycling_briefs", "projects", "newsletter_broadcasts",
  "social_posts",
];

async function fragmentChecksum(db: string): Promise<string> {
  const parts: string[] = [];
  for (const t of FRAGMENT_TABLES) {
    const n = await psql(db, `SELECT count(*) FROM "${t}"`);
    const h = await psql(
      db,
      `SELECT coalesce(md5(string_agg(md5(t.*::text), ',' ORDER BY t.*::text)), 'empty') FROM "${t}" t`,
    );
    parts.push(`${t}:${n}:${h}`);
  }
  return parts.join("|");
}

async function setupScratchDb() {
  await psql(
    "postgres",
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${SCRATCH_DB}' AND pid <> pg_backend_pid()`,
  ).catch(() => "");
  await psql("postgres", `DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
  await psql("postgres", `CREATE DATABASE "${SCRATCH_DB}"`);
  // Faithful fragment-table stubs, then the real G2 migration (tables + RLS).
  await psqlFile(SCRATCH_DB, `${REPO}/scripts/phase8-campaign-stubs.sql`);
  await psqlFile(SCRATCH_DB, `${REPO}/prisma/migrations/20260925180000_phase8_campaign_object/migration.sql`);
  // Two fixture workspaces.
  for (const [id, name] of [["ws-a-fixture", "Battery WS A"], ["ws-b-other", "Battery WS B"]]) {
    await psql(SCRATCH_DB, `INSERT INTO workspaces (id, name, owner_user_id, updated_at) VALUES ('${id}', '${name}', 'battery', now())`);
  }
  const p = dbParts();
  return `postgresql://${encodeURIComponent(p.user)}:${encodeURIComponent(p.password)}@${p.host}:${p.port}/${SCRATCH_DB}`;
}

async function teardownScratchDb() {
  await psql("postgres", `DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
}

const WS_A = "ws-a-fixture";
const WS_B = "ws-b-other";

const scratchUrl = await setupScratchDb();
process.env.DATABASE_URL = scratchUrl;
console.log("scratch db ready:", SCRATCH_DB);

// ---------------------------------------------------------------------------
// Lib imports (after env is pointed at scratch)
// ---------------------------------------------------------------------------

const { prisma } = await import("@/lib/prisma");
const campaignStore = await import("@/lib/substrate/campaigns/store");
const { withCampaignScope } = await import("@/lib/substrate/campaigns/rls");
const { CAMPAIGN_STAGES } = await import("@/lib/substrate/campaigns/types");

const T = (s: string) => new Date(s);
const HOLIDAY = "Holiday 2026";

// ---------------------------------------------------------------------------
// Fixture seeding
// ---------------------------------------------------------------------------
console.log("\nSeeding fixtures");

// Project (hosts social posts) in WS_A
await prisma.project.create({
  data: { id: "proj-a", workspaceId: WS_A, domain: "acme.test", locale: "en-US", searchEngine: "google" },
});

// -- The three fragments the battery attaches manually --
await prisma.mailCampaign.create({
  data: {
    id: "mail-1", workspaceId: WS_A, name: `${HOLIDAY} — Direct Mail`,
    audienceSource: "csv", pieceCount: 10000, verifiedCount: 9500, quarantinedCount: 100,
    estCostCents: 60000, actualCostCents: 50000, status: "sent", createdAt: T("2026-09-08T10:00:00Z"),
  },
});
await prisma.outreachCampaign.create({
  data: {
    id: "out-1", workspaceId: WS_A, name: `${HOLIDAY} — Prospecting`,
    depth: 3, status: "active", dailyCap: 100, authStatusJson: {}, createdBy: "battery",
    createdAt: T("2026-09-08T10:00:00Z"),
  },
});
await prisma.outreachProspect.create({ data: { id: "prosp-1", workspaceId: WS_A, campaignId: "out-1", domain: "x.test", url: "https://x.test" } });
await prisma.outreachSequence.create({
  data: { id: "seq-1", workspaceId: WS_A, campaignId: "out-1", prospectId: "prosp-1", depth: 3, stepsJson: {}, status: "sending", sentCount: 40 },
});
for (const [id, ev] of [["ev-1", "sent"], ["ev-2", "opened"], ["ev-3", "clicked"], ["ev-4", "replied"]] as const) {
  await prisma.outreachEvent.create({
    data: { id, workspaceId: WS_A, sequenceId: "seq-1", ts: T("2026-09-09T10:00:00Z"), event: ev, payloadHash: `h-${id}` },
  });
}
await prisma.mediaBuy.create({
  data: {
    id: "buy-1", workspaceId: WS_A, approvalId: "appr-1", poolId: "pool-1",
    platform: "meta", clientAdAccountId: "act_123", status: "executed",
    platformCampaignRef: "holiday-2026-xmas", actualSpendCents: 25000,
    failureCount: 0, killRulesRegistered: false, createdAt: T("2026-09-08T10:00:00Z"),
  },
});

// -- Messy historical fixtures (for the backfill proposer) --
// Expected: mail-2, soc-1, soc-3, buy-2 -> HOLIDAY (name / utm / platform-ref / date proximity)
await prisma.mailCampaign.create({
  data: {
    id: "mail-2", workspaceId: WS_A, name: `${HOLIDAY} — Reminder Postcard`,
    audienceSource: "csv", pieceCount: 4000, verifiedCount: 3900, quarantinedCount: 20,
    estCostCents: 22000, status: "sent", createdAt: T("2026-09-10T10:00:00Z"),
  },
});
async function socialPost(id: string, text: string, utm: string | null, createdAt: Date, stats: object) {
  await prisma.socialPost.create({
    data: {
      id, projectId: "proj-a",
      content: utm ? { text, utm: { campaign: utm } } : { text },
      services: [], status: "sent", bufferUpdateIds: [], attempts: 1,
      stats, createdAt,
    },
  });
}
await socialPost("soc-1", "Holiday sale is live — 20% off", "holiday-2026", T("2026-09-11T10:00:00Z"), { totals: { impressions: 5000, clicks: 120 } });
await socialPost("soc-3", "Last chance: holiday deals end Sunday", "holiday-2026", T("2026-09-12T10:00:00Z"), { totals: { impressions: 3200, clicks: 88 } });
await prisma.mediaBuy.create({
  data: {
    id: "buy-2", workspaceId: WS_A, approvalId: "appr-2", poolId: "pool-1",
    platform: "google", clientAdAccountId: "act_456", status: "draft",
    platformCampaignRef: "holiday-2026-q4", failureCount: 0, killRulesRegistered: false,
    createdAt: T("2026-09-11T10:00:00Z"),
  },
});
// Decoys: different campaign, far-apart dates — must NOT propose to HOLIDAY.
// They get attached to a second campaign so they're "linked" (skip-logic) too.
await prisma.mailCampaign.create({
  data: {
    id: "mail-3", workspaceId: WS_A, name: "Spring Clearance Mailer",
    audienceSource: "csv", pieceCount: 8000, verifiedCount: 7800, quarantinedCount: 50,
    estCostCents: 40000, status: "sent", createdAt: T("2026-04-01T10:00:00Z"),
  },
});
await socialPost("soc-2", "Spring clearance — everything must go", "spring-clearance", T("2026-04-02T10:00:00Z"), { totals: { impressions: 9000, clicks: 200 } });
await prisma.outreachCampaign.create({
  data: {
    id: "out-2", workspaceId: WS_A, name: "Q1 Cold Outreach",
    depth: 3, status: "completed", dailyCap: 50, authStatusJson: {}, createdBy: "battery",
    createdAt: T("2026-03-15T10:00:00Z"),
  },
});
// WS_B fixture (for the RLS section).
await prisma.mailCampaign.create({
  data: {
    id: "mail-b", workspaceId: WS_B, name: "Other WS Mailer",
    audienceSource: "csv", pieceCount: 100, verifiedCount: 90, quarantinedCount: 1,
    estCostCents: 1000, status: "sent",
  },
});
console.log("  fixtures seeded");

// Immutability baseline: AFTER fixtures, BEFORE any campaign operations.
const checksumBefore = await fragmentChecksum(SCRATCH_DB);

// ---------------------------------------------------------------------------
// A. Campaign CRUD
// ---------------------------------------------------------------------------
console.log("\nA. campaign CRUD");

const campaign = await campaignStore.createCampaign(WS_A, { name: HOLIDAY, objective: "sale" });
check("create returns id + name", campaign.id.length > 0 && campaign.name === HOLIDAY);
check("create defaults to draft", campaign.status === "draft");
check("create seeds all 12 stages", stagesOf(campaign).length === 12 && CAMPAIGN_STAGES.every((k) => stagesOf(campaign).some((s) => s.key === k)));
check("create seeds stages as not_started", stagesOf(campaign).every((s) => s.status === "not_started" && s.linkedRefs.length === 0));
check("create starts with zero roll-up", campaign.budgetRollupCents === 0);

const spring = await campaignStore.createCampaign(WS_A, { name: "Spring Clearance", objective: "sale" });
// Decoys attach to the second campaign (exercises multi-campaign skip logic).
await campaignStore.attachLink(WS_A, spring.id, { linkedType: "mail_campaign", linkedId: "mail-3", role: "primary", linkSource: "human" });
await campaignStore.attachLink(WS_A, spring.id, { linkedType: "social_post", linkedId: "soc-2", role: "primary", linkSource: "human" });
await campaignStore.attachLink(WS_A, spring.id, { linkedType: "outreach_campaign", linkedId: "out-2", role: "primary", linkSource: "human" });

const renamed = await campaignStore.updateCampaign(WS_A, campaign.id, { status: "active", name: HOLIDAY });
check("update status -> active", renamed.status === "active");
await expectCampaignError("update unknown campaign -> not_found", () => campaignStore.updateCampaign(WS_A, "nope", { status: "active" }), "not_found");

// ---------------------------------------------------------------------------
// B. Attach fragments; stage pipeline; budget roll-up; stage refs; detach
// ---------------------------------------------------------------------------
console.log("\nB. attach + pipeline + roll-up");

const linkMail = await campaignStore.attachLink(WS_A, campaign.id, { linkedType: "mail_campaign", linkedId: "mail-1", role: "primary", linkSource: "human" });
const linkOut = await campaignStore.attachLink(WS_A, campaign.id, { linkedType: "outreach_campaign", linkedId: "out-1", role: "primary", linkSource: "human" });
const linkBuy = await campaignStore.attachLink(WS_A, campaign.id, { linkedType: "media_buy", linkedId: "buy-1", role: "supporting", linkSource: "human" });
check("3 links created", [linkMail.link.id, linkOut.link.id, linkBuy.link.id].every(Boolean));

const detail = await campaignStore.getCampaign(WS_A, campaign.id);
check("getCampaign returns 3 links", detail.links.length === 3);
const stageOf = (k: string) => stagesOf(detail).find((s) => s.key === k)!;
check("mail attach -> ads stage in_progress", stageOf("ads").status === "in_progress");
check("outreach attach -> email_sms in_progress", stageOf("email_sms").status === "in_progress");
check("media_buy attach -> ads in_progress", stageOf("ads").status === "in_progress");
check(
  "stage refs carry the fragment identity",
  stageOf("ads").linkedRefs.some((r) => r.linkedType === "mail_campaign" && r.linkedId === "mail-1"),
);
check("budget roll-up sums fragment costs (50000 + 25000)", detail.budgetRollupCents === 75000, `got ${detail.budgetRollupCents}`);

await campaignStore.updateLinkStage(WS_A, campaign.id, linkMail.link.id, { stageKey: "messaging" });
const afterStageMove = await campaignStore.getCampaign(WS_A, campaign.id);
check(
  "updateLinkStage moves the stage ref",
  stagesOf(afterStageMove).find((s) => s.key === "messaging")!.linkedRefs.some((r) => r.linkedId === "mail-1"),
);

await campaignStore.detachLink(WS_A, campaign.id, linkBuy.link.id);
const afterDetach = await campaignStore.getCampaign(WS_A, campaign.id);
check("detach removes the link", afterDetach.links.length === 2);
check(
  "detach removes the stage ref",
  !stagesOf(afterDetach).find((s) => s.key === "ads")!.linkedRefs.some((r) => r.linkedId === "buy-1"),
);
check("detach updates the roll-up (75000 -> 50000)", afterDetach.budgetRollupCents === 50000, `got ${afterDetach.budgetRollupCents}`);
const buyRow = await prisma.mediaBuy.findFirst({ where: { id: "buy-1" } });
check("detach leaves the fragment row untouched", buyRow?.status === "executed" && buyRow?.actualSpendCents === 25000);
// Re-attach buy-1 so the report battery sees all three fragment kinds.
await campaignStore.attachLink(WS_A, campaign.id, { linkedType: "media_buy", linkedId: "buy-1", role: "supporting", linkSource: "human" });

// ---------------------------------------------------------------------------
// C. Roll-up report: provenance per fragment, no silent semantic mismatch
// ---------------------------------------------------------------------------
console.log("\nC. roll-up report");

const report = await campaignStore.campaignReport(WS_A, campaign.id);
check("report covers 3 linked fragments", report.fragments.length === 3, `got ${report.fragments.length}`);
const REAL_TABLES = new Set(FRAGMENT_TABLES);
check(
  "every fragment carries a real table provenance + notes",
  report.fragments.every((f) => REAL_TABLES.has(f.provenance.table) && f.provenance.notes.length > 0 && f.provenance.fragmentId === f.linkedId),
  JSON.stringify(report.fragments.map((f) => f.provenance.table)),
);
check(
  "no 'conversions' total is ever synthesized",
  !report.totals.some((t) => /conversion/i.test(t.key)),
);
const spendTotal = report.totals.find((t) => t.key === "spend_cents");
check("spend_cents total exists with per-fragment provenance", !!spendTotal && spendTotal.provenance.length === 2);
check(
  "spend total carries explicit semantics (no silent summing)",
  !!spendTotal && /platform-reported/i.test(spendTotal.semantics),
  spendTotal?.semantics,
);
const sendsTotals = report.totals.filter((t) => t.key === "sends");
check(
  "newsletter sends vs outreach sends are never merged (per-fragment provenance)",
  sendsTotals.every((t) => t.provenance.length >= 1),
);

// ---------------------------------------------------------------------------
// D. Hierarchy: 3 levels resolve, 4th rejected, cycles rejected
// ---------------------------------------------------------------------------
console.log("\nD. hierarchy");

const child = await campaignStore.createCampaign(WS_A, { name: `${HOLIDAY} — Email`, objective: "sale", parentCampaignId: campaign.id });
const grandchild = await campaignStore.createCampaign(WS_A, { name: `${HOLIDAY} — Email — Wave 2`, objective: "sale", parentCampaignId: child.id });
check("level 2 + 3 create", !!child.id && !!grandchild.id);
await expectCampaignError(
  "level 4 rejected (depth)",
  () => campaignStore.createCampaign(WS_A, { name: "too deep", objective: "sale", parentCampaignId: grandchild.id }),
  "depth_exceeded",
);
await expectCampaignError(
  "reparent root under grandchild -> cycle",
  () => campaignStore.updateCampaign(WS_A, campaign.id, { parentCampaignId: grandchild.id }),
  "cycle",
);
await expectCampaignError(
  "self-parent -> cycle",
  () => campaignStore.updateCampaign(WS_A, campaign.id, { parentCampaignId: campaign.id }),
  "cycle",
);
const chain = await campaignStore.ancestorChain(WS_A, grandchild.id);
check(
  "ancestor chain resolves root-first",
  chain.length === 2 && chain[0].id === campaign.id && chain[1].id === child.id,
  JSON.stringify(chain.map((c) => c.id)),
);
const kids = await campaignStore.listChildren(WS_A, campaign.id);
check("listChildren returns the child", kids.length === 1 && kids[0].id === child.id);

// ---------------------------------------------------------------------------
// E/F/G. Backfill proposals: signals, zero auto-links, precision >= 95%
// ---------------------------------------------------------------------------
console.log("\nE–G. backfill proposer");

const linksBefore = await withCampaignScope(WS_A, (tx) => tx.campaignLink.count());
const scan = await campaignStore.proposeBackfillLinks(WS_A);
const linksAfter = await withCampaignScope(WS_A, (tx) => tx.campaignLink.count());
check("proposer creates zero links automatically", linksBefore === linksAfter, `${linksBefore} -> ${linksAfter}`);

const EXPECTED: Array<[string, string]> = [
  ["mail_campaign", "mail-2"],
  ["social_post", "soc-1"],
  ["social_post", "soc-3"],
  ["media_buy", "buy-2"],
];
check("4 proposals created", scan.proposalsCreated === 4, `got ${scan.proposalsCreated}`);
const pending = await campaignStore.listProposals(WS_A, { status: "pending" });
const gotKeys = new Set(pending.map((p) => `${p.linkedType}:${p.linkedId}`));
const expectedKeys = new Set(EXPECTED.map(([t, i]) => `${t}:${i}`));
check(
  "proposals match the expected set exactly",
  gotKeys.size === expectedKeys.size && [...expectedKeys].every((k) => gotKeys.has(k)),
  `got ${[...gotKeys].join(", ")}`,
);
const correctCampaign = pending.every((p) => p.campaignId === campaign.id);
check("every proposal targets the Holiday campaign", correctCampaign);
const withSignals = pending.every((p) => {
  const signals = p.matchSignals as unknown as Array<{ signal: string }>;
  return Array.isArray(signals) && signals.length > 0 && signals.every((s) => s.signal);
});
check("every proposal carries match signals", withSignals);
const precision = pending.filter((p) => expectedKeys.has(`${p.linkedType}:${p.linkedId}`) && p.campaignId === campaign.id).length / Math.max(1, pending.length);
check("expected-link precision >= 95%", precision >= 0.95, `${(precision * 100).toFixed(1)}%`);
check("all proposals start pending (human gate)", pending.every((p) => p.status === "pending"));

// ---------------------------------------------------------------------------
// H. Human confirmation gate
// ---------------------------------------------------------------------------
console.log("\nH. proposal resolution");

const mail2Proposal = pending.find((p) => p.linkedId === "mail-2")!;
const soc1Proposal = pending.find((p) => p.linkedId === "soc-1")!;
await campaignStore.resolveProposal(WS_A, mail2Proposal.id, "approved", "battery");
const afterApprove = await campaignStore.getCampaign(WS_A, campaign.id);
const approvedLink = afterApprove.links.find((l) => l.linkedId === "mail-2");
check("approval materializes the link", !!approvedLink);
check(
  "approved link source derives from the match signal (naming_convention)",
  approvedLink?.linkSource === "naming_convention",
  `got ${approvedLink?.linkSource}`,
);
check("approval flips mail-2 stage (ads) ref", stagesOf(afterApprove).find((s) => s.key === "ads")!.linkedRefs.some((r) => r.linkedId === "mail-2"));

await campaignStore.resolveProposal(WS_A, soc1Proposal.id, "rejected", "battery");
const linksAfterReject = await withCampaignScope(WS_A, (tx) => tx.campaignLink.count());
check("rejection creates no link", linksAfterReject === linksAfter + 1, `${linksAfterReject} vs ${linksAfter + 1}`);
const rejectedRow = await withCampaignScope(WS_A, (tx) =>
  tx.campaignLinkProposal.findUnique({ where: { id: soc1Proposal.id } }),
);
check("rejection is recorded (status + decider)", rejectedRow?.status === "rejected" && rejectedRow?.decidedBy === "battery");

// Re-run: decided/pending proposals must never be re-proposed (negative signal).
const rescan = await campaignStore.proposeBackfillLinks(WS_A);
check("re-scan creates zero new proposals", rescan.proposalsCreated === 0, `got ${rescan.proposalsCreated}`);

// ---------------------------------------------------------------------------
// I. Fragment history untouched
// ---------------------------------------------------------------------------
console.log("\nI. fragment immutability");

const checksumAfter = await fragmentChecksum(SCRATCH_DB);
check("fragment tables byte-identical before/after", checksumAfter === checksumBefore);
if (checksumAfter !== checksumBefore) {
  const a = checksumBefore.split("|");
  const b = checksumAfter.split("|");
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) console.log(`    drift: ${a[i]} -> ${b[i]}`);
}

// ---------------------------------------------------------------------------
// J. RLS: cross-workspace isolation + fail-closed
// ---------------------------------------------------------------------------
console.log("\nJ. RLS");

const other = await campaignStore.createCampaign(WS_B, { name: "Other WS Campaign", objective: "awareness" });
await campaignStore.attachLink(WS_B, other.id, { linkedType: "mail_campaign", linkedId: "mail-b", role: "primary", linkSource: "human" });
await expectCampaignError("cross-workspace read -> not_found", () => campaignStore.getCampaign(WS_A, other.id), "not_found");
const listA = await campaignStore.listCampaigns(WS_A);
check("listCampaigns(WS_A) excludes WS_B campaign", !listA.some((c) => c.id === other.id));
const scopedLinks = await withCampaignScope(WS_A, (tx) => tx.campaignLink.findMany({ select: { id: true, campaignId: true } }));
check(
  "campaign_links RLS hides other-workspace links (parent-derived policy)",
  scopedLinks.length === 7 && scopedLinks.every((l) => l.campaignId !== other.id),
  `saw ${scopedLinks.length} links: ${scopedLinks.map((l) => l.campaignId).join(",")}`,
);
const noGuc = await prisma.growthCampaign.findMany({});
check("fail-closed without the tenant GUC (0 rows)", noGuc.length === 0, `got ${noGuc.length}`);
const noGucProposals = await prisma.campaignLinkProposal.findMany({});
check("proposals fail-closed without GUC", noGucProposals.length === 0);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("failures:", failures.join(", "));
  console.log(`scratch db kept for forensics: ${SCRATCH_DB}`);
  process.exit(1);
}
await prisma.$disconnect();
await teardownScratchDb();
console.log("scratch db dropped");
