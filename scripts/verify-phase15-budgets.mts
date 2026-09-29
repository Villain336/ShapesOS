#!/usr/bin/env tsx
// Marketr — Phase 15 slice 4 battery: per-workspace call budgets + 80%
// overage alerts + per-toolkit cost attribution.
//
// Battery (fixture-based, DB-backed against the local durable DB):
//   1. set/get workspace budget round-trip (+ validation rejects bad input)
//   2. usage counting from executed logs (success/failed counted; denied/
//      expired and previous-month rows ignored)
//   3. 80% alert fires exactly once, then re-arms after usage drops
//   4. hard cap blocks executeApproved fail-closed (no execution log,
//      refusal recorded as "denied", approval stays "approved")
//   5. soft cap never blocks (execution proceeds past the budget gate)
//   6. per-toolkit attribution sums to total (unknown bucket for unattributed)
//   7. logAction writes toolkitSlug onto ComposioActionLog rows
//   8. RLS isolation on workspace_action_budgets
//   9. earlier batteries still green (discovery + derivation + toolkits)
//
// Run: npx tsx scripts/verify-phase15-budgets.mts
// Requires: DATABASE_URL (local durable Postgres).

import "dotenv/config";
import { execSync } from "node:child_process";
import { prisma } from "../lib/prisma";
import {
  withWorkspaceScope,
  countWithoutScope,
} from "../lib/substrate/memory/rls";
import {
  getWorkspaceBudget,
  setWorkspaceBudget,
  getUsageByToolkit,
  checkBudget,
  countExecutedCalls,
  TOOLKIT_ATTRIBUTION_UNKNOWN,
} from "../lib/integrations/actions/budget";
import {
  proposeAction,
  decideApproval,
  executeApproved,
  logAction,
} from "../lib/integrations/actions/gate";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`); }
}

const WS_A = "15-budgets-a"; // soft cap
const WS_B = "15-budgets-b"; // hard cap
const WS_C = "15-budgets-c"; // alert fire-once / re-arm
const WS_D = "15-budgets-d"; // RLS cross-check
const WS_E = "15-budgets-e"; // attribution
const ALL = [WS_A, WS_B, WS_C, WS_D, WS_E];

async function ensureWorkspaces() {
  for (const id of ALL) {
    await prisma.workspace.deleteMany({ where: { id } });
    await prisma.workspace.create({
      data: { id, name: `15 budgets battery ${id}`, ownerUserId: "15-budgets-owner" },
    });
  }
}

async function cleanup() {
  for (const ws of ALL) {
    await withWorkspaceScope(ws, (tx) =>
      tx.composioActionLog.deleteMany({ where: { workspaceId: ws } }),
    );
    await withWorkspaceScope(ws, (tx) =>
      tx.composioActionApproval.deleteMany({ where: { workspaceId: ws } }),
    );
    await withWorkspaceScope(ws, (tx) =>
      tx.workspaceActionBudget.deleteMany({ where: { workspaceId: ws } }),
    );
    await prisma.workspace.deleteMany({ where: { id: ws } });
  }
}

/** Write an executed (counted) fixture log. */
async function execLog(workspaceId: string, toolkitSlug: string | null, n = 1) {
  for (let i = 0; i < n; i++) {
    await logAction({
      workspaceId,
      appKey: "gmail",
      toolName: "GMAIL_LIST_MESSAGES",
      riskTier: "low",
      toolkitSlug,
      status: "success",
      executedBy: "battery",
    });
  }
}

async function main() {
  console.log("Phase 15 slice 4 budgets battery…");
  await ensureWorkspaces();

  // ── 1. set/get round-trip ──
  const def = await getWorkspaceBudget(WS_A);
  check("budget: defaults (no row)", def.monthlyCallBudget === null && def.hardCap === false && def.alertThresholdPct === 80);
  const set1 = await setWorkspaceBudget(WS_A, { monthlyCallBudget: 10 });
  check("budget: set monthlyCallBudget=10", set1.monthlyCallBudget === 10 && set1.hardCap === false && set1.alertThresholdPct === 80);
  const set2 = await setWorkspaceBudget(WS_A, { hardCap: true, alertThresholdPct: 90 });
  check("budget: partial update keeps budget", set2.monthlyCallBudget === 10 && set2.hardCap === true && set2.alertThresholdPct === 90);
  const got = await getWorkspaceBudget(WS_A);
  check("budget: get reflects updates", got.monthlyCallBudget === 10 && got.hardCap === true);
  // reset WS_A to the soft-cap fixture the rest of the battery expects
  await setWorkspaceBudget(WS_A, { hardCap: false, alertThresholdPct: 80 });
  for (const bad of [
    () => setWorkspaceBudget(WS_A, { monthlyCallBudget: 0 }),
    () => setWorkspaceBudget(WS_A, { monthlyCallBudget: -5 }),
    () => setWorkspaceBudget(WS_A, { monthlyCallBudget: 2.5 }),
    () => setWorkspaceBudget(WS_A, { alertThresholdPct: 0 }),
    () => setWorkspaceBudget(WS_A, { alertThresholdPct: 101 }),
  ]) {
    let threw = false;
    try { await bad(); } catch { threw = true; }
    check("budget: invalid config throws fail-closed", threw);
  }
  const cleared = await setWorkspaceBudget(WS_A, { monthlyCallBudget: null });
  check("budget: null clears the budget", cleared.monthlyCallBudget === null);
  await setWorkspaceBudget(WS_A, { monthlyCallBudget: 10 });

  // ── 2. usage counting ──
  await execLog(WS_A, "gmail", 3);
  await logAction({ workspaceId: WS_A, appKey: "gmail", toolName: "GMAIL_LIST_MESSAGES", riskTier: "low", status: "failed", executedBy: "battery" });
  await logAction({ workspaceId: WS_A, appKey: "gmail", toolName: "GMAIL_LIST_MESSAGES", riskTier: "low", status: "denied", executedBy: "battery" });
  await logAction({ workspaceId: WS_A, appKey: "gmail", toolName: "GMAIL_LIST_MESSAGES", riskTier: "low", status: "expired", executedBy: "battery" });
  // previous-month executed row must not count
  await withWorkspaceScope(WS_A, (tx) =>
    tx.composioActionLog.create({
      data: {
        workspaceId: WS_A,
        appKey: "gmail",
        toolName: "GMAIL_LIST_MESSAGES",
        riskTier: "low",
        status: "success",
        executedBy: "battery",
        createdAt: new Date(Date.UTC(2026, 7, 15)), // 2026-08, previous month
      },
    }),
  );
  check("usage: counts success+failed only", (await countExecutedCalls(WS_A)) === 4);

  // ── 3. 80% alert fires exactly once, then re-arms ──
  await setWorkspaceBudget(WS_C, { monthlyCallBudget: 10, hardCap: false, alertThresholdPct: 80 });
  await execLog(WS_C, "hubspot", 7);
  const pre = await checkBudget(WS_C);
  check("alert: below threshold → no alert", pre.alertDue === false && pre.pct === 70 && pre.usage === 7 && pre.budget === 10);
  await execLog(WS_C, "hubspot", 1); // 8/10 = 80%
  const cross = await checkBudget(WS_C);
  check("alert: crossing 80% → alertDue true", cross.alertDue === true && cross.pct === 80);
  const after = await getWorkspaceBudget(WS_C);
  check("alert: lastAlertedPct recorded", after.lastAlertedPct === 80);
  const again = await checkBudget(WS_C);
  check("alert: fire-once (no re-fire)", again.alertDue === false);
  await execLog(WS_C, "hubspot", 1); // 9/10
  check("alert: rising above threshold does not re-fire", (await checkBudget(WS_C)).alertDue === false);
  // usage drops below threshold (new month) → re-arm
  await withWorkspaceScope(WS_C, (tx) => tx.composioActionLog.deleteMany({ where: { workspaceId: WS_C } }));
  await checkBudget(WS_C);
  check("alert: re-arms when usage drops below threshold", (await getWorkspaceBudget(WS_C)).lastAlertedPct === null);
  await execLog(WS_C, "hubspot", 8);
  check("alert: fires again after re-arm", (await checkBudget(WS_C)).alertDue === true);

  // ── 4. hard cap blocks executeApproved fail-closed ──
  await setWorkspaceBudget(WS_B, { monthlyCallBudget: 2, hardCap: true, alertThresholdPct: 80 });
  await execLog(WS_B, "gmail", 2);
  const prop = await proposeAction({ workspaceId: WS_B, appKey: "gmail", toolName: "GMAIL_LIST_MESSAGES", args: {}, proposedBy: "battery" });
  await decideApproval({ workspaceId: WS_B, approvalId: prop.approval.id, decision: "approved", decidedBy: "battery" });
  let blockedErr = "";
  try {
    await executeApproved({ workspaceId: WS_B, approvalId: prop.approval.id, executedBy: "battery" });
  } catch (e) {
    blockedErr = (e as Error).message;
  }
  check("hard cap: executeApproved refuses", /budget exhausted|hard cap/i.test(blockedErr), blockedErr.slice(0, 120));
  const execRows = await withWorkspaceScope(WS_B, (tx) =>
    tx.composioActionLog.findMany({
      where: { workspaceId: WS_B, approvalId: prop.approval.id, status: { in: ["success", "failed"] } },
    }),
  );
  check("hard cap: no log of execution", execRows.length === 0);
  const refusal = await withWorkspaceScope(WS_B, (tx) =>
    tx.composioActionLog.findFirst({
      where: { workspaceId: WS_B, approvalId: prop.approval.id, status: "denied" },
      select: { resultSummary: true, executedBy: true },
    }),
  );
  check(
    "hard cap: refusal recorded (denied row with reason)",
    refusal !== null && JSON.stringify(refusal.resultSummary).includes("budgetRefusal") && refusal.executedBy === "gate:battery",
  );
  const approvalAfter = await withWorkspaceScope(WS_B, (tx) =>
    tx.composioActionApproval.findFirst({ where: { id: prop.approval.id }, select: { status: true } }),
  );
  check("hard cap: approval stays approved (runnable next month)", approvalAfter?.status === "approved");
  check("hard cap: checkBudget reports blocked", (await checkBudget(WS_B)).blocked === true);

  // ── 5. soft cap never blocks ──
  // WS_A: budget 10 soft, 4 executed calls — push over 100% to prove the
  // soft cap still never blocks.
  await setWorkspaceBudget(WS_A, { monthlyCallBudget: 4, hardCap: false });
  const propA = await proposeAction({ workspaceId: WS_A, appKey: "gmail", toolName: "GMAIL_LIST_MESSAGES", args: {}, proposedBy: "battery" });
  await decideApproval({ workspaceId: WS_A, approvalId: propA.approval.id, decision: "approved", decidedBy: "battery" });
  let softErr = "";
  try {
    await executeApproved({ workspaceId: WS_A, approvalId: propA.approval.id, executedBy: "battery" });
  } catch (e) {
    softErr = (e as Error).message;
  }
  check(
    "soft cap: never blocks on budget (fails later at the connection, not the budget gate)",
    !/budget exhausted|hard cap/i.test(softErr) && /not connected/i.test(softErr),
    softErr.slice(0, 120),
  );
  check("soft cap: checkBudget reports not blocked", (await checkBudget(WS_A)).blocked === false);

  // ── 6. per-toolkit attribution sums to total ──
  await execLog(WS_E, "hubspot", 4);
  await execLog(WS_E, "gmail", 3);
  await execLog(WS_E, null, 2); // unattributed bucket
  await logAction({ workspaceId: WS_E, appKey: "gmail", toolName: "GMAIL_LIST_MESSAGES", riskTier: "low", status: "denied", executedBy: "battery" });
  const attr = await getUsageByToolkit(WS_E);
  check("attribution: total counts executed only", attr.total === 9, `${attr.total}`);
  check("attribution: per-toolkit breakdown", attr.byToolkit.hubspot === 4 && attr.byToolkit.gmail === 3);
  check("attribution: unknown bucket", attr.byToolkit[TOOLKIT_ATTRIBUTION_UNKNOWN] === 2);
  const sum = Object.values(attr.byToolkit).reduce((a, b) => a + b, 0);
  check("attribution: sums to total", sum === attr.total, `${sum} vs ${attr.total}`);

  // ── 7. toolkitSlug written on log rows ──
  const row = await withWorkspaceScope(WS_E, (tx) =>
    tx.composioActionLog.findFirst({
      where: { workspaceId: WS_E, toolkitSlug: "hubspot", status: "success" },
      select: { toolkitSlug: true },
    }),
  );
  check("log: toolkitSlug persisted on ComposioActionLog", row?.toolkitSlug === "hubspot");
  const listed = await withWorkspaceScope(WS_E, (tx) =>
    tx.composioActionLog.findFirst({
      where: { workspaceId: WS_E },
      select: { toolkitSlug: true },
    }),
  );
  check("log: column readable", listed !== null && "toolkitSlug" in listed);

  // ── 8. RLS isolation on workspace_action_budgets ──
  await setWorkspaceBudget(WS_D, { monthlyCallBudget: 50, hardCap: true });
  const noScope = await countWithoutScope("workspace_action_budgets");
  check("rls: no-GUC reads see zero rows (fail-closed)", noScope === 0, `${noScope}`);
  const crossRead = await withWorkspaceScope(WS_A, (tx) => tx.workspaceActionBudget.findMany());
  check(
    "rls: workspace A cannot see D's budget row",
    crossRead.every((r) => r.workspaceId === WS_A),
    crossRead.map((r) => r.workspaceId).join(","),
  );
  const ownRead = await withWorkspaceScope(WS_D, (tx) =>
    tx.workspaceActionBudget.findUnique({ where: { workspaceId: WS_D } }),
  );
  check("rls: workspace D sees its own row", ownRead?.monthlyCallBudget === 50 && ownRead?.hardCap === true);

  // ── 9. earlier batteries still green ──
  for (const script of [
    "scripts/verify-phase15-discovery.mts",
    "scripts/verify-phase15-derivation.mts",
    "scripts/verify-phase15-toolkits.mts",
  ]) {
    try {
      execSync(`npx tsx ${script}`, {
        cwd: process.cwd(),
        stdio: "pipe",
        env: { ...process.env, FORCE_COLOR: "0" },
        timeout: 180_000,
      });
      check(`regression: ${script} green`, true);
    } catch (e) {
      const out = ((e as { stdout?: Buffer }).stdout ?? Buffer.from("")).toString().slice(-800);
      check(`regression: ${script} green`, false, out);
    }
  }

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("battery crashed:", e);
  process.exit(1);
});
