// ShapesOS — Phase 1 DB test: outreach provider webhooks.
//  - the unsigned ?workspaceId= query param can no longer pick the tenant
//    (a captured signed event can't be replayed into another workspace);
//  - idempotency is durable (outreach_webhook_events): a replay is a no-op
//    even from a fresh process/instance.
// Run: npx tsx --test lib/authority/outreach/__tests__/webhook-tenant-db.test.ts
// Requires DATABASE_URL (listed in scripts/test/db-tests.txt).

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { handleProviderEvent } from "@/app/api/authority/outreach/webhooks/_handler";
import { hashEmail } from "@/lib/authority/outreach";

const WS_A = "p1b-ow-a";
const WS_VICTIM = "p1b-ow-victim";
const SECRET = "p1b-smartlead-secret";
const EMAIL = "lead@example.com";

before(async () => {
  process.env.SMARTLEAD_WEBHOOK_SECRET = SECRET;
  for (const id of [WS_A, WS_VICTIM]) {
    await prisma.workspace.deleteMany({ where: { id } });
    await prisma.workspace.create({ data: { id, name: id, ownerUserId: `${id}-owner` } });
  }
  await prisma.outreachWebhookEvent.deleteMany({ where: { workspaceId: { in: [WS_A, WS_VICTIM] } } });
});

after(async () => {
  for (const id of [WS_A, WS_VICTIM]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

function post(body: Record<string, unknown>, query = "") {
  const raw = JSON.stringify(body);
  const sig = createHmac("sha256", SECRET).update(raw, "utf8").digest("hex");
  return handleProviderEvent(
    new Request(`http://localhost/api/authority/outreach/webhooks/smartlead${query}`, {
      method: "POST",
      headers: { "x-marketr-signature": sig, "content-type": "application/json" },
      body: raw,
    }),
    "smartlead",
  );
}

async function suppressed(workspaceId: string): Promise<boolean> {
  const rows = await prisma.suppressionList.findMany({ where: { workspaceId } });
  return rows.some((r) => Array.isArray(r.entriesJson) && (r.entriesJson as string[]).includes(hashEmail(EMAIL)));
}

describe("outreach webhooks: signed tenant + durable idempotency", () => {
  it("ignores ?workspaceId= — a sequence-less event without a signed workspace is rejected", async () => {
    const res = await post({ eventId: "p1b-ev-1", type: "unsubscribed", email: EMAIL }, `?workspaceId=${WS_VICTIM}`);
    assert.equal(res.status, 422);
    assert.equal(await suppressed(WS_VICTIM), false);
  });

  it("uses the workspaceId inside the signed body", async () => {
    const res = await post({ eventId: "p1b-ev-2", type: "unsubscribed", email: EMAIL, workspaceId: WS_A }, `?workspaceId=${WS_VICTIM}`);
    assert.equal(res.status, 200);
    assert.equal(await suppressed(WS_A), true);
    assert.equal(await suppressed(WS_VICTIM), false);
  });

  it("a replay of the same provider event is a durable no-op", async () => {
    const body = { eventId: "p1b-ev-3", type: "bounced", email: "other@example.com", workspaceId: WS_A };
    const first = (await (await post(body)).json()) as { duplicate: boolean };
    assert.equal(first.duplicate, false);
    // The idempotency row lives in the DB (not process memory).
    assert.equal(await prisma.outreachWebhookEvent.count({ where: { provider: "smartlead", eventId: "p1b-ev-3" } }), 1);
    const second = (await (await post(body)).json()) as { duplicate: boolean };
    assert.equal(second.duplicate, true);
  });

  it("an unsigned (or wrongly signed) event is refused before any tenant lookup", async () => {
    const res = await handleProviderEvent(
      new Request("http://localhost/api/authority/outreach/webhooks/smartlead", {
        method: "POST",
        headers: { "x-marketr-signature": "00", "content-type": "application/json" },
        body: JSON.stringify({ eventId: "p1b-ev-4", type: "unsubscribed", email: EMAIL, workspaceId: WS_VICTIM }),
      }),
      "smartlead",
    );
    assert.equal(res.status, 401);
    assert.equal(await suppressed(WS_VICTIM), false);
  });
});
