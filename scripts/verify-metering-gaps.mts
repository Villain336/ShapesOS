// Marketr — metering gap battery (Phase C gaps, G1).
//
// Run: DATABASE_URL=<redacted> npx tsx scripts/verify-metering-gaps.mts
// Run 3x green before calling this done.
//
// Covers the G1 threat-model additions + wiring:
//   T8  keyId spoofing / workspace attribution (reject foreign + bogus keys,
//       attribute valid API-key and OAuth-client ids, byKey aggregation)
//   T9  scheduler pre-run cap gate (blocked status, plain-language reason,
//       zero execution, zero metering, audit row)
//   T10 workspace confusion at wired charge points (static: workspaceId comes
//       from server context — project rows, ctx, or args — never the body)
//   T11 storage over-quota snapshot approximation (decimal-GB round-up,
//       month idempotency, docs state the snapshot rule plainly)
//   T12 hour-bucket idempotency for row-less keyword actions
// Plus: autoOverage default-off semantics, wired-action seam coverage, and
// documentation presence (threat model T8–T12, SEAM wiring table, checkCap
// advisory semantics).
//
// NOTE: the ledger is append-only — battery workspaces are NOT deleted. Each
// run uses a uniquely-named workspace (zz-gap-battery-*) and all assertions
// are workspace-scoped.

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(2);
}

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const { prisma } = await import("@/lib/prisma");
const { meter, checkCap, getUsageSummary, setSpendCap } = await import("@/lib/metering/service");
const { gbOverQuota, hourBucket, seedHash } = await import("@/lib/metering/wiring");
const { executeSkillRun } = await import("@/lib/scheduler/runner");

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

const key = (s: string) => `gap-${process.pid}-${randomUUID().slice(0, 8)}-${s}`;
const RUN = `zz-gap-battery-${Date.now()}-${process.pid}`;

async function makeWorkspace(plan: "starter" | "pro" | "agency" | "self_hosted" = "starter") {
  return prisma.workspace.create({
    data: { name: `${RUN}-ws`, ownerUserId: `gap-battery-${process.pid}`, plan },
  });
}

console.log("metering gap battery");

// ── 1. T8: keyId validation + attribution ────────────────────────────────────
const wsK = await makeWorkspace("starter");
const apiKey = await prisma.mcpApiKey.create({
  data: {
    workspaceId: wsK.id,
    userId: `gap-battery-${process.pid}`,
    name: "battery key",
    keyHash: `batt-hash-${RUN}`,
    keyPrefix: "mcpk_batt",
    scopes: ["tools:list_projects"],
  },
});
const oauthClient = await prisma.mcpOAuthClient.create({
  data: { clientId: `mcpc_batt_${process.pid}_${Date.now()}`, workspaceId: wsK.id, redirectUris: [] },
});
{
  // Valid API-key attribution.
  const r1 = await meter({
    workspaceId: wsK.id, action: "rank_check", idempotencyKey: key("k1"), keyId: apiKey.id,
  });
  const ev1 = await prisma.usageEvent.findFirst({ where: { id: (r1 as any).eventId } });
  check("valid api keyId attributed on the event", r1.ok && ev1?.keyId === apiKey.id);

  // Valid OAuth-client attribution.
  const r2 = await meter({
    workspaceId: wsK.id, action: "rank_check", idempotencyKey: key("k2"), keyId: oauthClient.clientId,
  });
  const ev2 = await prisma.usageEvent.findFirst({ where: { id: (r2 as any).eventId } });
  check("valid oauth clientId attributed on the event", r2.ok && ev2?.keyId === oauthClient.clientId);

  // A key from another workspace is rejected.
  const wsOther = await makeWorkspace("starter");
  const foreignKey = await prisma.mcpApiKey.create({
    data: {
      workspaceId: wsOther.id,
      userId: `gap-battery-${process.pid}`,
      name: "foreign key",
      keyHash: `batt-foreign-${RUN}`,
      keyPrefix: "mcpk_fgn",
      scopes: [],
    },
  });
  let threw = false;
  try {
    await meter({ workspaceId: wsK.id, action: "rank_check", idempotencyKey: key("k3"), keyId: foreignKey.id });
  } catch { threw = true; }
  check("foreign-workspace keyId rejected", threw);

  // A made-up keyId is rejected.
  threw = false;
  try {
    await meter({ workspaceId: wsK.id, action: "rank_check", idempotencyKey: key("k4"), keyId: "does-not-exist" });
  } catch { threw = true; }
  check("bogus keyId rejected", threw);

  // Rejection leaves no ledger row.
  const count = await prisma.usageEvent.count({ where: { workspaceId: wsK.id } });
  check("rejected keyIds wrote no events", count === 2, `count=${count}`);
}

// ── 2. T8: byKey aggregation + filtered summary ──────────────────────────────
{
  // One direct (non-MCP) charge alongside the two keyed charges above.
  await meter({ workspaceId: wsK.id, action: "site_audit", idempotencyKey: key("direct1") });

  const sum = await getUsageSummary({ workspaceId: wsK.id });
  check("unfiltered summary includes byKey", !!sum.byKey);
  check("byKey attributes the api key", sum.byKey?.[apiKey.id] === 1, JSON.stringify(sum.byKey));
  check("byKey attributes the oauth client", sum.byKey?.[oauthClient.clientId] === 1);
  check("byKey buckets non-MCP charges under 'direct'", sum.byKey?.["direct"] === 30, JSON.stringify(sum.byKey));

  const filtered = await getUsageSummary({ workspaceId: wsK.id, keyId: apiKey.id });
  check("filtered summary scoped to the key", filtered.used === 1 && filtered.byAction["rank_check"] === 1);
  check("filtered summary omits byKey", filtered.byKey === undefined);
}

// ── 3. T9: scheduler pre-run cap gate ────────────────────────────────────────
const wsS = await makeWorkspace("starter");
{
  await setSpendCap(wsS.id, { capCredits: 5 });
  // Exhaust the cap with 5 rank checks.
  for (let i = 0; i < 5; i++) {
    await meter({ workspaceId: wsS.id, action: "rank_check", idempotencyKey: key(`capfill${i}`) });
  }
  const gate = await checkCap(wsS.id);
  check("cap is exhausted before the run", gate.allowed === false);

  const skill = await prisma.skill.create({
    data: {
      workspaceId: wsS.id,
      name: "battery skill",
      slug: `battery-skill-${process.pid}`,
      description: "battery",
      source: "upload",
      skillMd: "# battery",
      declaredTools: [],
      trustTier: "built_in",
    },
  });
  const run = await prisma.skillRun.create({
    data: { workspaceId: wsS.id, skillId: skill.id, trigger: "manual", status: "pending" },
  });
  const eventsBefore = await prisma.usageEvent.count({ where: { workspaceId: wsS.id } });
  const subagentsBefore = await prisma.subagentRun.count({ where: { skillRunId: run.id } });

  await executeSkillRun(prisma, run.id);

  const after = await prisma.skillRun.findUnique({ where: { id: run.id } });
  check("run recorded as blocked", after?.status === "blocked", `status=${after?.status}`);
  check("blocked run has finishedAt", after?.finishedAt != null);
  check("blocked reason is plain-language", /Credit cap reached.*Settings → Usage/.test(after?.error ?? ""));
  check("blocked run charged nothing", (await prisma.usageEvent.count({ where: { workspaceId: wsS.id } })) === eventsBefore);
  check("blocked run spawned zero subagents", (await prisma.subagentRun.count({ where: { skillRunId: run.id } })) === subagentsBefore);
  const auditRow = await prisma.fileChangeLog.findFirst({
    where: { workspaceId: wsS.id, action: "scheduler_run_blocked_cap" },
  });
  check("blocked run audit-logged", !!auditRow);
}

// ── 4. autoOverage: default off, explicit opt-in only ─────────────────────────
{
  const wsA1 = await makeWorkspace("starter");
  await setSpendCap(wsA1.id, { capCredits: 2 });
  await meter({ workspaceId: wsA1.id, action: "rank_check", idempotencyKey: key("ao0") });
  await meter({ workspaceId: wsA1.id, action: "rank_check", idempotencyKey: key("ao1") });
  const denied = await meter({ workspaceId: wsA1.id, action: "rank_check", idempotencyKey: key("ao2") });
  check("autoOverage defaults off: over-cap denied", !denied.ok && (denied as any).reason === "cap_exceeded");
  const capRow = await prisma.spendCap.findUnique({ where: { workspaceId: wsA1.id } });
  check("autoOverage column defaults false", capRow?.autoOverage === false);

  const wsA2 = await makeWorkspace("starter");
  await setSpendCap(wsA2.id, { capCredits: 2, autoOverage: true });
  await meter({ workspaceId: wsA2.id, action: "rank_check", idempotencyKey: key("bo0") });
  await meter({ workspaceId: wsA2.id, action: "rank_check", idempotencyKey: key("bo1") });
  const over = await meter({ workspaceId: wsA2.id, action: "rank_check", idempotencyKey: key("bo2") });
  check("autoOverage opt-in: over-cap allowed", over.ok && (over as any).charged === 1);
  const cap = await checkCap(wsA2.id);
  check("checkCap reports autoOverage", cap.autoOverage === true && cap.used === 3);
}

// ── 5. wired action seams: static presence + seam-style idempotency ──────────
const SEAMS: Array<[string, string]> = [
  ["app/api/rankings/check/route.ts", 'action: "rank_check"'],
  ["app/api/keywords/ideas/route.ts", 'action: "keyword_ideas"'],
  ["lib/chat/tools.ts", 'action: "keyword_ideas"'],
  ["app/api/competitors/gap/route.ts", 'action: "keyword_gap"'],
  ["lib/audit/audit.ts", 'action: "site_audit"'],
  ["lib/seo/backlink-pull.ts", 'action: "backlink_summary"'],
  ["app/api/content/brief/route.ts", 'action: "content_brief"'],
  ["app/api/content/draft/route.ts", 'action: "ai_article"'],
  ["lib/chat/tools.ts", 'action: "ai_article"'],
  ["lib/seo/autopilot-service.ts", 'action: "content_refresh"'],
  ["app/api/cron/storage-metering/route.ts", 'action: "storage_over_quota"'],
];
{
  let allPresent = true;
  for (const [file, needle] of SEAMS) {
    const src = readFileSync(file, "utf8");
    if (!src.includes(needle)) {
      allPresent = false;
      console.log(`    missing seam: ${file} :: ${needle}`);
    }
  }
  check("all 11 charge-point seams call meter() with the right action", allPresent);

  // Retry with a seam-style key charges once (row-derived keys).
  const wsW = await makeWorkspace("starter");
  const seamKey = `rankcheck:cm${process.pid}000000000000`;
  const w1 = await meter({ workspaceId: wsW.id, action: "rank_check", idempotencyKey: seamKey });
  const w2 = await meter({ workspaceId: wsW.id, action: "rank_check", idempotencyKey: seamKey });
  check("seam-style key retry → one event", w1.ok && w2.ok && (w1 as any).eventId === (w2 as any).eventId);

  // Hour-bucket helpers behave (T12): same inputs → same key within the hour.
  const h1 = `kwideas:proj1:${seedHash("seed")}:20:${hourBucket()}`;
  const h2 = `kwideas:proj1:${seedHash("seed")}:20:${hourBucket()}`;
  check("hour-bucketed keys are stable within the hour", h1 === h2);
  check("seedHash is stable", seedHash("abc") === seedHash("abc") && seedHash("abc") !== seedHash("abd"));
}

// ── 6. T10: no body-derived workspaceId at charge points (static) ───────────
{
  const wiredFiles = [...new Set(SEAMS.map(([f]) => f))];
  const bad: string[] = [];
  for (const file of wiredFiles) {
    const src = readFileSync(file, "utf8");
    // Look for meter() calls whose workspaceId arg is drawn from body/json.
    const meterBlocks = src.match(/meter\(\{[\s\S]{0,400}?action:/g) ?? [];
    for (const block of meterBlocks) {
      if (/workspaceId:\s*(body|json|req\.body)\b/.test(block)) bad.push(`${file}: ${block.slice(0, 80)}`);
    }
  }
  check("no body-derived workspaceId at charge points", bad.length === 0, bad.join("; "));
}

// ── 7. T11: storage rounding + month idempotency + docs ──────────────────────
{
  check("under quota → 0 GB", gbOverQuota(10_000_000_000, 10_000_000_000) === 0);
  check("1 byte over → 1 GB (rounds up)", gbOverQuota(10_000_000_001, 10_000_000_000) === 1);
  check("exactly 1 GB over → 1", gbOverQuota(11_000_000_000, 10_000_000_000) === 1);
  check("1 GB + 1 byte over → 2", gbOverQuota(11_000_000_001, 10_000_000_000) === 2);
  check("2.5 GB over → 3", gbOverQuota(12_500_000_000, 10_000_000_000) === 3);
  check("bigint inputs work", gbOverQuota(BigInt("10500000000"), BigInt("10000000000")) === 1);

  // Month idempotency: two cron-style charges for the same month → one event.
  const wsT = await makeWorkspace("starter");
  const month = new Date().toISOString().slice(0, 7);
  const t1 = await meter({
    workspaceId: wsT.id, action: "storage_over_quota", credits: 3,
    idempotencyKey: `storagequota:${wsT.id}:${month}`,
  });
  const t2 = await meter({
    workspaceId: wsT.id, action: "storage_over_quota", credits: 3,
    idempotencyKey: `storagequota:${wsT.id}:${month}`,
  });
  check("storage month key idempotent", t1.ok && t2.ok && (t1 as any).eventId === (t2 as any).eventId);
  const tev = await prisma.usageEvent.findFirst({ where: { id: (t1 as any).eventId } });
  check("storage overage charges the GB count", tev?.credits === 3);

  // Docs state the snapshot approximation plainly.
  const routeSrc = readFileSync("app/api/cron/storage-metering/route.ts", "utf8");
  const seamSrc = readFileSync("lib/metering/SEAM.md", "utf8");
  check("cron route documents the snapshot rule", /NOT a time-weighted average/.test(routeSrc));
  check("SEAM documents the snapshot rule", /snapshot/i.test(seamSrc));
}

// ── 8. docs: threat model + contract docs ────────────────────────────────────
{
  const tm = readFileSync("lib/metering/THREAT-MODEL-METERING.md", "utf8");
  check("threat model covers T8 keyId spoofing", /T8/.test(tm) && /keyId/i.test(tm));
  check("threat model covers T9 pre-run TOCTOU", /T9/.test(tm) && /checkCap/.test(tm));
  check("threat model covers T10 workspace confusion", /T10/.test(tm));
  check("threat model covers T11 storage snapshot", /T11/.test(tm));
  check("threat model covers T12 hour-bucket idempotency", /T12/.test(tm));
  const svc = readFileSync("lib/metering/service.ts", "utf8");
  check("meter() contract documents keyId", /keyId\?: string \| null/.test(svc));
  check("checkCap is documented as advisory", /Advisory/i.test(svc));
}

await prisma.$disconnect();

console.log(`\nverify-metering-gaps: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("failures:", failures.join(", "));
  process.exit(1);
}
