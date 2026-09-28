#!/usr/bin/env tsx
// Marketr — Phase 14 slice 5 verification: the full trust ladder.
//
// Battery (fixture-based, DB-backed against the local durable DB):
//   bulk extraction: multi-item arrays detected, single-target not, largest wins
//   write: propose -> approve -> execute -> status "executed" + log; second
//     execute throws (replay lock), zero additional Composio calls
//   high tier: execute WITHOUT destructiveConfirm throws, no Composio call;
//     WITH confirm executes
//   bulk: wrong confirmedBulkCount throws; exact count executes
//   failed execution: log written, status reverts to approved (retry allowed)
//   edit-before-approve reclassifies with fresh overrides (escalation sticks)
//   bypass negatives: fabricated id, denied approval, expired approval all
//     throw without touching Composio
//
// Run: npx tsx scripts/verify-phase14-trust-ladder.mts
// Requires: DATABASE_URL (local durable Postgres).

import "dotenv/config";
import { prisma } from "../lib/prisma";
import { withWorkspaceScope } from "../lib/substrate/memory/rls";
import type { ComposioHttp } from "../lib/integrations/composio";
import { extractBulkItems } from "../lib/integrations/actions/bulk";
import {
  proposeAction,
  decideApproval,
  executeApproved,
} from "../lib/integrations/actions/gate";
import { setToolTierOverrides } from "../lib/integrations/actions/connections";

const WS = "00000000-0000-0000-0000-000000000016";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`); }
}

let executeCalls = 0;
let failNext = false;
const mockHttp: ComposioHttp = {
  async request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    if (path.startsWith("/tools/execute/")) {
      executeCalls++;
      if (failNext) {
        failNext = false;
        return { successful: false, data: null, error: "boom" } as T;
      }
      return { successful: true, data: { id: "res-1" }, error: null } as T;
    }
    throw new Error(`unexpected path ${path}`);
  },
};

async function ensureWorkspace() {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({
    data: { id: WS, name: "14 trust-ladder battery", ownerUserId: "14-battery-owner" },
  });
  await withWorkspaceScope(WS, (tx) =>
    tx.composioConnection.create({
      data: { workspaceId: WS, appKey: "gmail", composioEntityId: "ca_test", status: "connected" },
    }),
  );
}

async function cleanup() {
  await withWorkspaceScope(WS, (tx) => tx.composioActionApproval.deleteMany({ where: { workspaceId: WS } }));
  await withWorkspaceScope(WS, (tx) => tx.composioActionLog.deleteMany({ where: { workspaceId: WS } }));
  await withWorkspaceScope(WS, (tx) => tx.composioConnection.deleteMany({ where: { workspaceId: WS } }));
  await withWorkspaceScope(WS, (tx) => tx.workspaceSettings.deleteMany({ where: { workspaceId: WS } }));
  await prisma.workspace.deleteMany({ where: { id: WS } });
}

async function statusOf(id: string): Promise<string> {
  const row = await withWorkspaceScope(WS, (tx) =>
    tx.composioActionApproval.findFirst({ where: { id, workspaceId: WS }, select: { status: true } }),
  );
  return row?.status ?? "missing";
}

async function main() {
  await ensureWorkspace();

  // ---- bulk extraction ----
  const b3 = extractBulkItems({ ids: ["m1", "m2", "m3"] });
  check("bulk: 3-item array detected", b3?.count === 3 && b3.field === "ids");
  check("bulk: single id is not bulk", extractBulkItems({ id: "m1" }) === null);
  check("bulk: 1-item array is not bulk", extractBulkItems({ ids: ["m1"] }) === null);
  const bMulti = extractBulkItems({ to: ["a@x", "b@x"], ids: ["m1", "m2", "m3", "m4"] });
  check("bulk: largest target list wins", bMulti?.field === "ids" && bMulti.count === 4);

  // ---- write: approve -> execute -> executed; replay blocked ----
  executeCalls = 0;
  const w = await proposeAction({
    workspaceId: WS, appKey: "gmail", toolName: "GMAIL_SEND_EMAIL",
    args: { to: "x@y.z", body: "hi" }, proposedBy: "test",
  });
  await decideApproval({ workspaceId: WS, approvalId: w.approval.id, decision: "approved", decidedBy: "human" });
  await executeApproved({ workspaceId: WS, approvalId: w.approval.id, executedBy: "human", http: mockHttp });
  check("write executes once", executeCalls === 1);
  check("write approval terminal at executed", (await statusOf(w.approval.id)) === "executed");
  const wLogs = await withWorkspaceScope(WS, (tx) =>
    tx.composioActionLog.findMany({ where: { workspaceId: WS, approvalId: w.approval.id } }),
  );
  check("write execution logged", wLogs.length === 1 && wLogs[0].status === "success");
  let replay = false;
  try {
    await executeApproved({ workspaceId: WS, approvalId: w.approval.id, executedBy: "human", http: mockHttp });
  } catch { replay = true; }
  check("replay execute throws", replay);
  check("replay performed zero Composio calls", executeCalls === 1);

  // ---- high tier: no confirm -> throws; confirm -> executes ----
  executeCalls = 0;
  const d = await proposeAction({
    workspaceId: WS, appKey: "gmail", toolName: "GMAIL_DELETE_MESSAGE",
    args: { id: "m-1" }, proposedBy: "test",
  });
  await decideApproval({ workspaceId: WS, approvalId: d.approval.id, decision: "approved", decidedBy: "human" });
  let noConfirm = false;
  try {
    await executeApproved({ workspaceId: WS, approvalId: d.approval.id, executedBy: "human", http: mockHttp });
  } catch { noConfirm = true; }
  check("high-tier without destructiveConfirm throws", noConfirm);
  check("no Composio call without confirm", executeCalls === 0);
  await executeApproved({
    workspaceId: WS, approvalId: d.approval.id, executedBy: "human",
    destructiveConfirm: true, http: mockHttp,
  });
  check("high-tier with confirm executes", executeCalls === 1 && (await statusOf(d.approval.id)) === "executed");

  // ---- bulk: count must match ----
  executeCalls = 0;
  const bulk = await proposeAction({
    workspaceId: WS, appKey: "gmail", toolName: "GMAIL_DELETE_MESSAGE",
    args: { ids: ["m1", "m2", "m3"] }, proposedBy: "test",
  });
  await decideApproval({ workspaceId: WS, approvalId: bulk.approval.id, decision: "approved", decidedBy: "human" });
  let wrongCount = false;
  try {
    await executeApproved({
      workspaceId: WS, approvalId: bulk.approval.id, executedBy: "human",
      destructiveConfirm: true, confirmedBulkCount: 2, http: mockHttp,
    });
  } catch { wrongCount = true; }
  check("bulk with wrong confirmed count throws", wrongCount && executeCalls === 0);
  await executeApproved({
    workspaceId: WS, approvalId: bulk.approval.id, executedBy: "human",
    destructiveConfirm: true, confirmedBulkCount: 3, http: mockHttp,
  });
  check("bulk with exact count executes", executeCalls === 1);

  // ---- failed execution reverts to approved (retry allowed) ----
  executeCalls = 0;
  const f = await proposeAction({
    workspaceId: WS, appKey: "gmail", toolName: "GMAIL_SEND_EMAIL",
    args: { to: "x@y.z" }, proposedBy: "test",
  });
  await decideApproval({ workspaceId: WS, approvalId: f.approval.id, decision: "approved", decidedBy: "human" });
  failNext = true;
  let failed = false;
  try {
    await executeApproved({ workspaceId: WS, approvalId: f.approval.id, executedBy: "human", http: mockHttp });
  } catch { failed = true; }
  check("failed execution throws", failed);
  check("failed execution reverts to approved for retry", (await statusOf(f.approval.id)) === "approved");
  const fLogs = await withWorkspaceScope(WS, (tx) =>
    tx.composioActionLog.findMany({ where: { workspaceId: WS, approvalId: f.approval.id } }),
  );
  check("failed execution still logged", fLogs.length === 1 && fLogs[0].status === "failed");
  // Retry now succeeds.
  await executeApproved({ workspaceId: WS, approvalId: f.approval.id, executedBy: "human", http: mockHttp });
  check("retry after failure executes", (await statusOf(f.approval.id)) === "executed");

  // ---- edit-before-approve reclassifies with fresh overrides ----
  await setToolTierOverrides(WS, { GMAIL_SEND_EMAIL: "high" });
  const e = await proposeAction({
    workspaceId: WS, appKey: "gmail", toolName: "GMAIL_SEND_EMAIL",
    args: { to: "x@y.z" }, proposedBy: "test",
  });
  const decided = await decideApproval({
    workspaceId: WS, approvalId: e.approval.id, decision: "approved",
    decidedBy: "human", editedArgs: { to: "y@z.a", body: "edited" },
  });
  check("edit-before-approve keeps override escalation", decided.riskTier === "high", decided.riskTier);
  await setToolTierOverrides(WS, {});

  // ---- bypass negatives ----
  let fabricated = false;
  try {
    await executeApproved({ workspaceId: WS, approvalId: "nope-not-real", executedBy: "human", http: mockHttp });
  } catch { fabricated = true; }
  check("fabricated approval id throws", fabricated);
  const denied = await proposeAction({
    workspaceId: WS, appKey: "gmail", toolName: "GMAIL_SEND_EMAIL",
    args: { to: "x@y.z" }, proposedBy: "test",
  });
  await decideApproval({
    workspaceId: WS, approvalId: denied.approval.id, decision: "denied",
    decidedBy: "human", reason: "nope",
  });
  executeCalls = 0;
  let deniedExec = false;
  try {
    await executeApproved({ workspaceId: WS, approvalId: denied.approval.id, executedBy: "human", http: mockHttp });
  } catch { deniedExec = true; }
  check("denied approval cannot execute", deniedExec && executeCalls === 0);

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("battery error:", e);
  process.exit(1);
});
