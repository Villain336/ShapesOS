#!/usr/bin/env tsx
// Marketr — Phase 15 slice 3 battery: toolkit directory UI + WorkspaceToolkit
// enablement (+ gate enforcement).
//
// Battery (fixture-based, DB-backed against the local durable DB):
//   1. listDirectory: >= 8 toolkits, expected slugs, valid categories,
//      v1 five enabled-by-default, non-v1 disabled by default,
//      tool counts + tier breakdowns (gmail: 9 tools, 4 low / 3 medium /
//      2 high / 0 unclassified — derived from the pinned v1 baseline)
//   2. setToolkitEnabled enable/disable round-trip persists (row + enabledBy)
//   3. RLS: FORCE on, no-GUC reads zero, workspace A cannot see B's rows
//   4. gate: proposeAction with a disabled toolkit's tool throws fail-closed,
//      no approval created, refusal logged (status "denied")
//   5. backward compat: v1 app tools proposable on a fresh workspace with no
//      WorkspaceToolkit rows and no catalog rows
//   6. unknown tool (no toolkit resolvable) throws fail-closed
//   7. stripe: catalog refresh + explicit enable → proposable; disable → throws
//   8. earlier batteries still green (discovery + derivation rerun here)
//
// Run: npx tsx scripts/verify-phase15-toolkits.mts
// Requires: DATABASE_URL (local durable Postgres).

import "dotenv/config";
import { execSync } from "node:child_process";
import { prisma } from "../lib/prisma";
import {
  withWorkspaceScope,
  countWithoutScope,
} from "../lib/substrate/memory/rls";
import {
  listDirectory,
  setToolkitEnabled,
  isToolkitEnabled,
  resolveToolkitForTool,
  listWorkspaceToolkits,
  TOOLKIT_CATEGORIES,
  V1_TOOLKIT_SLUGS,
} from "../lib/integrations/actions/toolkits";
import { refreshCatalogForConnection } from "../lib/integrations/actions/discovery";
import { proposeAction, listApprovals } from "../lib/integrations/actions/gate";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`); }
}

const WS_A = "15-toolkits-a";
const WS_B = "15-toolkits-b";
const WS_C = "15-toolkits-c"; // fresh workspace, no rows anywhere

const EXPECTED_TOOLKITS = [
  "gmail", "google_sheets", "slack", "hubspot", "notion",
  "salesforce", "zendesk", "stripe",
];

async function ensureWorkspaces() {
  for (const id of [WS_A, WS_B, WS_C]) {
    await prisma.workspace.deleteMany({ where: { id } });
    await prisma.workspace.create({
      data: { id, name: `15 toolkits battery ${id}`, ownerUserId: "15-toolkits-owner" },
    });
  }
}

async function cleanup() {
  for (const ws of [WS_A, WS_B, WS_C]) {
    await withWorkspaceScope(ws, (tx) =>
      tx.composioToolCatalog.deleteMany({ where: { workspaceId: ws } }),
    );
    await withWorkspaceScope(ws, (tx) =>
      tx.workspaceToolkit.deleteMany({ where: { workspaceId: ws } }),
    );
    await withWorkspaceScope(ws, (tx) =>
      tx.composioActionApproval.deleteMany({ where: { workspaceId: ws } }),
    );
    await withWorkspaceScope(ws, (tx) =>
      tx.composioActionLog.deleteMany({ where: { workspaceId: ws } }),
    );
    await prisma.workspace.deleteMany({ where: { id: ws } });
  }
}

async function proposeRefuses(workspaceId: string, appKey: string, toolName: string): Promise<boolean> {
  try {
    await proposeAction({
      workspaceId,
      appKey,
      toolName,
      args: {},
      proposedBy: "battery",
    });
    return false;
  } catch (e) {
    return /toolkit gate/i.test((e as Error).message);
  }
}

async function main() {
  console.log("Phase 15 slice 3 toolkit battery…");
  await ensureWorkspaces();

  // ── 1. directory ──
  const dir = await listDirectory(WS_A);
  check("directory: >= 8 toolkits", dir.length >= 8, `${dir.length}`);
  const slugs = dir.map((t) => t.toolkitSlug);
  check(
    "directory: expected slugs present",
    EXPECTED_TOOLKITS.every((s) => slugs.includes(s)),
    slugs.join(","),
  );
  check(
    "directory: categories all valid",
    dir.every((t) => (TOOLKIT_CATEGORIES as string[]).includes(t.category)),
  );
  check(
    "directory: v1 five enabled-by-default",
    V1_TOOLKIT_SLUGS.every((s) => dir.find((t) => t.toolkitSlug === s)?.enabled === true),
  );
  check(
    "directory: non-v1 disabled-by-default (firehose opt-in)",
    ["salesforce", "zendesk", "stripe"].every(
      (s) => dir.find((t) => t.toolkitSlug === s)?.enabled === false,
    ),
  );
  check(
    "directory: tool counts nonzero",
    dir.every((t) => t.toolCount > 0),
  );
  const gmail = dir.find((t) => t.toolkitSlug === "gmail")!;
  check(
    "directory: gmail breakdown 4 low / 3 medium / 2 high / 0 unclassified",
    gmail.toolCount === 9 &&
      gmail.tierBreakdown.low === 4 &&
      gmail.tierBreakdown.medium === 3 &&
      gmail.tierBreakdown.high === 2 &&
      gmail.tierBreakdown.unclassified === 0,
    JSON.stringify(gmail.tierBreakdown),
  );
  const stripeDir = dir.find((t) => t.toolkitSlug === "stripe")!;
  check(
    "directory: stripe breakdown 3 low / 5 medium / 2 high / 0 unclassified",
    stripeDir.toolCount === 10 &&
      stripeDir.tierBreakdown.low === 3 &&
      stripeDir.tierBreakdown.medium === 5 &&
      stripeDir.tierBreakdown.high === 2 &&
      stripeDir.tierBreakdown.unclassified === 0,
    JSON.stringify(stripeDir.tierBreakdown),
  );
  check(
    "directory: category sanity (gmail=comms, hubspot=crm, stripe=payments, zendesk=support)",
    dir.find((t) => t.toolkitSlug === "gmail")?.category === "comms" &&
      dir.find((t) => t.toolkitSlug === "hubspot")?.category === "crm" &&
      stripeDir.category === "payments" &&
      dir.find((t) => t.toolkitSlug === "zendesk")?.category === "support",
  );

  // ── 2. enable/disable round-trip ──
  check("enablement: stripe disabled by default", (await isToolkitEnabled(WS_A, "stripe")) === false);
  const en1 = await setToolkitEnabled({ workspaceId: WS_A, toolkitSlug: "stripe", enabled: true, userId: "battery-user" });
  check("enablement: enable returns { slug, enabled:true }", en1.enabled === true && en1.toolkitSlug === "stripe");
  check("enablement: enabled persists", (await isToolkitEnabled(WS_A, "stripe")) === true);
  const rows1 = await listWorkspaceToolkits(WS_A);
  const stripeRow = rows1.find((r) => r.toolkitSlug === "stripe");
  check("enablement: row records enabledBy", stripeRow?.enabledBy === "battery-user");
  await setToolkitEnabled({ workspaceId: WS_A, toolkitSlug: "stripe", enabled: false, userId: "battery-user" });
  check("enablement: disable persists", (await isToolkitEnabled(WS_A, "stripe")) === false);
  await setToolkitEnabled({ workspaceId: WS_A, toolkitSlug: "stripe", enabled: true, userId: "battery-user" });
  check("enablement: re-enable persists", (await isToolkitEnabled(WS_A, "stripe")) === true);
  let unknownThrew = false;
  try {
    await setToolkitEnabled({ workspaceId: WS_A, toolkitSlug: "does-not-exist", enabled: true, userId: "battery-user" });
  } catch { unknownThrew = true; }
  check("enablement: unknown toolkit throws", unknownThrew);
  check(
    "enablement: explicit disable of a v1 toolkit wins over the default",
    await (async () => {
      await setToolkitEnabled({ workspaceId: WS_A, toolkitSlug: "gmail", enabled: false, userId: "battery-user" });
      const e = await isToolkitEnabled(WS_A, "gmail");
      await setToolkitEnabled({ workspaceId: WS_A, toolkitSlug: "gmail", enabled: true, userId: "battery-user" });
      return e === false && (await isToolkitEnabled(WS_A, "gmail")) === true;
    })(),
  );

  // ── 3. RLS isolation ──
  check("rls: no-GUC reads see zero rows", (await countWithoutScope("workspace_toolkits")) === 0);
  const rowsB = await listWorkspaceToolkits(WS_B);
  check("rls: workspace B sees none of A's rows", rowsB.length === 0);
  check(
    "rls: directory for B shows stripe disabled (A's enablement invisible)",
    (await isToolkitEnabled(WS_B, "stripe")) === false,
  );
  let crossRows = -1;
  try {
    crossRows = await withWorkspaceScope(WS_B, (tx) =>
      tx.workspaceToolkit.findMany({ where: { workspaceId: WS_A } }),
    ).then((r) => r.length);
  } catch { crossRows = -2; }
  // With FORCE RLS the query succeeds but returns zero rows — that's the
  // isolation proof (no error, no rows).
  check("rls: cross-workspace scoped read returns zero rows", crossRows === 0, `got ${crossRows}`);

  // ── 4. gate refusal for disabled toolkit ──
  await setToolkitEnabled({ workspaceId: WS_A, toolkitSlug: "gmail", enabled: false, userId: "battery-user" });
  const refused = await proposeRefuses(WS_A, "gmail", "GMAIL_LIST_MESSAGES");
  check("gate: disabled toolkit's tool refused fail-closed", refused);
  const approvalsAfter = await listApprovals(WS_A, { status: "all" });
  check("gate: refusal creates no approval", approvalsAfter.length === 0, `${approvalsAfter.length}`);
  const refusalLogs = await withWorkspaceScope(WS_A, (tx) =>
    tx.composioActionLog.findMany({ where: { workspaceId: WS_A } }),
  );
  check(
    "gate: refusal is logged (denied, gate actor)",
    refusalLogs.length === 1 &&
      refusalLogs[0].status === "denied" &&
      refusalLogs[0].executedBy === "gate:battery",
    `${refusalLogs.length}`,
  );
  await setToolkitEnabled({ workspaceId: WS_A, toolkitSlug: "gmail", enabled: true, userId: "battery-user" });
  const okAfterReenable = await (async () => {
    try {
      await proposeAction({ workspaceId: WS_A, appKey: "gmail", toolName: "GMAIL_LIST_MESSAGES", args: {}, proposedBy: "battery" });
      return true;
    } catch { return false; }
  })();
  check("gate: re-enabled toolkit's tool proposable again", okAfterReenable);

  // ── 5. backward compat: v1 tools proposable with no rows anywhere ──
  const v1ok = await (async () => {
    try {
      const r = await proposeAction({
        workspaceId: WS_C,
        appKey: "gmail",
        toolName: "GMAIL_SEND_EMAIL",
        args: { to: "a@b.c" },
        proposedBy: "battery",
      });
      return r.classified.tier === "medium";
    } catch (e) {
      console.log("    backward-compat error:", (e as Error).message);
      return false;
    }
  })();
  check("backward compat: v1 tool proposable on fresh workspace (zero regression)", v1ok);
  check(
    "backward compat: resolver maps v1 slugs via pinned catalog",
    (await resolveToolkitForTool(WS_C, "SLACK_SEND_MESSAGE")) === "slack" &&
      (await resolveToolkitForTool(WS_C, "GOOGLE_SHEETS_APPEND_VALUES")) === "google_sheets",
  );

  // ── 6. unknown tool → conservative floor, NOT gate refusal (slice 2
  //      doctrine: unclassified lands high-gated, never auto-executable) ──
  const unknownResult = await proposeAction({
    workspaceId: WS_C,
    appKey: "frobnicator",
    toolName: "FROBNICATE_DO_SOMETHING",
    args: {},
    proposedBy: "battery",
  });
  check(
    "gate: unknown tool is NOT refused — lands high-gated per conservative floor",
    unknownResult.classified.tier === "high" && unknownResult.approval.status === "pending",
  );
  check(
    "gate: unknown tool proposal is not auto-executable",
    unknownResult.classified.autoExecutable !== true,
  );
  check("gate: resolver returns null for unknown", (await resolveToolkitForTool(WS_C, "FROBNICATE_DO_SOMETHING")) === null);

  // ── 7. stripe: catalog + explicit enable → proposable; disable → refused ──
  await refreshCatalogForConnection(WS_B, "stripe");
  check(
    "catalog: resolver uses workspace catalog for firehose tools",
    (await resolveToolkitForTool(WS_B, "STRIPE_LIST_CUSTOMERS")) === "stripe",
  );
  const stripeRefusedBefore = await proposeRefuses(WS_B, "stripe", "STRIPE_LIST_CUSTOMERS");
  check("gate: stripe tool refused while toolkit disabled", stripeRefusedBefore);
  await setToolkitEnabled({ workspaceId: WS_B, toolkitSlug: "stripe", enabled: true, userId: "battery-user" });
  const stripeOk = await (async () => {
    try {
      const r = await proposeAction({
        workspaceId: WS_B,
        appKey: "stripe",
        toolName: "STRIPE_LIST_CUSTOMERS",
        args: {},
        proposedBy: "battery",
      });
      return r.classified.tier === "low";
    } catch (e) {
      console.log("    stripe error:", (e as Error).message);
      return false;
    }
  })();
  check("gate: stripe tool proposable after explicit enable", stripeOk);
  await setToolkitEnabled({ workspaceId: WS_B, toolkitSlug: "stripe", enabled: false, userId: "battery-user" });
  check("gate: stripe tool refused again after disable", await proposeRefuses(WS_B, "stripe", "STRIPE_CREATE_CUSTOMER"));

  // ── 8. earlier batteries stay green ──
  for (const script of ["scripts/verify-phase15-discovery.mts", "scripts/verify-phase15-derivation.mts"]) {
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
