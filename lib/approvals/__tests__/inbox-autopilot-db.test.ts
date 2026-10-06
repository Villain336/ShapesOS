// ShapesOS — Phase 18.3 (WS=trust) DB test: one approvals queue.
// Autopilot drafts and workflow approval gates are the inbox's 16th and 17th
// sources: they appear for this workspace only, and approve / reject through
// their EXISTING paths (POST /api/autopilot/items/[id]/approve|reject →
// approveAutopilotItem / rejectAutopilotItem; a gate's approval resumes the
// paused WorkflowRun, a rejection cancels it). Viewers see them, can't decide.
// Real Postgres as the least-privilege app role; the session is a node:test
// module MOCK of lib/session (labelled).
// Run: DATABASE_URL=<app role> npx tsx --test --experimental-test-module-mocks lib/approvals/__tests__/inbox-autopilot-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const RUN = randomUUID().slice(0, 8);
const WS = `ap-ws-${RUN}`;
const WS_B = `ap-wsb-${RUN}`;
const OWNER = `ap-owner-${RUN}`;
const VIEWER = `ap-viewer-${RUN}`;
let actor = { id: OWNER, email: "owner@ap.test" };

// MOCK: the signed-in session.
mock.module("@/lib/session", {
  namedExports: {
    requireUser: async () => actor,
    getOrCreateWorkspace: async () => ({ id: WS, name: WS }),
  },
});

let prisma: typeof import("@/lib/prisma").prisma;
let inbox: typeof import("../inbox");
let projectId = "";
let projectB = "";
let draftId = "";
let gateApprove = "";
let gateReject = "";
let runApprove = "";
let runReject = "";

async function gateRun(workflowName: string): Promise<{ runId: string; itemId: string }> {
  const { ensureWorkflowApprovalsRule, createWorkflowAutopilotItem, gateSourceRef } = await import("@/lib/workflow/approvals");
  const wf = await prisma.workflow.create({ data: { projectId, name: workflowName, status: "active", createdBy: OWNER } });
  const gate = await prisma.workflowNode.create({ data: { workflowId: wf.id, kind: "approval", type: "approval_gate", label: "Approve copy", positionX: 0, positionY: 0 } });
  const run = await prisma.workflowRun.create({ data: { workflowId: wf.id, projectId, status: "waiting_approval", triggerKind: "manual", createdBy: OWNER } });
  const rule = await ensureWorkflowApprovalsRule(prisma, WS, projectId);
  const item = await createWorkflowAutopilotItem(prisma, rule, { projectId, kind: "keyword_brief", sourceRef: gateSourceRef(run.id, gate.id), title: `Workflow approval: ${workflowName} — Approve copy`, summary: "Check it" });
  await prisma.workflowRun.update({ where: { id: run.id }, data: { pendingApprovalItemId: item.id } });
  return { runId: run.id, itemId: item.id };
}

const post = async (id: string, verb: "approve" | "reject", body: unknown) => {
  const mod = verb === "approve" ? await import("@/app/api/autopilot/items/[id]/approve/route") : await import("@/app/api/autopilot/items/[id]/reject/route");
  return mod.POST(new Request(`http://x/api/autopilot/items/${id}/${verb}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
};

before(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  inbox = await import("../inbox");
  for (const id of [WS, WS_B]) await prisma.workspace.create({ data: { id, name: id, ownerUserId: OWNER } });
  await prisma.workspaceMember.createMany({ data: [{ workspaceId: WS, userId: OWNER, role: "owner" }, { workspaceId: WS, userId: VIEWER, role: "viewer" }] });
  projectId = (await prisma.project.create({ data: { workspaceId: WS, domain: `ap-${RUN}.example` } })).id;
  projectB = (await prisma.project.create({ data: { workspaceId: WS_B, domain: `apb-${RUN}.example` } })).id;
  const { createAutopilotRule } = await import("@/lib/seo/autopilot-service");
  for (const [ws, pid, tag] of [[WS, projectId, "A"], [WS_B, projectB, "B"]] as const) {
    const { id: ruleId } = await createAutopilotRule(prisma, { workspaceId: ws, projectId: pid, input: { name: `Weekly refresh ${tag}`, source: "keyword_opportunity", cadence: "manual", maxItemsPerRun: 5 } });
    const run = await prisma.autopilotRun.create({ data: { ruleId, projectId: pid, status: "completed", createdBy: OWNER, itemsGenerated: 1 } });
    const item = await prisma.autopilotItem.create({ data: { runId: run.id, ruleId, projectId: pid, kind: "decay_refresh", sourceRef: `finding-${tag}-${RUN}`, title: `Refresh pricing ${tag}`, status: "pending" } });
    if (ws === WS) draftId = item.id;
  }
  ({ runId: runApprove, itemId: gateApprove } = await gateRun("Launch"));
  ({ runId: runReject, itemId: gateReject } = await gateRun("Newsletter"));
});

after(async () => {
  await prisma.fileChangeLog.deleteMany({ where: { workspaceId: { in: [WS, WS_B] } } });
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, WS_B] } } });
  await prisma.$disconnect();
});

describe("one approvals queue: autopilot + workflow (DB)", () => {
  it("both appear in the inbox for this workspace only, with their existing decide routes", async () => {
    const viewer = await inbox.resolveInboxViewer(OWNER, WS);
    const res = await inbox.loadInbox(viewer!);
    assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
    const ap = res.items.filter((i) => i.source === "autopilot");
    const wf = res.items.filter((i) => i.source === "workflow");
    assert.deepEqual(ap.map((i) => i.id), [draftId]);
    assert.deepEqual(wf.map((i) => i.id).sort(), [gateApprove, gateReject].sort());
    assert.ok(!res.items.some((i) => i.title.endsWith(" B")), "another workspace never leaks");
    assert.equal(ap[0]!.approve?.url, `/api/autopilot/items/${draftId}/approve`);
    assert.deepEqual(ap[0]!.approve?.body, { projectId });
    assert.ok(wf.every((i) => i.canDecide && i.detail?.includes(i.title.startsWith("Launch") ? "Launch" : "Newsletter")));
    const counts = await inbox.countInbox(viewer!);
    assert.ok(counts.actionable >= 3);
  });

  it("viewers see them but can't decide", async () => {
    const res = await inbox.loadInbox((await inbox.resolveInboxViewer(VIEWER, WS))!);
    const mine = res.items.filter((i) => i.source === "autopilot" || i.source === "workflow");
    assert.equal(mine.length, 3);
    assert.ok(mine.every((i) => !i.canDecide && i.approve === null));
  });

  it("approving a gate through its existing route resumes the paused workflow run", async () => {
    actor = { id: OWNER, email: "owner@ap.test" };
    const res = await post(gateApprove, "approve", { projectId });
    assert.equal(res.status, 200, await res.clone().text());
    const item = await prisma.autopilotItem.findUniqueOrThrow({ where: { id: gateApprove } });
    assert.equal(item.status, "approved");
    const run = await prisma.workflowRun.findUniqueOrThrow({ where: { id: runApprove } });
    assert.notEqual(run.status, "waiting_approval");
    assert.equal(run.pendingApprovalItemId, null);
    const step = await prisma.workflowRunStep.findFirst({ where: { runId: runApprove, status: "succeeded" } });
    assert.ok(step, "the gate step recorded as approved");
  });

  it("rejecting a gate cancels its run; rejecting a draft is the autopilot's own path; a viewer is refused", async () => {
    actor = { id: VIEWER, email: "v@ap.test" };
    assert.equal((await post(draftId, "reject", { projectId })).status, 403);
    actor = { id: OWNER, email: "owner@ap.test" };
    assert.equal((await post(gateReject, "reject", { projectId })).status, 200);
    assert.equal((await prisma.workflowRun.findUniqueOrThrow({ where: { id: runReject } })).status, "cancelled");
    assert.equal((await post(draftId, "reject", { projectId, note: "not now" })).status, 200);
    assert.equal((await prisma.autopilotItem.findUniqueOrThrow({ where: { id: draftId } })).status, "rejected");
    const left = await inbox.loadInbox((await inbox.resolveInboxViewer(OWNER, WS))!);
    assert.ok(!left.items.some((i) => i.source === "autopilot" || i.source === "workflow"), "decided items leave the queue");
  });
});
