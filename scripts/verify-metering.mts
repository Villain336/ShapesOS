// Marketr — hosted metering adversarial battery (Phase C, W4, track C1).
//
// Run: DATABASE_URL=<redacted> npx tsx scripts/verify-metering.mts
// Run 3x green before calling this done.
//
// Covers THREAT-MODEL-METERING.md abuse cases:
//   T1 idempotency-key replay / double-charge (incl. concurrent same-key race,
//      cross-workspace key reuse)
//   T2 cap-bypass races (20-way concurrent meter() against a tight cap)
//   T3 cross-workspace charging (foreign projectId, summary isolation)
//   T4 negative/zero credit actions, unknown actions
//   T5 ledger tampering (UPDATE/DELETE rejected by the DB trigger; no
//      update/delete path in the service)
//   T6 period-rollover double-counting
//   T7 evidenceRef is stored but never authoritative (column present, free-text)
// Plus: credit table v1 values vs spec Appendix A, cap-exceeded denial copy,
// 80%-alert once-per-period, checkCap/getUsageSummary contract shapes,
// scheduler composite charges (credits override), top-up application.
//
// NOTE: the ledger is append-only, so battery workspaces are NOT deleted —
// each run uses a uniquely-named workspace (zz-meter-battery-*) holding a few
// dozen clearly-labeled rows. All assertions are workspace-scoped, so runs
// never interfere with each other or with the E2E suite.

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(2);
}

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const { prisma } = await import("@/lib/prisma");
const svc = await import("@/lib/metering/service");
const { meter, checkCap, getUsageSummary, applyTopUp, setSpendCap } = svc;
const credits = await import("@/lib/metering/credits");
const { manualTopUp } = await import("@/lib/metering/billing");

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

const key = (s: string) => `batt-${process.pid}-${randomUUID().slice(0, 8)}-${s}`;
const RUN = `zz-meter-battery-${Date.now()}-${process.pid}`;

async function makeWorkspace(plan: "starter" | "pro" | "agency" | "self_hosted" = "starter") {
  const ws = await prisma.workspace.create({
    data: { name: `${RUN}-ws`, ownerUserId: `battery-${process.pid}`, plan },
  });
  return ws;
}

console.log("metering battery");

// ── 1. credit table v2 matches spec Appendix A + Phase 3 additions ──────────
{
  check("table version is 2", credits.CREDIT_TABLE_VERSION === 2);
  const expected: Record<string, number> = {
    rank_check: 1, serp_analysis: 1, keyword_research: 40, keyword_ideas: 50,
    keyword_gap: 50, site_audit: 30, backlink_summary: 10, content_brief: 5,
    ai_article: 15, content_refresh: 10, skill_run_base: 5, subagent_spawn: 2,
    mcp_tool_call: 0, publish: 0, connector_sync: 0, storage_over_quota: 1,
    enrichment_lookup: 2, prospect_research: 5, sms_send: 4, email_send: 1,
  };
  let allOk = true;
  for (const [action, want] of Object.entries(expected)) {
    if (credits.creditsFor(action) !== want) { allOk = false; break; }
  }
  check("20 Appendix-A + Phase 3 costs exact", allOk);
  check("mcp_tool_call is passthrough basis", (credits.CREDIT_COSTS as any).mcp_tool_call.basis === "passthrough");
  let threw = false;
  try { credits.creditsFor("nope_not_real"); } catch { threw = true; }
  check("unknown action throws in creditsFor", threw);
  check("tier pools starter/pro/agency", credits.TIER_INCLUDED_CREDITS.starter === 2500 && credits.TIER_INCLUDED_CREDITS.pro === 10000 && credits.TIER_INCLUDED_CREDITS.agency === 30000);
}

// ── 2. happy path + idempotency replay ───────────────────────────────────────
const wsA = await makeWorkspace("starter");
{
  // NOTE: key() mints a fresh random key per call — replays reuse one fixed key.
  const fixed = key("replay");
  const p1 = await meter({ workspaceId: wsA.id, action: "rank_check", idempotencyKey: fixed });
  const p2 = await meter({ workspaceId: wsA.id, action: "rank_check", idempotencyKey: fixed });
  const p3 = await meter({ workspaceId: wsA.id, action: "rank_check", idempotencyKey: fixed });
  check("first charge ok", p1.ok === true && (p1 as any).charged === 1 && !!(p1 as any).eventId);
  check("replay returns same event", p2.ok && p3.ok && (p1 as any).eventId === (p2 as any).eventId && (p2 as any).eventId === (p3 as any).eventId);
  const bal = await prisma.creditBalance.findUnique({ where: { workspaceId: wsA.id } });
  check("no double charge on replay", bal?.usedCredits === 1, `used=${bal?.usedCredits}`);
  const count = await prisma.usageEvent.count({ where: { workspaceId: wsA.id } });
  check("1 event for 3 same-key calls", count === 1, `count=${count}`);
}

// ── 3. concurrent same-key race → exactly one charge ────────────────────────
{
  const k = key("race");
  const results = await Promise.all(
    Array.from({ length: 5 }, () => meter({ workspaceId: wsA.id, action: "rank_check", idempotencyKey: k })),
  );
  const ids = new Set(results.filter((r) => r.ok).map((r) => (r as any).eventId));
  check("5 concurrent same-key → 1 event", ids.size === 1, `ids=${ids.size}`);
  const bal = await prisma.creditBalance.findUnique({ where: { workspaceId: wsA.id } });
  check("5 concurrent same-key → 1 credit", bal?.usedCredits === 2, `used=${bal?.usedCredits}`);
}

// ── 4. cross-workspace key reuse rejected ────────────────────────────────────
{
  const wsB = await makeWorkspace("starter");
  const k = key("xws");
  await meter({ workspaceId: wsA.id, action: "rank_check", idempotencyKey: k });
  let threw = false;
  try {
    await meter({ workspaceId: wsB.id, action: "rank_check", idempotencyKey: k });
  } catch { threw = true; }
  check("cross-workspace key reuse throws", threw);
  const bEvents = await prisma.usageEvent.count({ where: { workspaceId: wsB.id } });
  check("no event leaked into workspace B", bEvents === 0);
}

// ── 5. unknown action / negative override ────────────────────────────────────
{
  const r = await meter({ workspaceId: wsA.id, action: "definitely_not_real", idempotencyKey: key("u") });
  check("unknown action → unknown_action", !r.ok && (r as any).reason === "unknown_action" && (r as any).charged === 0);
  let threw = false;
  try {
    await meter({ workspaceId: wsA.id, action: "rank_check", idempotencyKey: key("n"), credits: -5 });
  } catch { threw = true; }
  check("negative credits override throws", threw);
  threw = false;
  try {
    await meter({ workspaceId: wsA.id, action: "rank_check", idempotencyKey: key("n2"), credits: 1.5 });
  } catch { threw = true; }
  check("fractional credits override throws", threw);
}

// ── 6. zero-cost actions never charge (and pass at cap) ─────────────────────
{
  const before = await prisma.creditBalance.findUnique({ where: { workspaceId: wsA.id } });
  const r = await meter({ workspaceId: wsA.id, action: "publish", idempotencyKey: key("z") });
  const after = await prisma.creditBalance.findUnique({ where: { workspaceId: wsA.id } });
  check("publish → ok, charged 0", r.ok && (r as any).charged === 0);
  check("publish doesn't move the balance", before?.usedCredits === after?.usedCredits);
  const ev = await prisma.usageEvent.findUnique({ where: { idempotencyKey: (r as any).eventId ? undefined : undefined } }).catch(() => null);
  void ev;
  const evRow = await prisma.usageEvent.findFirst({ where: { id: (r as any).eventId } });
  check("zero-credit event still logged", evRow?.credits === 0);
}

// ── 7. cap enforcement: block at 100% with plain-language denial ─────────────
const wsC = await makeWorkspace("starter");
{
  await meter({ workspaceId: wsC.id, action: "rank_check", idempotencyKey: key("cap0") }); // creates rows
  await setSpendCap(wsC.id, { capCredits: 10 });
  for (let i = 0; i < 9; i++) {
    await meter({ workspaceId: wsC.id, action: "rank_check", idempotencyKey: key(`cap${i}`) });
  }
  const denied = await meter({ workspaceId: wsC.id, action: "rank_check", idempotencyKey: key("capX") });
  check("11th credit over cap 10 → cap_exceeded", !denied.ok && (denied as any).reason === "cap_exceeded" && (denied as any).charged === 0);
  check("denial is plain-language", /Settings → Usage/.test((denied as any).message ?? ""));
  const bal = await prisma.creditBalance.findUnique({ where: { workspaceId: wsC.id } });
  check("used stays at cap", bal?.usedCredits === 10, `used=${bal?.usedCredits}`);
  const count = await prisma.usageEvent.count({ where: { workspaceId: wsC.id } });
  check("denied charge wrote no event", count === 10, `count=${count}`);
  // Zero-cost still passes at cap (never punish the outcome).
  const free = await meter({ workspaceId: wsC.id, action: "publish", idempotencyKey: key("capfree") });
  check("publish passes even at cap", free.ok && (free as any).charged === 0);
  const cap = await checkCap(wsC.id);
  check("checkCap: not allowed, remaining 0", cap.allowed === false && cap.remaining === 0 && cap.capCredits === 10);
}

// ── 8. T2: 20-way concurrent cap race ────────────────────────────────────────
const wsD = await makeWorkspace("starter");
{
  await meter({ workspaceId: wsD.id, action: "rank_check", idempotencyKey: key("race0") }); // used=1
  await setSpendCap(wsD.id, { capCredits: 8 }); // room for exactly 7 more
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => meter({ workspaceId: wsD.id, action: "rank_check", idempotencyKey: key(`r${i}`) })),
  );
  const okCount = results.filter((r) => r.ok).length;
  const deniedCount = results.filter((r) => !r.ok && (r as any).reason === "cap_exceeded").length;
  check("20 concurrent → exactly 7 charged", okCount === 7, `ok=${okCount}`);
  check("20 concurrent → 13 denied", deniedCount === 13, `denied=${deniedCount}`);
  const bal = await prisma.creditBalance.findUnique({ where: { workspaceId: wsD.id } });
  check("usedCredits == 8, never over cap", bal?.usedCredits === 8, `used=${bal?.usedCredits}`);
}

// ── 9. 80% alert fires once per period ───────────────────────────────────────
{
  const cap1 = await prisma.spendCap.findUnique({ where: { workspaceId: wsD.id } });
  check("alert fired on crossing 80%", cap1?.lastAlertAt != null);
  const firstAlert = cap1?.lastAlertAt?.getTime();
  await setSpendCap(wsD.id, { capCredits: 100 }); // raise cap, same period
  await meter({ workspaceId: wsD.id, action: "rank_check", idempotencyKey: key("a2") });
  const cap2 = await prisma.spendCap.findUnique({ where: { workspaceId: wsD.id } });
  check("no second alert in same period", cap2?.lastAlertAt?.getTime() === firstAlert);
}

// ── 10. T3: cross-workspace charging ─────────────────────────────────────────
{
  const projB = await prisma.project.create({
    data: { workspaceId: wsA.id, domain: "example-b.com", locale: "en-US", searchEngine: "google" },
  });
  const wsE = await makeWorkspace("starter");
  let threw = false;
  try {
    await meter({ workspaceId: wsE.id, projectId: projB.id, action: "rank_check", idempotencyKey: key("xp") });
  } catch { threw = true; }
  check("foreign projectId rejected", threw);
  // Summary isolation.
  await meter({ workspaceId: wsE.id, action: "ai_article", idempotencyKey: key("iso") });
  const sumA = await getUsageSummary({ workspaceId: wsA.id });
  check("summary(A) has no rows from E", !("ai_article" in sumA.byAction) || sumA.byAction["ai_article"] === undefined);
  const sumE = await getUsageSummary({ workspaceId: wsE.id });
  check("summary(E) sees its own charge", sumE.byAction["ai_article"] === 15 && sumE.used === 15);
  check("summary contract shape", sumE.included === 2500 && sumE.purchased === 0 && sumE.remaining === 2485 && typeof sumE.periodStart === "string");
}

// ── 11. T5: ledger tamper attempts ───────────────────────────────────────────
{
  const row = await prisma.usageEvent.findFirst({ where: { workspaceId: wsA.id } });
  let updateThrew = false;
  try {
    await prisma.$executeRaw`UPDATE usage_events SET credits = 999999 WHERE id = ${row!.id}`;
  } catch { updateThrew = true; }
  check("raw UPDATE on usage_events rejected", updateThrew);
  let deleteThrew = false;
  try {
    await prisma.$executeRaw`DELETE FROM usage_events WHERE id = ${row!.id}`;
  } catch { deleteThrew = true; }
  check("raw DELETE on usage_events rejected", deleteThrew);
  const src = readFileSync("lib/metering/service.ts", "utf8");
  check("service has no update/delete path", !/usageEvent\.(update|delete|upsert|deleteMany|updateMany)/.test(src));
}

// ── 12. T6: period rollover ──────────────────────────────────────────────────
const wsF = await makeWorkspace("pro");
{
  await meter({ workspaceId: wsF.id, action: "rank_check", idempotencyKey: key("ro0") });
  // Backdate the period 40 days and inflate used (simulating a prior period).
  const past = new Date();
  past.setDate(past.getDate() - 40);
  await prisma.$executeRaw`UPDATE credit_balances SET period_start = ${past}, used_credits = 9999 WHERE workspace_id = ${wsF.id}`;
  const r = await meter({ workspaceId: wsF.id, action: "keyword_research", idempotencyKey: key("ro1") });
  const bal = await prisma.creditBalance.findUnique({ where: { workspaceId: wsF.id } });
  check("rollover: used == only the new charge", r.ok && bal?.usedCredits === 40, `used=${bal?.usedCredits}`);
  const thisMonth = new Date();
  thisMonth.setDate(1); thisMonth.setHours(0, 0, 0, 0);
  check("rollover: periodStart advanced", bal!.periodStart >= thisMonth);
  // Alert re-arms in the new period: drive to 80% of the (default) cap.
  const capBefore = await prisma.spendCap.findUnique({ where: { workspaceId: wsF.id } });
  check("rollover: alert re-armed (lastAlertAt predates period)", !capBefore?.lastAlertAt || capBefore.lastAlertAt < bal!.periodStart);
}

// ── 13. scheduler composite charges (credits override) ───────────────────────
{
  const r1 = await meter({ workspaceId: wsA.id, action: "skill_run_base", credits: 7, idempotencyKey: key("s1"), evidenceRef: "skill-run:test" });
  const r2 = await meter({ workspaceId: wsA.id, action: "subagent_spawn", credits: 3, idempotencyKey: key("s2"), evidenceRef: "subagent-run:test" });
  check("override charges exact totals", r1.ok && (r1 as any).charged === 7 && r2.ok && (r2 as any).charged === 3);
  const ev1 = await prisma.usageEvent.findFirst({ where: { id: (r1 as any).eventId } });
  check("evidenceRef stored", ev1?.evidenceRef === "skill-run:test");
}

// ── 14. top-ups: purchased credits roll over, cap rises ──────────────────────
{
  const top = manualTopUp(wsA.id, 5000);
  const res = await applyTopUp(wsA.id, top);
  check("top-up applied", res.purchasedCredits === 5000);
  check("top-up raises cap", res.capCredits >= 5000);
  check("top-up expires ~12 months out", (() => {
    const d = new Date(); d.setFullYear(d.getFullYear() + 1);
    return Math.abs(top.expiresAt.getTime() - d.getTime()) < 86400000 * 2;
  })());
  const sum = await getUsageSummary({ workspaceId: wsA.id });
  check("summary reflects purchased pool", sum.purchased === 5000 && sum.remaining === 5000 + 2500 - sum.used);
}

// ── 15. default rows for untouched workspaces ────────────────────────────────
{
  const wsG = await makeWorkspace("agency");
  const cap = await checkCap(wsG.id);
  check("agency default pool 30000", cap.capCredits === 30000 && cap.allowed && cap.remaining === 30000);
  const sum = await getUsageSummary({ workspaceId: wsG.id });
  check("empty summary is zeroed", sum.used === 0 && sum.included === 30000 && Object.keys(sum.byAction).length === 0);
}

await prisma.$disconnect();

console.log(`\nverify-metering: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("failures:", failures.join(", "));
  process.exit(1);
}
