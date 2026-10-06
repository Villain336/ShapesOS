// ShapesOS — Phase 3 (J) unit tests: the unified "needs you" inbox.
// Workspace scoping (every query carries the viewer's workspace; RLS tables
// go through the scope runner), role rules (queue visibility + per-item
// canDecide), resilience and requester display. No database: a fake client.
// Run: npx tsx --test lib/approvals/__tests__/inbox.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { WorkspaceRole } from "@prisma/client";
import { loadInbox, countInbox, visibleSources } from "../inbox";
import { INBOX_SOURCE_DEFS } from "../sources";
import type { InboxDb, InboxViewer } from "../types";
import { fakeDb, workspaceIdsIn } from "./fake-db";

const A = "ws_a";
const B = "ws_b";
const NOW = new Date("2026-10-03T12:00:00Z");
const LATER = new Date("2026-10-10T12:00:00Z");
const EARLIER = new Date("2026-10-01T12:00:00Z");

function at(min: number) {
  return new Date(NOW.getTime() - min * 60_000);
}

/** One pending row per queue in BOTH workspaces (+ some rows that must not show). */
function fixtures() {
  const both = <T extends Record<string, unknown>>(make: (ws: string) => T[]) => [...make(A), ...make(B)];
  return {
    missionApproval: both((ws) => [
      { id: `${ws}_mission`, workspaceId: ws, status: "pending", expiresAt: LATER, missionId: `${ws}_m1`, action: "send_email", tier: 3, bindingJson: { amountCents: 1200 }, createdBy: "u_editor", createdAt: at(5), mission: { template: "outreach_sprint" } },
      { id: `${ws}_mission_expired`, workspaceId: ws, status: "pending", expiresAt: EARLIER, missionId: null, action: "old", tier: 1, bindingJson: {}, createdBy: "agent:x", createdAt: at(50), mission: null },
      { id: `${ws}_mission_done`, workspaceId: ws, status: "approved", expiresAt: LATER, missionId: null, action: "done", tier: 1, bindingJson: {}, createdBy: "agent:x", createdAt: at(50), mission: null },
    ]),
    spendProposal: both((ws) => [
      { id: `${ws}_spend`, workspaceId: ws, status: "pending", expiresAt: LATER, kind: "launch", action: "launch", targetType: "campaign", targetId: "c1", proposedBy: "agent:ads", createdAt: at(6) },
    ]),
    authorityApproval: both((ws) => [
      { id: `${ws}_auth`, workspaceId: ws, status: "pending", type: "depth3_activation", bindingJson: { subject: "Activate depth 3" }, approversJson: ["u_owner"], twoPersonRequired: true, createdBy: "u_editor", createdAt: at(7), expiresAt: null },
    ]),
    approvalItem: both((ws) => [
      { id: `${ws}_msg`, workspaceId: ws, status: "pending", kind: "sequence_send", payload: { to: "ada@example.com", subject: "Hello", channel: "email" }, requestedBy: "u_editor", createdAt: at(8) },
      { id: `${ws}_ins`, workspaceId: ws, status: "pending", kind: "insurance_bind_policy", payload: { summary: "Bind GL policy" }, requestedBy: "u_editor", createdAt: at(9) },
    ]),
    skillRun: both((ws) => [
      { id: `${ws}_run`, workspaceId: ws, status: "awaiting_approval", projectId: "p1", trigger: "cron", startedAt: at(10), skill: { name: "Weekly SEO audit" }, schedule: { createdBy: "u_owner" } },
    ]),
    reportSendApproval: both((ws) => [
      { id: `${ws}_report`, workspaceId: ws, status: "flagged", clientName: "Acme", period: "Sep 2026", templateName: "monthly", reviewNote: null, createdBy: "u_editor", createdAt: at(11) },
    ]),
    cadDesignProposal: both((ws) => [
      { id: `${ws}_cad`, workspaceId: ws, status: "draft", requestedText: "Make the wall 2mm thicker", requestedBy: "u_editor", requestedAt: at(12), operation: "thicken", parseConfidence: "low", model: { name: "Bracket" } },
    ]),
    connectorIntroduction: both((ws) => [
      { id: `${ws}_intro`, workspaceId: ws, status: "proposed", tenantApproved: false, pendingFollowupDraft: null, mode: "leads", createdAt: at(13), updatedAt: at(13), draftAskMessage: "Would you intro?", personA: { name: "Ann" }, personB: { name: "Bo" } },
    ]),
    connectorBoardyRequest: both((ws) => [
      { id: `${ws}_boardy`, workspaceId: ws, status: "draft", targetName: "Cy", draftedSubject: "Intro to Cy", createdAt: at(14), mode: "funding" },
    ]),
    esignEnvelope: both((ws) => [
      { id: `${ws}_env`, workspaceId: ws, status: "draft", title: "MSA", documentName: "msa.pdf", createdBy: "agent:pipeline", createdAt: at(15), events: [{ event: "agent_draft_prepared" }] },
      { id: `${ws}_env_human`, workspaceId: ws, status: "draft", title: "Mine", documentName: null, createdBy: "u_editor", createdAt: at(15), events: [] },
    ]),
    esignAuditEvent: both((ws) => [
      { id: `${ws}_nudge`, event: "nudge_drafted", actor: "agent:esign", payload: { nudgeId: "n1", email: "sig@example.com" }, createdAt: at(16), envelope: { id: `${ws}_sent`, title: "NDA", workspaceId: ws, status: "sent" } },
      { id: `${ws}_nudge2`, event: "nudge_drafted", actor: "agent:esign", payload: { nudgeId: "n2", email: "sig@example.com" }, createdAt: at(17), envelope: { id: `${ws}_sent`, title: "NDA", workspaceId: ws, status: "sent" } },
      { id: `${ws}_nudge2_ok`, event: "nudge_approved", actor: "u_owner", payload: { nudgeId: "n2" }, createdAt: at(16), envelope: { id: `${ws}_sent`, title: "NDA", workspaceId: ws, status: "sent" } },
    ]),
    composioActionApproval: both((ws) => [
      { id: `${ws}_tool`, workspaceId: ws, status: "pending", expiresAt: LATER, appKey: "slack", toolName: "SLACK_SEND_MESSAGE", riskTier: "high", plainSummary: "Post to #general", auditTrail: [{ event: "proposed", actor: "u_editor" }], createdAt: at(18) },
    ]),
    mediaApproval: both((ws) => [
      { id: `${ws}_media`, workspaceId: ws, status: "pending", type: "buy", bindingJson: { platform: "meta" }, maxSpendCents: 250_000, createdBy: "u_editor", createdAt: at(19), approvalsExpiresAt: null },
    ]),
    mailApproval: both((ws) => [
      { id: `${ws}_mail`, status: "pending", pieceCount: 500, maxSpendCents: 40_000, createdAt: at(20), campaign: { workspaceId: ws, name: "Fall postcard" } },
    ]),
    socialPublication: both((ws) => [
      { id: `${ws}_social`, workspaceId: ws, status: "pending_approval", content: "Launch post", media: [{ fileId: "f1" }], channels: [{ id: "c1", name: "Our X" }], publishMode: "now", scheduledFor: null, requestedBy: "u_editor", requestedAt: at(21), createdAt: at(21) },
      { id: `${ws}_social_draft`, workspaceId: ws, status: "draft", content: "Not yet", media: [], channels: [], publishMode: "now", scheduledFor: null, requestedBy: null, requestedAt: null, createdAt: at(22) },
    ]),
    // Phase 18.3 (WS=trust): autopilot drafts and workflow approval gates.
    autopilotItem: both((ws) => [
      { id: `${ws}_ap`, status: "pending", kind: "decay_refresh", sourceRef: "finding_1", title: "Refresh the pricing page", reviewNote: null, createdAt: at(23), projectId: `${ws}_p`, project: { workspaceId: ws, domain: "site.example" }, rule: { name: "Weekly refresh" }, run: { createdBy: "u_editor" } },
      { id: `${ws}_ap_done`, status: "approved", kind: "decay_refresh", sourceRef: "finding_2", title: "Done already", reviewNote: null, createdAt: at(24), projectId: `${ws}_p`, project: { workspaceId: ws, domain: "site.example" }, rule: { name: "Weekly refresh" }, run: { createdBy: "u_editor" } },
      { id: `${ws}_gate`, status: "pending", kind: "keyword_brief", sourceRef: `workflow_run:${ws}_wr:node_9`, title: "Workflow approval: Launch — Approve copy", reviewNote: "Check the copy", createdAt: at(25), projectId: `${ws}_p`, project: { workspaceId: ws, domain: "site.example" }, rule: { name: "Workflow approvals" }, run: { createdBy: "workflow" } },
    ]),
    workflowRun: both((ws) => [
      { id: `${ws}_wr`, status: "waiting_approval", createdBy: "u_owner", triggerKind: "manual", workflowId: `${ws}_wf`, workflow: { name: "Launch" }, project: { workspaceId: ws } },
    ]),
    workspaceMember: [
      { workspaceId: A, userId: "u_editor", name: "Eddie Editor", email: "eddie@example.com" },
      { workspaceId: A, userId: "u_owner", name: null, email: "owner@example.com" },
      { workspaceId: B, userId: "u_editor", name: "Wrong Workspace Name", email: "x@example.com" },
    ],
  };
}

function viewer(role: WorkspaceRole, over: Partial<InboxViewer> = {}): InboxViewer {
  return { userId: "u_viewer", workspaceId: A, role, permissions: new Set(), hasOtherApprover: true, ...over };
}

function harness(opts: { fail?: string[] } = {}) {
  const fake = fakeDb(fixtures(), opts);
  const scoped: string[] = [];
  const db = fake.db as unknown as InboxDb;
  const scope = async <T,>(workspaceId: string, fn: (tx: InboxDb) => Promise<T>) => {
    scoped.push(workspaceId);
    return fn(db);
  };
  return { fake, scoped, opts: { db, scope, now: NOW } };
}

describe("approvals inbox: workspace scoping", () => {
  it("every queue query carries the viewer's workspace and nothing else", async () => {
    const h = harness();
    const res = await loadInbox(viewer("owner", { userId: "u_owner" }), h.opts);
    const queueCalls = h.fake.calls.filter((c) => c.model !== "workspaceMember");
    assert.ok(queueCalls.length >= 14, "every queue was queried");
    for (const call of queueCalls) {
      const ids = workspaceIdsIn(call.args?.where);
      assert.deepEqual([...ids], [A], `${call.model}.${call.op} must be scoped to ${A}`);
    }
    for (const item of res.items) assert.ok(item.id.startsWith(`${A}_`), `leaked ${item.id}`);
    assert.equal(res.errors.length, 0);
  });

  it("RLS-protected queues run inside the tenant scope for the viewer's workspace", async () => {
    const h = harness();
    await loadInbox(viewer("owner"), h.opts);
    // mission_approvals, report_send_approvals, composio_action_approvals,
    // social_publications
    assert.equal(h.scoped.length, 4);
    assert.ok(h.scoped.every((w) => w === A));
  });

  it("only pending, unexpired, still-open items show", async () => {
    const h = harness();
    const res = await loadInbox(viewer("owner"), h.opts);
    const ids = new Set(res.items.map((i) => i.id));
    assert.ok(ids.has(`${A}_mission`));
    assert.ok(!ids.has(`${A}_mission_expired`), "expired approvals are not waiting on anyone");
    assert.ok(!ids.has(`${A}_mission_done`));
    assert.ok(ids.has(`${A}_env`), "agent-prepared envelope draft");
    assert.ok(!ids.has(`${A}_env_human`), "a person's own draft is not an approval");
    assert.ok(ids.has(`${A}_nudge`), "unapproved nudge");
    assert.ok(!ids.has(`${A}_nudge2`), "approved nudge is gone");
    assert.ok(ids.has(`${A}_social`), "submitted social post");
    assert.ok(!ids.has(`${A}_social_draft`), "a draft post is not an approval");
    assert.equal(res.total, 18, "16 + the autopilot draft and the workflow gate (Phase 18.3)");
    assert.ok(!ids.has(`${A}_ap_done`), "a decided autopilot item is gone");
  });

  it("social posts: inline decision API, and no self-approval while another approver exists", async () => {
    const h = harness();
    const asRequester = await loadInbox(viewer("editor", { userId: "u_editor" }), h.opts);
    const own = asRequester.items.find((i) => i.id === `${A}_social`)!;
    assert.equal(own.source, "social");
    assert.equal(own.canDecide, false);
    assert.match(own.blockedReason ?? "", /Someone else approves/);
    const solo = await loadInbox(viewer("editor", { userId: "u_editor", hasOtherApprover: false }), h.opts);
    const mine = solo.items.find((i) => i.id === `${A}_social`)!;
    assert.equal(mine.canDecide, true);
    assert.equal(mine.approve?.url, `/api/social/posts/${A}_social/decision`);
    assert.deepEqual(mine.approve?.body, { decision: "approve" });
    assert.equal(mine.href, `/dashboard/social?post=${A}_social`);
  });

  it("insurance governed actions are their own queue, not messaging", async () => {
    const h = harness();
    const res = await loadInbox(viewer("owner"), h.opts);
    const ins = res.items.find((i) => i.id === `${A}_ins`)!;
    assert.equal(ins.source, "insurance");
    assert.equal(ins.approve?.url, `/api/insurance/governance/${A}_ins/decide`);
    assert.equal(res.items.filter((i) => i.id === `${A}_ins`).length, 1);
  });
});

describe("approvals inbox: role rules", () => {
  it("viewers don't see editor-only queues and can't decide anything", async () => {
    const h = harness();
    const res = await loadInbox(viewer("viewer"), h.opts);
    const sources = new Set(res.items.map((i) => i.source));
    assert.ok(!sources.has("spend"), "spend proposals page is editor+");
    assert.ok(!sources.has("insurance"), "insurance pending API is editor+");
    assert.ok(!h.fake.calls.some((c) => c.model === "spendProposal"), "never even queried");
    assert.equal(res.actionable, 0);
    for (const item of res.items) {
      assert.equal(item.canDecide, false);
      assert.equal(item.approve, null);
      assert.equal(item.deny, null);
      assert.ok(item.blockedReason);
    }
  });

  it("visibleSources mirrors each queue's read gate", () => {
    const keys = (r: WorkspaceRole) => visibleSources({ role: r }).map((s) => s.key);
    assert.ok(!keys("viewer").includes("spend"));
    assert.ok(keys("editor").includes("spend"));
    assert.equal(keys("owner").length, INBOX_SOURCE_DEFS.length);
  });

  it("editors decide editor-gated queues but not media buys or supervised runs", async () => {
    const h = harness();
    const res = await loadInbox(viewer("editor", { userId: "u_other_editor" }), h.opts);
    const by = (id: string) => res.items.find((i) => i.id === id)!;
    assert.equal(by(`${A}_msg`).canDecide, true);
    assert.deepEqual(by(`${A}_msg`).approve, {
      method: "POST",
      url: `/api/messaging/approvals/${A}_msg`,
      body: { decision: "approve" },
    });
    assert.equal(by(`${A}_media`).canDecide, false, "media owner (admin+) only");
    assert.equal(by(`${A}_run`).canDecide, false, "needs skills.install");
    assert.equal(by(`${A}_spend`).canDecide, true);
    assert.equal(by(`${A}_spend`).approve, null, "spend decides in its own page (server actions)");
  });

  it("a skills.install grant lets an editor decide supervised runs", async () => {
    const h = harness();
    const res = await loadInbox(viewer("editor", { permissions: new Set(["skills.install"]) }), h.opts);
    const run = res.items.find((i) => i.id === `${A}_run`)!;
    assert.equal(run.canDecide, true);
    assert.deepEqual(run.approve?.body, { workspaceId: A });
  });

  it("admins decide media buys", async () => {
    const h = harness();
    const res = await loadInbox(viewer("admin"), h.opts);
    assert.equal(res.items.find((i) => i.id === `${A}_media`)!.canDecide, true);
  });

  it("separation of duties: the requester can't decide their own tool action while another approver exists", async () => {
    const h = harness();
    const own = await loadInbox(viewer("editor", { userId: "u_editor", hasOtherApprover: true }), h.opts);
    const item = own.items.find((i) => i.id === `${A}_tool`)!;
    assert.equal(item.canDecide, false);
    assert.match(item.blockedReason ?? "", /another approver/);

    const solo = await loadInbox(viewer("owner", { userId: "u_editor", hasOtherApprover: false }), harness().opts);
    assert.equal(solo.items.find((i) => i.id === `${A}_tool`)!.canDecide, true, "a solo workspace may self-approve");
  });

  it("two-person approvals: someone who already approved can't approve again", async () => {
    const h = harness();
    const owner = await loadInbox(viewer("owner", { userId: "u_owner" }), h.opts);
    const mine = owner.items.find((i) => i.id === `${A}_auth`)!;
    assert.equal(mine.canDecide, false);
    const other = await loadInbox(viewer("editor", { userId: "u_second" }), harness().opts);
    assert.equal(other.items.find((i) => i.id === `${A}_auth`)!.canDecide, true);
  });

  it("countInbox: actionable is what this viewer can decide", async () => {
    const asViewer = await countInbox(viewer("viewer"), harness().opts);
    assert.equal(asViewer.actionable, 0);
    assert.ok(asViewer.total > 0);
    const asOwner = await countInbox(viewer("owner", { userId: "u_third" }), harness().opts);
    assert.equal(asOwner.actionable, asOwner.total);
  });
});

describe("approvals inbox: resilience and display", () => {
  it("one failing queue is reported; the rest still load", async () => {
    const h = harness({ fail: ["cadDesignProposal"] });
    const res = await loadInbox(viewer("owner"), h.opts);
    assert.deepEqual(res.errors.map((e) => e.source), ["cad"]);
    assert.ok(res.items.some((i) => i.source === "mission"));
    assert.ok(!res.items.some((i) => i.source === "cad"));
  });

  it("restricting to some queues only queries those", async () => {
    const h = harness();
    const res = await loadInbox(viewer("owner"), { ...h.opts, sources: ["mission", "mail"] });
    assert.deepEqual([...new Set(res.items.map((i) => i.source))].sort(), ["mail", "mission"]);
    assert.ok(!h.fake.calls.some((c) => c.model === "approvalItem"));
  });

  it("requesters resolve to this workspace's member names; agents read as Agent", async () => {
    const res = await loadInbox(viewer("owner"), harness().opts);
    const by = (id: string) => res.items.find((i) => i.id === id)!;
    assert.equal(by(`${A}_msg`).requester, "Eddie Editor");
    assert.equal(by(`${A}_spend`).requester, "Agent");
    assert.equal(by(`${A}_run`).requester, "owner@example.com");
  });

  it("items are newest first and deep links stay inside the dashboard", async () => {
    const res = await loadInbox(viewer("owner"), harness().opts);
    const times = res.items.map((i) => i.createdAt);
    assert.deepEqual(times, [...times].sort().reverse());
    for (const i of res.items) assert.ok(i.href.startsWith("/dashboard/"), i.href);
  });
});

describe("approvals inbox: autopilot and workflow (Phase 18.3, sources 16 and 17)", () => {
  it("are the 16th and 17th sources", () => {
    const keys = INBOX_SOURCE_DEFS.map((d) => d.key);
    assert.equal(keys.length, 17);
    assert.deepEqual(keys.slice(15), ["autopilot", "workflow"]);
  });

  it("autopilot lists pending drafts (not gates, not decided) and decides through the existing autopilot routes", async () => {
    const res = await loadInbox(viewer("editor", { userId: "u_other" }), harness().opts);
    const ap = res.items.filter((i) => i.source === "autopilot");
    assert.deepEqual(ap.map((i) => i.id), [`${A}_ap`]);
    assert.equal(ap[0]!.canDecide, true);
    assert.deepEqual(ap[0]!.approve, { method: "POST", url: `/api/autopilot/items/${A}_ap/approve`, body: { projectId: `${A}_p` } });
    assert.deepEqual(ap[0]!.deny, { method: "POST", url: `/api/autopilot/items/${A}_ap/reject`, body: { projectId: `${A}_p` } });
    assert.equal(ap[0]!.typeLabel, "Content refresh");
    assert.match(ap[0]!.href, /\/autopilot$/);
  });

  it("workflow lists approval gates with their run's workflow, through the same routes", async () => {
    const res = await loadInbox(viewer("owner", { userId: "u_third" }), harness().opts);
    const wf = res.items.filter((i) => i.source === "workflow");
    assert.deepEqual(wf.map((i) => i.id), [`${A}_gate`]);
    assert.equal(wf[0]!.title, "Launch — Approve copy");
    assert.match(wf[0]!.detail ?? "", /Launch/);
    assert.equal(wf[0]!.requestedBy, "u_owner");
    assert.deepEqual(wf[0]!.approve?.url, `/api/autopilot/items/${A}_gate/approve`);
    assert.ok(wf[0]!.href.includes(`run=${A}_wr`));
  });

  it("viewers see them but can't decide", async () => {
    const res = await loadInbox(viewer("viewer"), harness().opts);
    for (const i of res.items.filter((x) => x.source === "autopilot" || x.source === "workflow")) {
      assert.equal(i.canDecide, false);
      assert.equal(i.approve, null);
    }
    assert.ok(res.items.some((i) => i.source === "workflow"));
  });
});
