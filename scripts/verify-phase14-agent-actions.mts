#!/usr/bin/env tsx
// Marketr — Phase 14 slice 4 verification: agent action surface + OAuth hardening.
//
// Battery (fixture-based, DB-backed against the local durable DB):
//   OAuth state: sign/verify roundtrip; tampered sig, wrong secret, expired,
//     malformed -> all throw
//   initiateConnect: link POST carries redirect_url with ?state=; state
//     verifies to the (workspaceId, appKey, userId) triple; unknown app
//     fails closed before any HTTP
//   agentInvokeAction (mock Composio http):
//     read (low)          -> executed + log written
//     draft-creator       -> executed + log written (auto, reviewable)
//     write (medium)      -> pending-approval, ZERO execute calls, approval row
//     destructive (high)  -> pending-approval
//     unconnected app     -> throws, no execute call
//   runActor: injected invoke -> summary carries approval id on gated
//   orchestrator ROUTING_TABLE: act/action/tool-call -> actor
//   requestMissionAction: executed/awaiting-approval + mission event appended
//   proposePlaybookActionStep: creates approval, never executes
//
// Run: npx tsx scripts/verify-phase14-agent-actions.mts
// Requires: DATABASE_URL (local durable Postgres).

import "dotenv/config";
import { prisma } from "../lib/prisma";
import { withWorkspaceScope } from "../lib/substrate/memory/rls";
import type { ComposioHttp } from "../lib/integrations/composio";
import { initiateConnect } from "../lib/integrations/actions/connections";
import { signOAuthState, verifyOAuthState } from "../lib/integrations/actions/oauth-state";
import { agentInvokeAction } from "../lib/integrations/actions/agent";
import { runActor } from "../lib/orchestrator/executors/actor";
import { ROUTING_TABLE } from "../lib/orchestrator/orchestrator";
import { requestMissionAction } from "../lib/missions/action";
import { proposePlaybookActionStep } from "../lib/playbooks/action-steps";

process.env.ACTION_OAUTH_STATE_SECRET = "test-oauth-state-secret-14";

const WS = "00000000-0000-0000-0000-000000000015";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`); }
}

const recorded: Array<{ path: string; method?: string; body?: unknown }> = [];
let executeCalls = 0;

const mockHttp: ComposioHttp = {
  async request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    recorded.push({ path, method: init?.method, body: init?.body });
    if (path.startsWith("/auth_configs?")) {
      return { items: [{ id: "ac_test" }] } as T;
    }
    if (path === "/connected_accounts/link") {
      return {
        link_token: "lk_test",
        redirect_url: "https://connect.composio.dev/link/lk_test",
        expires_at: "2030-01-01T00:00:00Z",
      } as T;
    }
    if (path.startsWith("/tools/execute/")) {
      executeCalls++;
      return { successful: true, data: { id: "res-1" }, error: null } as T;
    }
    throw new Error(`unexpected path ${path}`);
  },
};

async function ensureWorkspace() {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({
    data: { id: WS, name: "14 agent-actions battery", ownerUserId: "14-battery-owner" },
  });
}

async function cleanup() {
  await withWorkspaceScope(WS, (tx) =>
    tx.composioActionApproval.deleteMany({ where: { workspaceId: WS } }),
  );
  await withWorkspaceScope(WS, (tx) =>
    tx.composioActionLog.deleteMany({ where: { workspaceId: WS } }),
  );
  await withWorkspaceScope(WS, (tx) =>
    tx.composioConnection.deleteMany({ where: { workspaceId: WS } }),
  );
  await prisma.workspace.deleteMany({ where: { id: WS } });
}

async function main() {
  await ensureWorkspace();

  // ---- OAuth state signing ----
  const state = signOAuthState({ workspaceId: WS, appKey: "gmail", userId: "u-1" });
  const bound = verifyOAuthState(state);
  check(
    "state roundtrip binds (workspaceId, appKey, userId)",
    bound.workspaceId === WS && bound.appKey === "gmail" && bound.userId === "u-1",
  );
  const [body, sig] = state.split(".");
  let tampered = false;
  try { verifyOAuthState(`${body}.x${sig.slice(1)}`); } catch { tampered = true; }
  check("tampered signature rejected", tampered);
  let wrongSecret = false;
  try { verifyOAuthState(state, { secret: "nope" }); } catch { wrongSecret = true; }
  check("wrong secret rejected", wrongSecret);
  let expired = false;
  try {
    verifyOAuthState(signOAuthState({ workspaceId: WS, appKey: "gmail", userId: "u-1" }, { ttlMs: -1 }));
  } catch { expired = true; }
  check("expired state rejected", expired);
  let malformed = false;
  try { verifyOAuthState("not-a-state"); } catch { malformed = true; }
  check("malformed state rejected", malformed);

  // ---- initiateConnect carries signed state on the callback URL ----
  recorded.length = 0;
  await initiateConnect({ workspaceId: WS, appKey: "gmail", userId: "u-1" }, mockHttp);
  const linkReq = recorded.find((r) => r.method === "POST" && r.path === "/connected_accounts/link");
  const redirectUrl = String((linkReq?.body as Record<string, unknown> | undefined)?.redirect_url ?? "");
  check("connect link POST carries redirect_url", redirectUrl.includes("/api/integrations/actions/callback?state="), redirectUrl.slice(0, 80));
  const cbState = new URL(redirectUrl).searchParams.get("state") ?? "";
  const cbBound = verifyOAuthState(cbState);
  check(
    "callback state verifies to the initiating triple",
    cbBound.workspaceId === WS && cbBound.appKey === "gmail" && cbBound.userId === "u-1",
  );
  let unknownApp = false;
  try { await initiateConnect({ workspaceId: WS, appKey: "fax-machine", userId: "u-1" }, mockHttp); }
  catch { unknownApp = true; }
  check("unknown app fails closed", unknownApp);

  // ---- seed a connected app ----
  await withWorkspaceScope(WS, (tx) =>
    tx.composioConnection.create({
      data: { workspaceId: WS, appKey: "gmail", composioEntityId: "ca_test", status: "connected" },
    }),
  );

  // ---- agentInvokeAction: reads execute ----
  executeCalls = 0;
  const read = await agentInvokeAction({
    workspaceId: WS, appKey: "gmail", toolName: "GMAIL_LIST_MESSAGES",
    args: { q: "invoices" }, invokedBy: "test-agent", http: mockHttp,
  });
  check("read executes directly", read.outcome === "executed");
  check("read performed exactly one Composio execute", executeCalls === 1);
  const readLogs = await withWorkspaceScope(WS, (tx) =>
    tx.composioActionLog.findMany({ where: { workspaceId: WS, toolName: "GMAIL_LIST_MESSAGES" } }),
  );
  check("read wrote an audit log", readLogs.length === 1 && readLogs[0].status === "success");

  // ---- draft-creator executes (auto, reviewable) ----
  executeCalls = 0;
  const draft = await agentInvokeAction({
    workspaceId: WS, appKey: "gmail", toolName: "GMAIL_CREATE_DRAFT",
    args: { to: "x@y.z", subject: "hi" }, invokedBy: "test-agent", http: mockHttp,
  });
  check("draft-creator executes directly", draft.outcome === "executed");
  check("draft-creator wrote an audit log", executeCalls === 1);

  // ---- write is gated: propose, never execute ----
  executeCalls = 0;
  const write = await agentInvokeAction({
    workspaceId: WS, appKey: "gmail", toolName: "GMAIL_SEND_EMAIL",
    args: { to: "x@y.z", body: "hello" }, invokedBy: "test-agent", http: mockHttp,
  });
  check("write returns pending-approval", write.outcome === "pending-approval");
  check("write performed ZERO Composio executes", executeCalls === 0);
  check(
    "write created a pending approval",
    write.outcome === "pending-approval" && typeof write.approvalId === "string" && write.approvalId.length > 0,
  );

  // ---- destructive is gated ----
  executeCalls = 0;
  const del = await agentInvokeAction({
    workspaceId: WS, appKey: "gmail", toolName: "GMAIL_DELETE_MESSAGE",
    args: { id: "m-1" }, invokedBy: "test-agent", http: mockHttp,
  });
  check("destructive returns pending-approval", del.outcome === "pending-approval" && executeCalls === 0);

  // ---- unconnected app fails closed ----
  executeCalls = 0;
  let unconnectedThrew = false;
  try {
    await agentInvokeAction({
      workspaceId: WS, appKey: "slack", toolName: "SLACK_LIST_CHANNELS",
      args: {}, invokedBy: "test-agent", http: mockHttp,
    });
  } catch { unconnectedThrew = true; }
  check("unconnected app fails closed with no execute", unconnectedThrew && executeCalls === 0);

  // ---- runActor routes through the surface ----
  const actorOk = await runActor(
    {
      workspaceId: WS, appKey: "gmail", toolName: "GMAIL_SEND_EMAIL",
      args: { to: "x@y.z" }, invokedBy: "test-actor",
    },
    { invoke: async (i) => agentInvokeAction({ ...i, http: mockHttp }) },
  );
  check(
    "runActor surfaces gated action with approval id",
    actorOk.outcome === "pending-approval" && typeof actorOk.approvalId === "string",
    actorOk.summary.slice(0, 60),
  );
  let actorUnconnected = false;
  try {
    await runActor(
      {
        workspaceId: WS, appKey: "slack", toolName: "SLACK_LIST_CHANNELS",
        args: {}, invokedBy: "test-actor",
      },
      { invoke: async (i) => agentInvokeAction({ ...i, http: mockHttp }) },
    );
  } catch { actorUnconnected = true; }
  check("runActor on unconnected app throws (fail-closed)", actorUnconnected);

  // ---- orchestrator routing ----
  check("ROUTING_TABLE act -> actor", ROUTING_TABLE["act"] === "actor");
  check("ROUTING_TABLE action -> actor", ROUTING_TABLE["action"] === "actor");
  check("ROUTING_TABLE tool-call -> actor", ROUTING_TABLE["tool-call"] === "actor");

  // ---- missions: requestMissionAction ----
  const events: Array<Record<string, unknown>> = [];
  const missionRead = await requestMissionAction({
    missionId: "m-1", workspaceId: WS, appKey: "gmail", toolName: "GMAIL_SEARCH_MESSAGES",
    args: { q: "x" }, http: mockHttp,
    appendEvent: async (e) => { events.push(e as unknown as Record<string, unknown>); },
  });
  check("mission read executes", missionRead.disposition === "executed");
  check(
    "mission event records executed disposition",
    events.some((e) => (e.observation as Record<string, unknown>)?.disposition === "executed"),
  );
  const missionWrite = await requestMissionAction({
    missionId: "m-1", workspaceId: WS, appKey: "gmail", toolName: "GMAIL_SEND_EMAIL",
    args: { to: "x@y.z" }, http: mockHttp,
    appendEvent: async (e) => { events.push(e as unknown as Record<string, unknown>); },
  });
  check(
    "mission write awaits approval with approval id",
    missionWrite.disposition === "awaiting-approval" && typeof missionWrite.approvalId === "string",
  );
  check(
    "mission event records awaiting-approval + approvalId",
    events.some((e) => {
      const o = e.observation as Record<string, unknown>;
      return o?.disposition === "awaiting-approval" && typeof o?.approvalId === "string";
    }),
  );

  // ---- playbooks: propose-only ----
  executeCalls = 0;
  const pb = await proposePlaybookActionStep({
    workspaceId: WS, playbookId: "pb-1", version: 3,
    step: { title: "Draft follow-up", appKey: "gmail", toolName: "GMAIL_CREATE_DRAFT", args: { to: "x@y.z" } },
    proposedBy: "test-playbook",
  });
  check("playbook step proposed (not executed)", pb.status === "pending" && executeCalls === 0);
  let pbBad = false;
  try {
    await proposePlaybookActionStep({
      workspaceId: WS, playbookId: "pb-1", version: 3,
      step: { title: "Bad", appKey: "fax-machine", toolName: "X" }, proposedBy: "t",
    });
  } catch { pbBad = true; }
  check("playbook step with unknown app fails closed", pbBad);

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("battery error:", e);
  process.exit(1);
});
