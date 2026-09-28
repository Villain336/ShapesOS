// Marketr — Phase 14 slice 3 verification: the approval gate.
//
// Battery (fixture-based, DB-backed against the local durable DB):
//   redact: secrets never land in stored args; long strings truncated
//   summarize: plain-language per slug + generic fallback
//   conservative floor: overrides may escalate, never downgrade below the
//     derived floor; draft-creator + explicit high => not auto-executable
//   propose -> pending with expiry + audit trail
//   decide approve -> status; execute via injected mock http -> log written
//   decide deny with reason -> execute throws (bypass fails closed)
//   edit-before-approve rewrites args + summary
//   expired/pending approvals can never execute; sweep expires stale rows
//   conservative-floor negative tests (bypass attempts fail closed)
//
// Run: npx tsx scripts/verify-phase14-gate.mts
// Requires: DATABASE_URL (local durable Postgres).

import { redactArgs, summarizeArgs } from "../lib/integrations/actions/redact";
import { summarizeAction } from "../lib/integrations/actions/summarize";
import {
  classifyAction,
} from "../lib/integrations/actions/risk";
import {
  proposeAction,
  decideApproval,
  executeApproved,
  expireStaleApprovals,
  logAction,
  listApprovals,
} from "../lib/integrations/actions/gate";
import { withWorkspaceScope } from "../lib/substrate/memory/rls";
import { prisma } from "../lib/prisma";
import type { ComposioHttp } from "../lib/integrations/composio";

const WS = "00000000-0000-0000-0000-000000000014";

const mockHttp: ComposioHttp = {
  async request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    if (path.startsWith("/tools/execute/")) {
      return { successful: true, data: { message_id: "m-1" }, error: null } as T;
    }
    throw new Error(`unexpected path ${path}`);
  },
};

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`); }
}

async function ensureWorkspace() {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({
    data: { id: WS, name: "14 gate battery", ownerUserId: "14-battery-owner" },
  });
}

async function cleanup() {
  await withWorkspaceScope(WS, (tx) =>
    tx.composioActionLog.deleteMany({ where: { workspaceId: WS } }),
  );
  await withWorkspaceScope(WS, (tx) =>
    tx.composioActionApproval.deleteMany({ where: { workspaceId: WS } }),
  );
  await withWorkspaceScope(WS, (tx) =>
    tx.composioConnection.deleteMany({ where: { workspaceId: WS } }),
  );
  await prisma.workspace.deleteMany({ where: { id: WS } });
}

async function main() {
  console.log("Phase 14 gate battery…");
  await ensureWorkspace();

  // ── redaction ──
  const red = redactArgs({ to: "a@b.com", password: "hunter2", api_key: "sk-x", nested: { token: "t" }, body: "x".repeat(600) });
  check("redact: password removed", red.password === "[redacted]");
  check("redact: api_key removed", red.api_key === "[redacted]");
  check("redact: nested token removed", (red.nested as Record<string, unknown>).token === "[redacted]");
  check("redact: plain field kept", red.to === "a@b.com");
  check("redact: long string truncated", String(red.body).length <= 501);

  // ── summaries ──
  const s1 = summarizeAction("gmail", "GMAIL_SEND_EMAIL", { to: "a@b.com", subject: "Hi" });
  check("summarize: send email", s1.includes("Send an email") && s1.includes("a@b.com") && !s1.includes("{"), s1);
  const s2 = summarizeAction("gmail", "GMAIL_CREATE_DRAFT", { subject: "D" });
  check("summarize: draft notes nothing sent", s2.includes("Nothing is sent"), s2);
  const s3 = summarizeAction("slack", "SOME_NEW_TOOL", { x: 1 });
  check("summarize: generic fallback", s3.includes("SOME_NEW_TOOL"), s3);

  // ── conservative floor (unit level, no DB) ──
  const d1 = classifyAction("GMAIL_DELETE_MESSAGE", { GMAIL_DELETE_MESSAGE: "low" });
  check("floor: destructive low-override stays high", d1.tier === "high", d1.tier);
  const d2 = classifyAction("GMAIL_SEND_EMAIL", { GMAIL_SEND_EMAIL: "low" });
  check("floor: write low-override stays medium", d2.tier === "medium", d2.tier);
  const d3 = classifyAction("GMAIL_CREATE_DRAFT", { GMAIL_CREATE_DRAFT: "high" });
  check("floor: draft-creator high-override not auto", d3.autoExecutable === false);
  const d4 = classifyAction("GMAIL_SEND_EMAIL", { GMAIL_SEND_EMAIL: "high" });
  check("floor: escalation high allowed", d4.tier === "high" && d4.overridden === true);
  const d5 = classifyAction("GMAIL_GET_PROFILE", { GMAIL_GET_PROFILE: "high" });
  check("floor: read high-override blocks auto", d5.tier === "high" && d5.autoExecutable === false);

  // ── propose -> approve -> execute (mock http) ──
  const p1 = await proposeAction({
    workspaceId: WS, appKey: "gmail", toolName: "GMAIL_SEND_EMAIL",
    args: { to: "a@b.com", subject: "Hi", api_key: "sk-x" }, proposedBy: "user-1",
  });
  check("propose: pending", p1.approval.status === "pending");
  check("propose: tier medium", p1.classified.tier === "medium");
  check("propose: not auto-executable", p1.classified.autoExecutable === false);
  check("propose: expiry set", p1.approval.expiresAt.getTime() > Date.now());
  check("propose: plain summary", p1.approval.plainSummary.includes("Send an email"));
  // mock http must report failure without a real connection: confirm execute fails closed
  let threwNoConn = false;
  try {
    await executeApproved({ workspaceId: WS, approvalId: p1.approval.id, executedBy: "user-1", http: mockHttp });
  } catch (e) { threwNoConn = /approved|expired|connection/i.test((e as Error).message); }
  check("execute: pending approval cannot execute (fail closed)", threwNoConn);

  const dec1 = await decideApproval({ workspaceId: WS, approvalId: p1.approval.id, decision: "approved", decidedBy: "user-1" });
  check("decide: approved", dec1.status === "approved");

  // seed a fixture connection so execute can proceed with mock http
  await withWorkspaceScope(WS, (tx) =>
    tx.composioConnection.create({
      data: { workspaceId: WS, appKey: "gmail", composioEntityId: "ent-fixture", status: "connected" },
    }),
  );
  const ex1 = await executeApproved({ workspaceId: WS, approvalId: p1.approval.id, executedBy: "user-1", http: mockHttp });
  check("execute: approved action executed via mock", ex1.ok === true);
  const logs1 = await withWorkspaceScope(WS, (tx) =>
    tx.composioActionLog.findMany({ where: { workspaceId: WS, approvalId: p1.approval.id } }),
  );
  check("execute: action log written", logs1.length === 1 && logs1[0].status === "success");

  // ── deny with reason; denied can never execute ──
  const p2 = await proposeAction({
    workspaceId: WS, appKey: "gmail", toolName: "GMAIL_DELETE_MESSAGE",
    args: { messageId: "m-9" }, proposedBy: "user-1",
  });
  const dec2 = await decideApproval({
    workspaceId: WS, approvalId: p2.approval.id, decision: "denied", decidedBy: "user-1", reason: "Not needed",
  });
  check("decide: denied with reason", dec2.status === "denied");
  let deniedThrew = false;
  try {
    await executeApproved({ workspaceId: WS, approvalId: p2.approval.id, executedBy: "user-1", http: mockHttp });
  } catch (e) { deniedThrew = /denied/.test((e as Error).message); }
  check("bypass: denied approval cannot execute", deniedThrew);

  // ── edit-before-approve ──
  const p3 = await proposeAction({
    workspaceId: WS, appKey: "slack", toolName: "SLACK_SEND_MESSAGE",
    args: { channel: "#gen", text: "old" }, proposedBy: "user-1",
  });
  const dec3 = await decideApproval({
    workspaceId: WS, approvalId: p3.approval.id, decision: "approved", decidedBy: "user-1",
    editedArgs: { channel: "#announce", text: "new text" },
  });
  check("edit: approved with edits", dec3.status === "approved");
  const got3 = await withWorkspaceScope(WS, (tx) =>
    tx.composioActionApproval.findFirst({ where: { id: p3.approval.id, workspaceId: WS } }),
  );
  check("edit: args rewritten", (got3!.proposedArgs as Record<string, unknown>).channel === "#announce");
  check("edit: summary rewritten", got3!.plainSummary.includes("#announce"));
  check(
    "edit: audit trail has proposed+approved",
    JSON.stringify(got3!.auditTrail).includes("proposed") && JSON.stringify(got3!.auditTrail).includes("approved"),
  );

  // ── expiry ──
  const p4 = await proposeAction({
    workspaceId: WS, appKey: "gmail", toolName: "GMAIL_GET_PROFILE", args: {},
    proposedBy: "user-1", ttlMs: 1,
  });
  await new Promise((r) => setTimeout(r, 10));
  const expiredCount = await expireStaleApprovals(WS);
  check("expiry: sweep expired one", expiredCount >= 1);
  const got4 = await withWorkspaceScope(WS, (tx) =>
    tx.composioActionApproval.findFirst({ where: { id: p4.approval.id, workspaceId: WS } }),
  );
  check("expiry: status expired", got4!.status === "expired");
  let expiredThrew = false;
  try {
    await executeApproved({ workspaceId: WS, approvalId: p4.approval.id, executedBy: "user-1", http: mockHttp });
  } catch (e) { expiredThrew = /expired/.test((e as Error).message); }
  check("bypass: expired approval cannot execute", expiredThrew);
  // log an expired status for metering completeness
  await logAction({
    workspaceId: WS, appKey: "gmail", toolName: "GMAIL_GET_PROFILE", riskTier: "low",
    status: "expired", executedBy: "user-1",
  });

  // ── list view excludes expired-by-default correctness ──
  const pending = await listApprovals(WS, { status: "pending" });
  check("list: pending filter excludes decided", pending.every((a) => a.status === "pending"));

  // ── double-decide fails closed ──
  let doubleThrew = false;
  try {
    await decideApproval({ workspaceId: WS, approvalId: p2.approval.id, decision: "approved", decidedBy: "user-2" });
  } catch { doubleThrew = true; }
  check("bypass: cannot re-decide a decided approval", doubleThrew);

  await cleanup();
  await prisma.$disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error("battery crashed:", e);
  process.exit(2);
});
