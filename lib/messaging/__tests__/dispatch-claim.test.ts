// ShapesOS — Phase 2 (F) DB test: the messaging dispatcher claims before it
// sends. Overlapping dispatchDue runs (cron + approve clicks) send each
// message once, credits are metered BEFORE the provider call (the hard cap
// suppresses), and stale "sending" claims recover.
// Run: npx tsx --test lib/messaging/__tests__/dispatch-claim.test.ts
// Requires DATABASE_URL (listed in scripts/test/db-tests.txt).

import "dotenv/config";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { dispatchDue, queueMessage, recoverStaleSends, SENDING_STALE_MS } from "@/lib/messaging/dispatcher";
import { setConsent } from "@/lib/messaging/consent";
import { updateMessagingSettings } from "@/lib/messaging/quiet-hours";
import { FakeMessagingProvider } from "@/lib/messaging/provider";
import { setSpendCap } from "@/lib/metering/service";

// usage_events is append-only (metering T5), so a metered workspace can never
// be deleted: each run uses fresh workspace ids and leaves them behind.
const RUN = Date.now().toString(36);
const WS = `p2f-msg-a-${RUN}`;
const WS_CAP = `p2f-msg-cap-${RUN}`;
const leads: Record<string, string> = {};

async function seed(workspaceId: string) {
  await prisma.workspace.create({ data: { id: workspaceId, name: workspaceId, ownerUserId: `${workspaceId}-owner` } });
  const pipeline = await prisma.pipeline.create({
    data: { workspaceId, name: "p2f", stages: [{ id: "new", label: "New" }] },
  });
  const lead = await prisma.lead.create({
    data: { workspaceId, pipelineId: pipeline.id, name: "Lead", phone: "+15550180001", email: "lead@example.com" },
  });
  await setConsent(workspaceId, lead.id, "sms", "opted_in", "test");
  // No quiet window, generous daily cap: the test is about claims, not timing.
  await updateMessagingSettings(workspaceId, { quietStart: 0, quietEnd: 0, dailyCap: 1000 });
  // Default plan (self_hosted) has a 0-credit pool → the hard cap would
  // suppress every send. Give the claim workspace headroom.
  await setSpendCap(workspaceId, { capCredits: 10_000 });
  leads[workspaceId] = lead.id;
}

async function queuedApproved(workspaceId: string, extra: Record<string, unknown> = {}) {
  const approval = await prisma.approvalItem.create({
    data: { workspaceId, kind: "sequence_send", payload: {}, status: "approved" },
  });
  return prisma.outboundMessage.create({
    data: {
      workspaceId,
      leadId: leads[workspaceId],
      channel: "sms",
      kind: "sequence",
      body: "Hi from the claim test",
      status: "queued",
      provider: "fake",
      approvalId: approval.id,
      scheduledFor: new Date(Date.now() - 60_000),
      ...extra,
    },
  });
}

function deliveriesFor(id: string) {
  return FakeMessagingProvider.deliveries.filter((d) => d.idempotencyKey === id).length;
}

before(async () => {
  delete process.env.MESSAGING_SMS_PROVIDER;
  await seed(WS);
  await seed(WS_CAP);
});

beforeEach(() => FakeMessagingProvider.resetCounter());

after(async () => {
  await prisma.$disconnect();
});

describe("dispatcher claim-before-send", () => {
  it("three concurrent dispatchDue runs send one queued message exactly once", async () => {
    const msg = await queuedApproved(WS);
    const results = await Promise.all([dispatchDue(WS), dispatchDue(WS), dispatchDue(WS)]);
    assert.equal(deliveriesFor(msg.id), 1, "provider called once");
    assert.equal(results.reduce((n, r) => n + r.sent, 0), 1, "counted once across runs");
    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: msg.id } });
    assert.equal(row.status, "delivered");
    assert.equal(row.claimedAt, null);
    const charges = await prisma.usageEvent.count({ where: { idempotencyKey: `outbound-message:${msg.id}` } });
    assert.equal(charges, 1, "metered once");
  });

  it("an approved inline send racing the cron sweep still sends once", async () => {
    const approval = await prisma.approvalItem.create({
      data: { workspaceId: WS, kind: "sequence_send", payload: {}, status: "approved" },
    });
    const [queued] = await Promise.all([
      queueMessage({
        workspaceId: WS,
        leadId: leads[WS],
        channel: "sms",
        kind: "sequence",
        body: "Inline vs cron",
        approvalId: approval.id,
      }),
      dispatchDue(WS),
      dispatchDue(WS),
    ]);
    await dispatchDue(WS);
    assert.equal(deliveriesFor(queued.id), 1);
  });

  it("provider gets the message id as its idempotency key", async () => {
    const msg = await queuedApproved(WS);
    await dispatchDue(WS);
    const d = FakeMessagingProvider.deliveries.find((x) => x.idempotencyKey === msg.id);
    assert.ok(d, "send carried idempotencyKey = message id");
  });
});

describe("credits are metered before the provider call", () => {
  it("the hard cap suppresses the send instead of sending unbilled", async () => {
    await setSpendCap(WS_CAP, { capCredits: 4, blockAtCap: true, autoOverage: false }); // one SMS segment = 4 credits
    const a = await queuedApproved(WS_CAP);
    const b = await queuedApproved(WS_CAP);
    const res = await dispatchDue(WS_CAP);
    assert.equal(res.sent, 1);
    assert.equal(res.suppressed, 1);
    assert.equal(FakeMessagingProvider.deliveries.length, 1, "only the in-cap message reached the provider");
    const rows = await prisma.outboundMessage.findMany({ where: { id: { in: [a.id, b.id] } }, orderBy: { createdAt: "asc" } });
    assert.equal(rows[0]!.status, "delivered");
    assert.equal(rows[1]!.status, "suppressed");
    assert.equal(rows[1]!.suppressionReason, "credit_cap");
    const charged = await prisma.usageEvent.count({ where: { idempotencyKey: `outbound-message:${b.id}` } });
    assert.equal(charged, 0, "a suppressed message is never charged");
  });
});

describe("stale sending claims recover", () => {
  it("a stale claim on an idempotent provider is requeued and sent once; a fresh claim is left alone", async () => {
    const stale = await queuedApproved(WS, {
      status: "sending",
      claimedAt: new Date(Date.now() - SENDING_STALE_MS - 60_000),
    });
    const fresh = await queuedApproved(WS, { status: "sending", claimedAt: new Date() });
    await Promise.all([dispatchDue(WS), dispatchDue(WS)]);
    assert.equal(deliveriesFor(stale.id), 1);
    assert.equal((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: stale.id } })).status, "delivered");
    assert.equal(deliveriesFor(fresh.id), 0);
    assert.equal((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: fresh.id } })).status, "sending");
    await prisma.outboundMessage.delete({ where: { id: fresh.id } });
  });

  it("a stale claim on a provider without idempotency keys (Twilio) fails loudly, never re-sends", async () => {
    const stale = await queuedApproved(WS, {
      status: "sending",
      provider: "twilio",
      claimedAt: new Date(Date.now() - SENDING_STALE_MS - 60_000),
    });
    const out = await recoverStaleSends(WS);
    assert.equal(out.failed, 1);
    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: stale.id } });
    assert.equal(row.status, "failed");
    assert.match(row.error ?? "", /outcome unknown/);
    assert.equal(deliveriesFor(stale.id), 0);
  });
});

// Phase 4a follow-up: the daily cap used to be check-then-act (count, then
// claim), so parallel sends could all see headroom and overshoot it. The
// claim is now serialized per workspace-day and counts inside the same
// transaction.
describe("daily cap is atomic under concurrency", () => {
  const WS_DAILY = `p4fix-msg-daily-${RUN}`;
  const CAP = 3;

  before(async () => {
    await seed(WS_DAILY);
    await updateMessagingSettings(WS_DAILY, { dailyCap: CAP });
  });

  it("parallel inline sends + overlapping sweeps never exceed the cap", async () => {
    const approvals = await Promise.all(
      Array.from({ length: 6 }, () =>
        prisma.approvalItem.create({ data: { workspaceId: WS_DAILY, kind: "sequence_send", payload: {}, status: "approved" } }),
      ),
    );
    const queuedRows = await Promise.all(Array.from({ length: 6 }, () => queuedApproved(WS_DAILY)));
    // 6 approved inline sends (queueMessage → claim → send) racing 3 sweeps
    // over 6 more queued rows: 12 candidates, cap 3.
    const results = await Promise.all([
      ...approvals.map((a, i) =>
        queueMessage({
          workspaceId: WS_DAILY,
          leadId: leads[WS_DAILY],
          channel: "sms",
          kind: "sequence",
          body: `Parallel send ${i}`,
          approvalId: a.id,
        }),
      ),
      dispatchDue(WS_DAILY),
      dispatchDue(WS_DAILY),
      dispatchDue(WS_DAILY),
    ]);
    const inlineIds = results.slice(0, approvals.length).map((r) => (r as { id: string }).id);
    const ids = [...queuedRows.map((r) => r.id), ...inlineIds];
    const rows = await prisma.outboundMessage.findMany({ where: { id: { in: ids } } });
    const sent = rows.filter((r) => r.status === "sent" || r.status === "delivered");
    assert.equal(sent.length, CAP, `exactly the cap was sent (got ${sent.length})`);
    assert.equal(ids.reduce((n, id) => n + deliveriesFor(id), 0), CAP, "provider reached exactly cap times");
    const rest = rows.filter((r) => r.status !== "sent" && r.status !== "delivered");
    assert.equal(rest.length, ids.length - CAP);
    for (const r of rest) {
      assert.equal(r.status, "suppressed");
      assert.equal(r.suppressionReason, "cap");
    }
  });
});
