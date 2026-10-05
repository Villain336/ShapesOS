// ShapesOS — workflow canvas webhook trigger against real Postgres (Phase 6):
// secret minted/rotated and stored only encrypted; signed calls accepted and
// start a WorkflowRun through the engine (payload reaches the run context);
// bad signatures, expired timestamps and exact replays refused; the public
// route's body cap and rate limit.
// Run (as the least-privilege app role): DATABASE_URL=… npx tsx --test lib/workflow/__tests__/webhook-trigger-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { signatureHeader, SIGNATURE_HEADER } from "@/lib/webhooks/signing";
import { __resetRateLimits } from "@/lib/api/rate-limit";
import {
  getWorkflowWebhook,
  receiveWorkflowWebhook,
  revokeWorkflowWebhook,
  rotateWorkflowWebhookSecret,
  WORKFLOW_WEBHOOK_MAX_BYTES,
} from "../webhook";
import { POST } from "@/app/api/hooks/workflows/[id]/route";

process.env.MARKETR_CREDENTIALS_KEY ||= randomBytes(32).toString("hex");

const RUN = `p6wh-${Date.now().toString(36)}`;
const WS = `${RUN}-ws`;
let projectId = "";
let workflowId = "";
let triggerNodeId = "";

const nowSec = () => Math.floor(Date.now() / 1000);
const sign = (secret: string, body: string, t = nowSec()) => signatureHeader(secret, body, t);

async function workflowWithWebhookTrigger(status: "active" | "draft" = "active") {
  const wf = await prisma.workflow.create({ data: { projectId, name: `${RUN} wf`, status, enabled: true } });
  const trig = await prisma.workflowNode.create({
    data: { workflowId: wf.id, kind: "trigger", type: "webhook", label: "Webhook", config: {}, positionX: 0, positionY: 0 },
  });
  const cond = await prisma.workflowNode.create({
    data: {
      workflowId: wf.id,
      kind: "logic",
      type: "condition",
      label: "Is a lead?",
      config: { field: "trigger.kind", operator: "eq", value: "lead" },
      positionX: 200,
      positionY: 0,
    },
  });
  await prisma.workflowEdge.create({ data: { workflowId: wf.id, sourceNodeId: trig.id, targetNodeId: cond.id } });
  return { wf, trig };
}

before(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: `${RUN}-owner`, plan: "pro" } });
  const p = await prisma.project.create({ data: { workspaceId: WS, domain: `${RUN}.example` } });
  projectId = p.id;
});

beforeEach(async () => {
  __resetRateLimits();
  await prisma.workflow.deleteMany({ where: { projectId } });
  const { wf, trig } = await workflowWithWebhookTrigger();
  workflowId = wf.id;
  triggerNodeId = trig.id;
});

after(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

describe("workflow webhook trigger (DB)", () => {
  it("mints a whsec_ secret once and stores only an encrypted envelope + hint", async () => {
    const before = await getWorkflowWebhook(workflowId);
    assert.equal(before.hasTrigger, true);
    assert.equal(before.configured, false);
    const { secret, view } = await rotateWorkflowWebhookSecret(workflowId, `${RUN}-editor`);
    assert.match(secret, /^whsec_/);
    assert.equal(view.configured, true);
    assert.ok(view.secretHint && !view.secretHint.includes(secret));
    assert.equal(view.path, `/api/hooks/workflows/${workflowId}`);
    const row = await prisma.workflowWebhook.findUniqueOrThrow({ where: { workflowId } });
    assert.ok(!row.secretEnc.includes(secret));
    assert.ok(!JSON.stringify(view).includes(secret), "the view never carries the secret");
    // The workflow API row never carries it either (separate table).
    const wf = await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId }, include: { nodes: true, edges: true } });
    assert.ok(!JSON.stringify(wf).includes(row.secretEnc));
  });

  it("accepts a signed call and starts a WorkflowRun with the JSON body as trigger payload", async () => {
    const { secret } = await rotateWorkflowWebhookSecret(workflowId, null);
    const body = JSON.stringify({ kind: "lead", email: "a@example.com" });
    const res = await receiveWorkflowWebhook({ workflowId, rawBody: body, signature: sign(secret, body) });
    assert.equal(res.ok, true);
    assert.ok(res.ok && res.status === 201 && !res.deduped);
    const run = await prisma.workflowRun.findUniqueOrThrow({
      where: { id: res.ok ? res.runId : "" },
      include: { steps: { orderBy: { startedAt: "asc" } } },
    });
    assert.equal(run.triggerKind, "webhook");
    assert.equal(run.createdBy, "webhook");
    assert.equal(run.status, "succeeded");
    const trig = run.steps.find((s) => s.nodeId === triggerNodeId)!;
    assert.deepEqual((trig.output as { trigger?: unknown }).trigger, { kind: "lead", email: "a@example.com" });
    const cond = run.steps.find((s) => s.nodeKind === "logic")!;
    assert.equal((cond.output as { result?: boolean }).result, true, "the condition read trigger.kind from the run context");
    const hook = await prisma.workflowWebhook.findUniqueOrThrow({ where: { workflowId } });
    assert.ok(hook.lastReceivedAt);
  });

  it("rejects a wrong secret, a tampered body and a malformed header", async () => {
    const { secret } = await rotateWorkflowWebhookSecret(workflowId, null);
    const body = JSON.stringify({ kind: "lead" });
    const wrong = await receiveWorkflowWebhook({ workflowId, rawBody: body, signature: sign("whsec_not-the-secret", body) });
    assert.deepEqual(wrong.ok ? null : wrong.status, 401);
    const tampered = await receiveWorkflowWebhook({ workflowId, rawBody: body.replace("lead", "admin"), signature: sign(secret, body) });
    assert.deepEqual(tampered.ok ? null : tampered.status, 401);
    const malformed = await receiveWorkflowWebhook({ workflowId, rawBody: body, signature: "v1=abc" });
    assert.deepEqual(malformed.ok ? null : malformed.status, 401);
    assert.equal(await prisma.workflowRun.count({ where: { workflowId } }), 0);
  });

  it("refuses timestamps outside the 5-minute window and exact replays inside it", async () => {
    const { secret } = await rotateWorkflowWebhookSecret(workflowId, null);
    const body = JSON.stringify({ kind: "lead", n: 1 });
    const stale = await receiveWorkflowWebhook({ workflowId, rawBody: body, signature: sign(secret, body, nowSec() - 301) });
    assert.ok(!stale.ok && stale.status === 401 && /5-minute/.test(stale.error));
    const future = await receiveWorkflowWebhook({ workflowId, rawBody: body, signature: sign(secret, body, nowSec() + 301) });
    assert.ok(!future.ok && future.status === 401);

    const header = sign(secret, body);
    const first = await receiveWorkflowWebhook({ workflowId, rawBody: body, signature: header });
    assert.ok(first.ok && first.status === 201);
    const replay = await receiveWorkflowWebhook({ workflowId, rawBody: body, signature: header });
    assert.ok(!replay.ok && replay.status === 409);
    assert.equal(await prisma.workflowRun.count({ where: { workflowId } }), 1);

    // A fresh signature over the same body is a new delivery.
    const again = await receiveWorkflowWebhook({ workflowId, rawBody: body, signature: sign(secret, body, nowSec() - 30) });
    assert.ok(again.ok);
    assert.equal(await prisma.workflowRun.count({ where: { workflowId } }), 2);
  });

  it("rotation invalidates the old secret; revoke and a missing trigger 404", async () => {
    const { secret: old } = await rotateWorkflowWebhookSecret(workflowId, null);
    const { secret: fresh } = await rotateWorkflowWebhookSecret(workflowId, null);
    const body = "{}";
    const r1 = await receiveWorkflowWebhook({ workflowId, rawBody: body, signature: sign(old, body) });
    assert.ok(!r1.ok && r1.status === 401);
    const r2 = await receiveWorkflowWebhook({ workflowId, rawBody: body, signature: sign(fresh, body) });
    assert.ok(r2.ok);

    await revokeWorkflowWebhook(workflowId);
    const r3 = await receiveWorkflowWebhook({ workflowId, rawBody: body, signature: sign(fresh, body, nowSec() - 2) });
    assert.ok(!r3.ok && r3.status === 404);

    const { secret } = await rotateWorkflowWebhookSecret(workflowId, null);
    await prisma.workflowNode.deleteMany({ where: { workflowId, type: "webhook" } });
    const r4 = await receiveWorkflowWebhook({ workflowId, rawBody: body, signature: sign(secret, body) });
    assert.ok(!r4.ok && r4.status === 404);
    const r5 = await receiveWorkflowWebhook({ workflowId: "no-such-workflow", rawBody: body, signature: sign(secret, body) });
    assert.ok(!r5.ok && r5.status === 404);
  });

  it("an inactive workflow refuses (409) and non-JSON bodies are 400", async () => {
    const { secret } = await rotateWorkflowWebhookSecret(workflowId, null);
    const bad = await receiveWorkflowWebhook({ workflowId, rawBody: "not json", signature: sign(secret, "not json") });
    assert.ok(!bad.ok && bad.status === 400);
    await prisma.workflow.update({ where: { id: workflowId }, data: { status: "paused" } });
    const paused = await receiveWorkflowWebhook({ workflowId, rawBody: "{}", signature: sign(secret, "{}") });
    assert.ok(!paused.ok && paused.status === 409);
    assert.equal(await prisma.workflowRun.count({ where: { workflowId } }), 0);
  });

  it("public route: signed POST → 201 with run id; oversize body 413; missing signature 401; rate limited", async () => {
    const { secret } = await rotateWorkflowWebhookSecret(workflowId, null);
    const call = (body: string, headers: Record<string, string>) =>
      POST(new Request(`http://localhost/api/hooks/workflows/${workflowId}`, { method: "POST", body, headers }), {
        params: Promise.resolve({ id: workflowId }),
      });

    const body = JSON.stringify({ kind: "lead" });
    const ok = await call(body, { [SIGNATURE_HEADER]: sign(secret, body), "content-type": "application/json" });
    assert.equal(ok.status, 201);
    const j = (await ok.json()) as { runId: string; status: string };
    assert.ok(j.runId);
    assert.equal(j.status, "succeeded");
    assert.deepEqual(Object.keys(j).sort(), ["deduped", "runId", "status"]);

    const unsigned = await call(body, {});
    assert.equal(unsigned.status, 401);

    const big = JSON.stringify({ pad: "x".repeat(WORKFLOW_WEBHOOK_MAX_BYTES) });
    const tooBig = await call(big, { [SIGNATURE_HEADER]: sign(secret, big) });
    assert.equal(tooBig.status, 413);

    let limited = 0;
    for (let i = 0; i < 25; i++) {
      const res = await call("{}", {});
      if (res.status === 429) limited++;
    }
    assert.ok(limited > 0, "per-workflow rate limit kicks in");
  });
});
