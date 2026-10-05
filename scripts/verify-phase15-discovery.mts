#!/usr/bin/env tsx
// Marketr — Phase 15 slice 1 battery: tool-router discovery + ComposioToolCatalog cache.
//
// Battery (fixture-based, DB-backed against the local durable DB):
//   discovery lists toolkits (>= 8, expected slugs present)
//   getToolkitTools returns the v1 baseline slugs verbatim for v1 toolkits
//   refresh upserts rows + bumps version per (workspace, app)
//   second refresh is idempotent (no dupes, count stable)
//   RLS: FORCE on, no-GUC reads zero, workspace A cannot read B's catalog
//   V1_ACTION_CATALOG intact: 37 tools, classifier agrees on every expected tier
//   confirmConnection finalize hooks the catalog refresh (fixture-backed)
//   COMPOSIO_API_KEY selects the live router (Phase 6 live discovery,
//   exercised against a stubbed fetch — no network); no key → fixtures
//
// Run: npx tsx scripts/verify-phase15-discovery.mts
// Requires: DATABASE_URL (local durable Postgres).

import "dotenv/config";
import { prisma } from "../lib/prisma";
import {
  withWorkspaceScope,
  countWithoutScope,
} from "../lib/substrate/memory/rls";
import {
  LiveComposioToolRouter,
  fixtureToolRouter,
  getToolRouter,
  refreshCatalogForConnection,
} from "../lib/integrations/actions/discovery";
import { V1_ACTION_CATALOG, classifyAction } from "../lib/integrations/actions/risk";
import { confirmConnection } from "../lib/integrations/actions/connections";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`); }
}

const WS_A = "15-battery-a";
const WS_B = "15-battery-b";

const EXPECTED_TOOLKITS = [
  "gmail", "google_sheets", "slack", "hubspot", "notion",
  "salesforce", "zendesk", "stripe",
];

async function ensureWorkspaces() {
  for (const id of [WS_A, WS_B]) {
    await prisma.workspace.deleteMany({ where: { id } });
    await prisma.workspace.create({
      data: { id, name: `15 discovery battery ${id}`, ownerUserId: "15-battery-owner" },
    });
  }
}

async function cleanup() {
  await withWorkspaceScope(WS_A, (tx) =>
    tx.composioToolCatalog.deleteMany({ where: { workspaceId: WS_A } }),
  );
  await withWorkspaceScope(WS_B, (tx) =>
    tx.composioToolCatalog.deleteMany({ where: { workspaceId: WS_B } }),
  );
  await withWorkspaceScope(WS_A, (tx) =>
    tx.composioConnection.deleteMany({ where: { workspaceId: WS_A } }),
  );
  for (const id of [WS_A, WS_B]) {
    await prisma.workspace.deleteMany({ where: { id } });
  }
}

async function main() {
  console.log("Phase 15 slice 1 discovery battery…");
  await ensureWorkspaces();

  // ── 1. discovery lists toolkits ──
  const toolkits = await fixtureToolRouter.listToolkits();
  check("discovery: lists >= 8 toolkits", toolkits.length >= 8, `${toolkits.length}`);
  const slugs = toolkits.map((t) => t.toolkitSlug);
  check(
    "discovery: expected slugs present",
    EXPECTED_TOOLKITS.every((s) => slugs.includes(s)),
    slugs.join(","),
  );
  check(
    "discovery: full firehose (no packs) — toolkits visible as-is",
    toolkits.every((t) => t.appKey && t.label && t.description),
  );

  // ── 2. v1 toolkit tools match the pinned baseline verbatim ──
  const gmailTools = await fixtureToolRouter.getToolkitTools("gmail");
  const v1GmailSlugs = V1_ACTION_CATALOG.filter((t) => t.appKey === "gmail").map((t) => t.slug);
  check(
    "discovery: gmail tools mirror the v1 baseline slugs",
    v1GmailSlugs.every((s) => gmailTools.some((t) => t.slug === s)) &&
      gmailTools.length === v1GmailSlugs.length,
    `got ${gmailTools.length}, want ${v1GmailSlugs.length}`,
  );
  let unknownThrew = false;
  try { await fixtureToolRouter.getToolkitTools("does-not-exist"); }
  catch { unknownThrew = true; }
  check("discovery: unknown toolkit throws", unknownThrew);

  // ── 3. refresh upserts rows + bumps version; idempotent re-refresh ──
  const r1 = await refreshCatalogForConnection(WS_A, "salesforce");
  check("refresh: tool count matches fixture", r1.toolCount === 10, `${r1.toolCount}`);
  check("refresh: first version is 1", r1.version === 1, `v${r1.version}`);
  const rows1 = await withWorkspaceScope(WS_A, (tx) =>
    tx.composioToolCatalog.findMany({ where: { workspaceId: WS_A, appKey: "salesforce" } }),
  );
  check("refresh: rows upserted", rows1.length === 10, `${rows1.length}`);
  check(
    "refresh: sample row fields",
    rows1.some(
      (r) =>
        r.toolSlug === "SALESFORCE_CREATE_LEAD" &&
        r.toolkitSlug === "salesforce" &&
        typeof r.toolLabel === "string" &&
        typeof r.description === "string" &&
        r.version === 1 &&
        r.discoveredAt instanceof Date,
    ),
  );

  const r2 = await refreshCatalogForConnection(WS_A, "salesforce");
  const rows2 = await withWorkspaceScope(WS_A, (tx) =>
    tx.composioToolCatalog.findMany({ where: { workspaceId: WS_A, appKey: "salesforce" } }),
  );
  check("refresh: version bumps per refresh", r2.version === 2, `v${r2.version}`);
  check("refresh: re-refresh creates NO dupes", rows2.length === rows1.length, `${rows2.length} vs ${rows1.length}`);
  check("refresh: rows re-stamped at v2", rows2.every((r) => r.version === 2));

  // two apps refresh independently
  const rSlack = await refreshCatalogForConnection(WS_A, "slack");
  check("refresh: slack refresh independent", rSlack.version === 1 && rSlack.toolCount > 0);
  const salesforceStillV2 = await withWorkspaceScope(WS_A, (tx) =>
    tx.composioToolCatalog.count({ where: { workspaceId: WS_A, appKey: "salesforce", version: 2 } }),
  );
  check("refresh: salesforce rows untouched by slack refresh", salesforceStillV2 === 10);

  // ── 4. RLS on composio_tool_catalog ──
  const rls = (await prisma.$queryRawUnsafe(
    `SELECT c.relname AS tablename, c.relrowsecurity AS rowsecurity,
            c.relforcerowsecurity AS force_rowsecurity
       FROM pg_class c WHERE c.relname = 'composio_tool_catalog'`,
  )) as Array<{ tablename: string; rowsecurity: boolean; force_rowsecurity: boolean }>;
  check(
    "rls: FORCE ROW LEVEL SECURITY on composio_tool_catalog",
    rls.length === 1 && rls[0].rowsecurity && rls[0].force_rowsecurity,
  );
  const policies = (await prisma.$queryRawUnsafe(
    `SELECT policyname FROM pg_policies WHERE tablename = 'composio_tool_catalog'`,
  )) as Array<{ policyname: string }>;
  check(
    "rls: tenant_isolation policy present",
    policies.some((p) => p.policyname === "composio_tool_catalog_tenant_isolation"),
  );
  check("rls: no-GUC read returns zero", (await countWithoutScope("composio_tool_catalog")) === 0);
  const crossRead = await withWorkspaceScope(WS_B, (tx) =>
    tx.composioToolCatalog.count({ where: { workspaceId: WS_A } }),
  );
  check("rls: workspace B cannot read workspace A's catalog", crossRead === 0, `${crossRead}`);
  const ownRead = await withWorkspaceScope(WS_A, (tx) =>
    tx.composioToolCatalog.count({ where: { workspaceId: WS_A } }),
  );
  check("rls: workspace A reads its own catalog", ownRead > 0, `${ownRead}`);

  // ── 5. V1_ACTION_CATALOG intact — classifier agrees on all 37 ──
  // NOTE: the slice brief said "37 v1 tools" but the unmodified risk.ts
  // pins 36 (9 gmail + 5 sheets + 6 slack + 9 hubspot + 7 notion = 36).
  // The pinned count is asserted here so future catalog drift fails loudly.
  check("v1 catalog: still 36 tools (pinned baseline)", V1_ACTION_CATALOG.length === 36, `${V1_ACTION_CATALOG.length}`);
  const mismatches = V1_ACTION_CATALOG.filter((t) => {
    const c = classifyAction(t.slug);
    return c.tier !== t.expectedTier || (!!t.draftCreator !== c.draftCreator);
  });
  check(
    "v1 catalog: classifier agrees on all 36 tiers",
    mismatches.length === 0,
    mismatches.map((t) => t.slug).join(","),
  );

  // ── 6. confirmConnection finalize hooks catalog refresh ──
  const before = await withWorkspaceScope(WS_A, (tx) =>
    tx.composioToolCatalog.count({ where: { workspaceId: WS_A, appKey: "gmail" } }),
  );
  check("finalize hook: gmail catalog empty before connect", before === 0, `${before}`);
  await confirmConnection({
    workspaceId: WS_A,
    appKey: "gmail",
    connectedAccountId: "ent-battery-15",
  });
  const after = await withWorkspaceScope(WS_A, (tx) =>
    tx.composioToolCatalog.count({ where: { workspaceId: WS_A, appKey: "gmail" } }),
  );
  const v1GmailCount = V1_ACTION_CATALOG.filter((t) => t.appKey === "gmail").length;
  check(
    "finalize hook: connect seeds gmail catalog (fixture-backed)",
    after === v1GmailCount,
    `got ${after}, want ${v1GmailCount}`,
  );

  // ── 7. COMPOSIO_API_KEY selects live discovery (stubbed fetch, no network) ──
  const savedKey = process.env.COMPOSIO_API_KEY;
  const savedFetch = globalThis.fetch;
  process.env.COMPOSIO_API_KEY = "test-key-live-discovery";
  let liveUrl = "";
  globalThis.fetch = (async (input: string | URL | Request) => {
    liveUrl = String(input);
    return new Response(JSON.stringify({ items: [{ slug: "gmail", name: "Gmail" }], next_cursor: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  let liveSlugs: string[] = [];
  try {
    const liveRouter = getToolRouter();
    check("live path: key selects LiveComposioToolRouter", liveRouter instanceof LiveComposioToolRouter);
    liveSlugs = (await liveRouter.listToolkits()).map((t) => t.toolkitSlug);
  } finally {
    globalThis.fetch = savedFetch;
  }
  check("live path: lists toolkits from GET /toolkits", /\/toolkits\?limit=1000$/.test(liveUrl) && liveSlugs.join() === "gmail", liveUrl);
  if (savedKey === undefined) delete process.env.COMPOSIO_API_KEY;
  else process.env.COMPOSIO_API_KEY = savedKey;
  check("fixture router active without key", getToolRouter() === fixtureToolRouter);

  await cleanup();
  await prisma.$disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error("battery crashed:", e);
  process.exit(2);
});
