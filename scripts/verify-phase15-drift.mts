#!/usr/bin/env tsx
// Marketr — Phase 15 slice 5 battery: catalog drift detection + stale-override
// re-approval.
//
// Battery (fixture-based, DB-backed against the local durable DB):
//   drift-mode diff finds EXACTLY the added/removed/renamed sets
//   recordDriftReport persists 4 rows; rerun writes no dupes
//   RLS: FORCE on, no-GUC reads zero, workspace A cannot read B's drift rows
//   removed tool keeps its last-known cache row (slice-1 behavior; even a
//     drift-mode refresh never deletes it)
//   a newly-added tool proposed through the gate lands HIGH-GATED (pending,
//     classified=false, autoExecutable=false — no special-casing; the
//     slice-2 universal conservative floor catches it automatically)
//   stale override detection flags the renamed tool's override (and not an
//     untouched override); cross-workspace acknowledge fails closed
//   acknowledge clears the banner count + the stale-override flag
//
// Run: npx tsx scripts/verify-phase15-drift.mts
// Requires: DATABASE_URL (local durable Postgres).

import "dotenv/config";
import { prisma } from "../lib/prisma";
import {
  withWorkspaceScope,
  countWithoutScope,
} from "../lib/substrate/memory/rls";
import {
  refreshCatalogForConnection,
  setFixtureDriftMode,
  isFixtureDriftMode,
} from "../lib/integrations/actions/discovery";
import {
  detectDrift,
  recordDriftReport,
  listDriftReports,
  acknowledgeDrift,
  getStaleOverrides,
} from "../lib/integrations/actions/drift";
import { setToolTierOverrides } from "../lib/integrations/actions/connections";
import { deriveTier } from "../lib/integrations/actions/risk";
import { proposeAction } from "../lib/integrations/actions/gate";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`); }
}
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

const WS_A = "15-battery-drift-a";
const WS_B = "15-battery-drift-b";

const ADDED_EXPECTED = ["STRIPE_ORCHESTRATE_LEDGER", "STRIPE_RECONCILE_DISPUTES"];
const REMOVED_EXPECTED = ["STRIPE_LIST_PAYMENT_INTENTS"];
const RENAMED_EXPECTED = [{ oldSlug: "STRIPE_CREATE_CUSTOMER", newSlug: "STRIPE_NEW_CUSTOMER" }];

async function ensureWorkspaces() {
  for (const id of [WS_A, WS_B]) {
    await prisma.workspace.deleteMany({ where: { id } });
    await prisma.workspace.create({
      data: { id, name: `15 drift battery ${id}`, ownerUserId: "15-battery-owner" },
    });
  }
}

async function cleanup() {
  for (const id of [WS_A, WS_B]) {
    await withWorkspaceScope(id, (tx) =>
      tx.composioCatalogDrift.deleteMany({ where: { workspaceId: id } }),
    );
    await withWorkspaceScope(id, (tx) =>
      tx.composioActionApproval.deleteMany({ where: { workspaceId: id } }),
    );
    await withWorkspaceScope(id, (tx) =>
      tx.composioToolCatalog.deleteMany({ where: { workspaceId: id } }),
    );
    await withWorkspaceScope(id, (tx) =>
      tx.workspaceSettings.deleteMany({ where: { workspaceId: id } }),
    );
  }
  for (const id of [WS_A, WS_B]) {
    await prisma.workspace.deleteMany({ where: { id } });
  }
}

async function main() {
  console.log("Phase 15 slice 5 drift battery…");
  try {
    await ensureWorkspaces();

    // ── 1. baseline: normal-mode refresh seeds the stripe cache ──
    check("drift mode off by default", !isFixtureDriftMode());
    const base = await refreshCatalogForConnection(WS_A, "stripe");
    check("baseline: stripe cache seeded (10 tools)", base.toolCount === 10, `${base.toolCount}`);
    // gmail baseline: so the undrifted-toolkit assertion below diffs
    // cache-vs-cache instead of cache-vs-empty.
    await refreshCatalogForConnection(WS_A, "gmail");

    // stale-override setup: one override on the tool that WILL be renamed,
    // one on an untouched tool (negative control).
    await setToolTierOverrides(WS_A, {
      STRIPE_CREATE_CUSTOMER: "high",
      STRIPE_GET_CUSTOMER: "high",
    });

    // ── 2. drift-mode diff finds exactly the changed sets ──
    setFixtureDriftMode(true);
    check("drift mode on", isFixtureDriftMode());
    const diff = await detectDrift(WS_A, "stripe");
    check("diff: toolkit/app resolve", diff.toolkitSlug === "stripe" && diff.appKey === "stripe");
    check("diff: added set exact", sameSet(diff.added, ADDED_EXPECTED), diff.added.join(","));
    check("diff: removed set exact", sameSet(diff.removed, REMOVED_EXPECTED), diff.removed.join(","));
    check(
      "diff: renamed pair exact",
      diff.renamed.length === 1 &&
        diff.renamed[0].oldSlug === RENAMED_EXPECTED[0].oldSlug &&
        diff.renamed[0].newSlug === RENAMED_EXPECTED[0].newSlug,
      JSON.stringify(diff.renamed),
    );
    const gmailDiff = await detectDrift(WS_A, "gmail");
    check(
      "diff: gmail (undrifted) has no changes",
      gmailDiff.added.length === 0 && gmailDiff.removed.length === 0 && gmailDiff.renamed.length === 0,
    );

    // ── 3. report persistence + dedupe ──
    const written = await recordDriftReport(WS_A, diff);
    check("report: 4 rows written (2 added + 1 removed + 1 renamed)", written === 4, `${written}`);
    const writtenAgain = await recordDriftReport(WS_A, diff);
    check("report: rerun before re-approval writes no dupes", writtenAgain === 0, `${writtenAgain}`);
    const { reports, unacknowledgedCount } = await listDriftReports(WS_A);
    check("report: 4 rows listed", reports.length === 4, `${reports.length}`);
    check("report: banner count is 4", unacknowledgedCount === 4, `${unacknowledgedCount}`);
    const renamedRow = reports.find((r) => r.changeType === "renamed");
    check(
      "report: renamed row carries oldSlug",
      renamedRow?.oldSlug === "STRIPE_CREATE_CUSTOMER" && renamedRow?.toolSlug === "STRIPE_NEW_CUSTOMER",
    );

    // ── 4. RLS on composio_catalog_drift ──
    const rls = (await prisma.$queryRawUnsafe(
      `SELECT c.relname AS tablename, c.relrowsecurity AS rowsecurity,
              c.relforcerowsecurity AS force_rowsecurity
         FROM pg_class c WHERE c.relname = 'composio_catalog_drift'`,
    )) as Array<{ tablename: string; rowsecurity: boolean; force_rowsecurity: boolean }>;
    check(
      "rls: FORCE ROW LEVEL SECURITY on composio_catalog_drift",
      rls.length === 1 && rls[0].rowsecurity && rls[0].force_rowsecurity,
    );
    const policies = (await prisma.$queryRawUnsafe(
      `SELECT policyname FROM pg_policies WHERE tablename = 'composio_catalog_drift'`,
    )) as Array<{ policyname: string }>;
    check(
      "rls: tenant_isolation policy present",
      policies.some((p) => p.policyname === "composio_catalog_drift_tenant_isolation"),
    );
    check("rls: no-GUC read returns zero", (await countWithoutScope("composio_catalog_drift")) === 0);
    const crossRead = await withWorkspaceScope(WS_B, (tx) =>
      tx.composioCatalogDrift.count({ where: { workspaceId: WS_A } }),
    );
    check("rls: workspace B cannot read workspace A's drift rows", crossRead === 0, `${crossRead}`);
    const ownRead = await withWorkspaceScope(WS_A, (tx) =>
      tx.composioCatalogDrift.count({ where: { workspaceId: WS_A } }),
    );
    check("rls: workspace A reads its own drift rows", ownRead === 4, `${ownRead}`);
    let crossAckThrew = false;
    try {
      await acknowledgeDrift(WS_B, reports[0].id);
    } catch (e) {
      crossAckThrew = /not found/i.test((e as Error).message);
    }
    check("rls: workspace B cannot acknowledge workspace A's row", crossAckThrew);
    let badIdThrew = false;
    try {
      await acknowledgeDrift(WS_A, "drift-id-does-not-exist");
    } catch {
      badIdThrew = true;
    }
    check("acknowledge: unknown id throws", badIdThrew);

    // ── 5. added tool proposed through the gate → HIGH-GATED floor ──
    // The added tool has NO cache row: the gate must catch it via the
    // slice-2 universal conservative floor, with zero special-casing.
    const preCache = await withWorkspaceScope(WS_A, (tx) =>
      tx.composioToolCatalog.count({ where: { workspaceId: WS_A, toolSlug: ADDED_EXPECTED[0] } }),
    );
    check("floor: added tool has no cache row", preCache === 0, `${preCache}`);
    const derived = deriveTier(ADDED_EXPECTED[0], undefined, "stripe");
    check(
      "floor: added tool is unclassifiable (conservative floor)",
      derived.classified === false && derived.tier === "high",
      JSON.stringify(derived),
    );
    const proposed = await proposeAction({
      workspaceId: WS_A,
      appKey: "stripe",
      toolName: ADDED_EXPECTED[0],
      args: {},
      proposedBy: "drift-battery",
    });
    check("floor: proposal creates a pending approval", proposed.approval.status === "pending");
    check("floor: approval tier is high", proposed.approval.riskTier === "high");
    check(
      "floor: classified=false, never auto-executable (needs approval + second confirm)",
      proposed.classified.classified === false &&
        proposed.classified.tier === "high" &&
        proposed.classified.autoExecutable === false,
      JSON.stringify({
        classified: proposed.classified.classified,
        tier: proposed.classified.tier,
        autoExecutable: proposed.classified.autoExecutable,
      }),
    );

    // ── 6. removed tools keep their last-known cache rows ──
    const driftRefresh = await refreshCatalogForConnection(WS_A, "stripe");
    check("drift refresh: fresh list has 11 tools (8 kept + 3 new)", driftRefresh.toolCount === 11, `${driftRefresh.toolCount}`);
    const removedRow = await withWorkspaceScope(WS_A, (tx) =>
      tx.composioToolCatalog.findFirst({
        where: { workspaceId: WS_A, toolSlug: REMOVED_EXPECTED[0] },
      }),
    );
    check("removed: cache row KEPT after drift refresh", removedRow !== null);
    check("removed: kept row not re-stamped (version 1)", removedRow?.version === 1, `v${removedRow?.version}`);
    const rowCount = await withWorkspaceScope(WS_A, (tx) =>
      tx.composioToolCatalog.count({ where: { workspaceId: WS_A, appKey: "stripe" } }),
    );
    check("drift refresh: 13 rows (10 kept + 3 new)", rowCount === 13, `${rowCount}`);

    // ── 7. stale overrides ──
    const stale = await getStaleOverrides(WS_A);
    check(
      "stale: renamed tool's override flagged",
      stale.some((s) => s.toolSlug === "STRIPE_CREATE_CUSTOMER"),
      JSON.stringify(stale),
    );
    check(
      "stale: untouched override NOT flagged",
      !stale.some((s) => s.toolSlug === "STRIPE_GET_CUSTOMER"),
    );
    check(
      "stale: reason names the new slug",
      stale.some((s) => s.toolSlug === "STRIPE_CREATE_CUSTOMER" && /STRIPE_NEW_CUSTOMER/.test(s.reason)),
    );

    // ── 8. acknowledge clears the banner count + stale flag ──
    if (!renamedRow) throw new Error("renamed row missing");
    const acked = await acknowledgeDrift(WS_A, renamedRow.id);
    check("acknowledge: marks acknowledgedAt", acked.acknowledgedAt instanceof Date);
    const after = await listDriftReports(WS_A);
    check("acknowledge: banner count drops 4 → 3", after.unacknowledgedCount === 3, `${after.unacknowledgedCount}`);
    const staleAfter = await getStaleOverrides(WS_A);
    check("acknowledge: stale-override flag cleared for the renamed tool", staleAfter.length === 0, JSON.stringify(staleAfter));
    const removedRowStill = after.reports.find(
      (r) => r.changeType === "removed" && r.acknowledgedAt === null,
    );
    check("acknowledge: removed drift still flagged until acknowledged", removedRowStill !== undefined);

    await cleanup();
    console.log(`\n${pass} passed, ${fail} failed`);
  } finally {
    setFixtureDriftMode(false);
  }
  await prisma.$disconnect();
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error("battery crashed:", e);
  setFixtureDriftMode(false);
  process.exit(2);
});
