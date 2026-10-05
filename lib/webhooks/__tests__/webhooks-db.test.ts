// ShapesOS — outbound webhooks against real Postgres (Phase 4a).
// Enqueue from real domain points, signed delivery through safeFetch (fake
// DNS + fake fetch, no network), retries/backoff, dead letter, redelivery,
// stuck-row reclaim, plan gating, tenant isolation under FORCE RLS, and
// "emitting never fails the triggering action".
// Run (as the least-privilege app role): DATABASE_URL=… npx tsx --test lib/webhooks/__tests__/webhooks-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { createEndpoint, listDeliveries, redeliver, updateEndpoint, deleteEndpoint, queueTestEvent } from "../endpoints";
import { emitWebhookEvent } from "../emit";
import { deliverDue, deliverNow, MAX_ATTEMPTS } from "../dispatch";
import { verifyWebhookSignature, SIGNATURE_HEADER } from "../signing";
import { createLeadRecord } from "@/lib/crm/leads";
import { notifyApprovalNeeded } from "@/lib/notifications/producers";
import { createAgentRun, finishAgentRun } from "@/lib/agents/runs/service";
import { EntitlementError } from "@/lib/billing/entitlements";
import { randomBytes } from "node:crypto";

// Secrets are stored as a secrets() envelope; CI sets a key, local runs may not.
process.env.MARKETR_CREDENTIALS_KEY ||= randomBytes(32).toString("hex");

const WS = "p4a-wh-ws";
const WS2 = "p4a-wh-ws2";
const STARTER = "p4a-wh-starter";
const OWNER = "p4a-wh-owner";
const EDITOR = "p4a-wh-editor";
const resolve = async () => ["93.184.216.34"];

interface Captured {
  url: string;
  headers: Headers;
  body: string;
}
let captured: Captured[] = [];
let reply: () => Response | Promise<Response> = () => new Response("ok", { status: 200 });
const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
  captured.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body ?? "") });
  return reply();
}) as typeof fetch;
const deps = { fetchFn, resolve };

const deliveries = (ws: string) =>
  withWorkspaceScope(ws, (tx) => tx.webhookDelivery.findMany({ where: { workspaceId: ws }, orderBy: { createdAt: "asc" } }));

async function freshEndpoint(ws = WS, events: string[] = []) {
  return createEndpoint(ws, OWNER, { url: "https://hooks.example.test/in", events }, { resolve });
}

before(async () => {
  for (const id of [WS, WS2, STARTER]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: OWNER, plan: "pro" } });
  await prisma.workspace.create({ data: { id: WS2, name: WS2, ownerUserId: OWNER, plan: "agency" } });
  await prisma.workspace.create({ data: { id: STARTER, name: STARTER, ownerUserId: OWNER, plan: "starter" } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: OWNER, role: "owner" },
      { workspaceId: WS, userId: EDITOR, role: "editor" },
      { workspaceId: WS2, userId: OWNER, role: "owner" },
    ],
  });
});

beforeEach(async () => {
  captured = [];
  reply = () => new Response("ok", { status: 200 });
  for (const ws of [WS, WS2]) {
    await withWorkspaceScope(ws, (tx) => tx.webhookEndpoint.deleteMany({ where: { workspaceId: ws } }));
  }
});

after(async () => {
  for (const id of [WS, WS2, STARTER]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

describe("webhooks (DB)", () => {
  it("creates an endpoint with a one-time secret stored only encrypted", async () => {
    const { endpoint, secret } = await freshEndpoint();
    assert.match(secret, /^whsec_/);
    const row = await withWorkspaceScope(WS, (tx) => tx.webhookEndpoint.findFirstOrThrow({ where: { id: endpoint.id } }));
    assert.notEqual(row.secretEnc, secret);
    assert.ok(!row.secretEnc.includes(secret));
    assert.ok(!JSON.stringify(endpoint).includes(secret), "the view never carries the secret");
  });

  it("is plan-gated: starter can't create endpoints and gets nothing enqueued", async () => {
    await assert.rejects(freshEndpoint(STARTER), EntitlementError);
    const res = await emitWebhookEvent({ workspaceId: STARTER, type: "webhook.ping", data: { message: "x" } });
    assert.equal(res.enqueued, 0);
  });

  it("delivers a signed envelope a receiver can verify", async () => {
    const { endpoint, secret } = await freshEndpoint();
    const res = await emitWebhookEvent({ workspaceId: WS, type: "invoice.paid", data: {
      id: "inv_1", customerId: null, totalCents: 5000, taxCents: 0, status: "paid", sentAt: null, dueAt: null, paidAt: new Date().toISOString(),
    } });
    assert.equal(res.enqueued, 1);
    const summary = await deliverDue({ workspaceId: WS, deps });
    assert.equal(summary.succeeded, 1);
    assert.equal(captured.length, 1);
    const req = captured[0]!;
    assert.equal(req.url, endpoint.url);
    assert.equal(req.headers.get("content-type"), "application/json");
    assert.equal(req.headers.get("ShapesOS-Event-Type"), "invoice.paid");
    assert.equal(req.headers.get("ShapesOS-Event-Id"), res.eventId);
    assert.deepEqual(verifyWebhookSignature(secret, req.body, req.headers.get(SIGNATURE_HEADER)).ok, true);
    const body = JSON.parse(req.body);
    assert.equal(body.type, "invoice.paid");
    assert.equal(body.workspaceId, WS);
    assert.equal(body.data.totalCents, 5000);
    const [row] = await deliveries(WS);
    assert.equal(row!.status, "succeeded");
    assert.equal(row!.attempts, 1);
    assert.equal(row!.responseStatus, 200);
    assert.ok(row!.deliveredAt);
    // Nothing left to send.
    assert.equal((await deliverDue({ workspaceId: WS, deps })).attempted, 0);
  });

  it("honours the event filter, disabled endpoints and per-endpoint dedupe", async () => {
    const leads = await freshEndpoint(WS, ["lead.created"]);
    const all = await freshEndpoint(WS);
    const off = await freshEndpoint(WS);
    await updateEndpoint(WS, off.endpoint.id, { enabled: false });
    const ping = { message: "x" };
    const approval = { source: "mission", sourceId: "a1", title: "t", href: null, requestedBy: null };
    assert.equal((await emitWebhookEvent({ workspaceId: WS, type: "approval.needed", data: approval, dedupKey: "k1" })).enqueued, 1);
    assert.equal((await emitWebhookEvent({ workspaceId: WS, type: "approval.needed", data: approval, dedupKey: "k1" })).enqueued, 0);
    assert.equal((await emitWebhookEvent({ workspaceId: WS, type: "webhook.ping", data: ping, endpointId: leads.endpoint.id })).enqueued, 1);
    const rows = await deliveries(WS);
    assert.deepEqual(
      rows.map((r) => [r.endpointId, r.eventType]),
      [
        [all.endpoint.id, "approval.needed"],
        [leads.endpoint.id, "webhook.ping"],
      ],
    );
  });

  it("retries with backoff, then dead-letters; redeliver sends the same event again", async () => {
    await freshEndpoint();
    await emitWebhookEvent({ workspaceId: WS, type: "webhook.ping", data: { message: "x" } });
    reply = () => new Response("nope", { status: 500 });
    const t0 = Date.now();
    await deliverDue({ workspaceId: WS, deps: { ...deps, rand: () => 0.5 } });
    let [row] = await deliveries(WS);
    assert.equal(row!.status, "pending");
    assert.equal(row!.attempts, 1);
    assert.equal(row!.responseStatus, 500);
    assert.equal(row!.responseBody, "nope");
    assert.match(row!.lastError ?? "", /HTTP 500/);
    const wait = row!.nextAttemptAt.getTime() - t0;
    assert.ok(wait >= 55_000 && wait <= 65_000, `next attempt in ${wait}ms`);
    // Not due yet → nothing attempted.
    assert.equal((await deliverDue({ workspaceId: WS, deps })).attempted, 0);

    // Network failure on the final attempt → dead.
    reply = () => {
      throw new Error("connect ECONNREFUSED");
    };
    await withWorkspaceScope(WS, (tx) =>
      tx.webhookDelivery.update({ where: { id: row!.id }, data: { attempts: MAX_ATTEMPTS - 1, nextAttemptAt: new Date(Date.now() - 1000) } }),
    );
    const s = await deliverDue({ workspaceId: WS, deps });
    assert.equal(s.dead, 1);
    [row] = await deliveries(WS);
    assert.equal(row!.status, "dead");
    assert.match(row!.lastError ?? "", /ECONNREFUSED/);
    const ep = await withWorkspaceScope(WS, (tx) => tx.webhookEndpoint.findFirstOrThrow({ where: { id: row!.endpointId } }));
    assert.equal(ep.consecutiveFailures, 2);

    reply = () => new Response(null, { status: 204 });
    const copyId = await redeliver(WS, row!.id);
    const outcome = await deliverNow(WS, copyId, deps);
    assert.equal(outcome?.status, "succeeded");
    const rows = await deliveries(WS);
    assert.equal(rows.length, 2);
    assert.equal(rows[1]!.eventId, rows[0]!.eventId, "redelivery keeps the event id");
    assert.equal(rows[1]!.redeliveryOf, row!.id);
    const log = await listDeliveries(WS, { limit: 10, status: "succeeded" });
    assert.deepEqual(log.map((d) => d.id), [copyId]);
  });

  it("does not follow redirects and reclaims rows stuck in delivering", async () => {
    await freshEndpoint();
    await emitWebhookEvent({ workspaceId: WS, type: "webhook.ping", data: { message: "x" } });
    reply = () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
    await deliverDue({ workspaceId: WS, deps });
    let [row] = await deliveries(WS);
    assert.equal(row!.status, "pending");
    assert.equal(captured.length, 1, "the redirect target was never requested");

    // Simulate a crash mid-request: delivering, last attempt 20 minutes ago.
    await withWorkspaceScope(WS, (tx) =>
      tx.webhookDelivery.update({ where: { id: row!.id }, data: { status: "delivering", lastAttemptAt: new Date(Date.now() - 20 * 60_000) } }),
    );
    reply = () => new Response("ok", { status: 200 });
    assert.equal((await deliverDue({ workspaceId: WS, deps })).succeeded, 1);
    [row] = await deliveries(WS);
    assert.equal(row!.status, "succeeded");
  });

  it("dead-letters immediately when the endpoint is turned off or the plan drops webhooks", async () => {
    const { endpoint } = await freshEndpoint();
    await emitWebhookEvent({ workspaceId: WS, type: "webhook.ping", data: { message: "x" } });
    await updateEndpoint(WS, endpoint.id, { enabled: false });
    await deliverDue({ workspaceId: WS, deps });
    let [row] = await deliveries(WS);
    assert.equal(row!.status, "dead");
    assert.match(row!.lastError ?? "", /disabled/);
    assert.equal(captured.length, 0);

    await updateEndpoint(WS, endpoint.id, { enabled: true });
    await emitWebhookEvent({ workspaceId: WS, type: "webhook.ping", data: { message: "y" } });
    await prisma.workspace.update({ where: { id: WS }, data: { plan: "starter" } });
    try {
      await deliverDue({ workspaceId: WS, deps });
      row = (await deliveries(WS))[1];
      assert.equal(row!.status, "dead");
      assert.match(row!.lastError ?? "", /plan/);
      await assert.rejects(updateEndpoint(WS, endpoint.id, { rotateSecret: true }), EntitlementError);
      // Turning an endpoint off never needs the plan.
      await updateEndpoint(WS, endpoint.id, { enabled: false });
    } finally {
      await prisma.workspace.update({ where: { id: WS }, data: { plan: "pro" } });
    }
  });

  it("keeps tenants apart under FORCE RLS", async () => {
    const mine = await freshEndpoint(WS);
    await freshEndpoint(WS2);
    await emitWebhookEvent({ workspaceId: WS2, type: "webhook.ping", data: { message: "x" } });
    // The other workspace's scope can't see, update, delete or test it.
    const seen = await withWorkspaceScope(WS2, (tx) => tx.webhookEndpoint.findMany({ where: { id: mine.endpoint.id } }));
    assert.equal(seen.length, 0);
    await assert.rejects(updateEndpoint(WS2, mine.endpoint.id, { enabled: false }), /not found/i);
    await assert.rejects(deleteEndpoint(WS2, mine.endpoint.id), /not found/i);
    await assert.rejects(queueTestEvent(WS2, mine.endpoint.id), /not found/i);
    // Unscoped reads see nothing (fail-closed).
    const raw = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM webhook_deliveries`;
    assert.equal(raw[0]!.n, 0);
    // A one-workspace drain never touches the other workspace's queue.
    await deliverDue({ workspaceId: WS, deps });
    assert.equal(captured.length, 0);
    assert.equal((await deliveries(WS2))[0]!.status, "pending");
  });

  it("emits from real domain points: lead created, approval needed (+ notifications), agent run finished/failed", async () => {
    await freshEndpoint();
    const pipeline = await prisma.pipeline.create({
      data: { workspaceId: WS, name: "Sales", stages: [{ id: "new", label: "New" }, { id: "won", label: "Won" }] },
    });
    const lead = await createLeadRecord(WS, "test", { pipelineId: pipeline.id, name: "Ada Lovelace", email: "ada@p4a.test" });
    assert.ok(lead.ok);
    await notifyApprovalNeeded({ workspaceId: WS, source: "mission", sourceId: "m-1", title: "Launch", requestedBy: EDITOR });
    const run = await createAgentRun({ workspaceId: WS, kind: "mission", startedBy: EDITOR });
    await finishAgentRun(WS, run.id, "failed");
    const run2 = await createAgentRun({ workspaceId: WS, kind: "playbook", startedBy: EDITOR });
    await finishAgentRun(WS, run2.id, "succeeded");
    const types = (await deliveries(WS)).map((d) => d.eventType);
    assert.ok(types.includes("lead.created"), types.join());
    assert.ok(types.includes("approval.needed"));
    assert.ok(types.includes("notification.created"));
    assert.ok(types.includes("agent_run.failed"));
    assert.ok(types.includes("agent_run.finished"));
    const leadEvent = (await deliveries(WS)).find((d) => d.eventType === "lead.created")!;
    assert.equal((leadEvent.payload as { data: { email: string } }).data.email, "ada@p4a.test");
    await prisma.pipeline.deleteMany({ where: { workspaceId: WS } });
  });

  it("never fails the triggering action", async () => {
    // Invalid data, unknown workspace, no endpoints: all resolve to 0.
    assert.equal((await emitWebhookEvent({ workspaceId: WS, type: "invoice.paid", data: { id: 1 } as never })).enqueued, 0);
    assert.equal((await emitWebhookEvent({ workspaceId: "nope-ws", type: "webhook.ping", data: { message: "x" } })).enqueued, 0);
    assert.equal((await emitWebhookEvent({ workspaceId: "", type: "webhook.ping", data: { message: "x" } })).enqueued, 0);
  });
});
