// ShapesOS — Phase 1 (H4) DB test: the inbound SMS webhook resolves the
// workspace from the receiving number ONLY. A `workspaceId` request param
// (the old fake/test path) can no longer re-opt-in or suppress another
// tenant's leads.
// Run: npx tsx --test lib/messaging/__tests__/inbound-sms-workspace.test.ts
// Requires DATABASE_URL (listed in scripts/test/db-tests.txt).

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/messaging/inbound/sms/route";
import { getConsent } from "@/lib/messaging/consent";

const WS_A = "p1b-sms-a";
const WS_B = "p1b-sms-b";
const NUMBER_A = "+15550170001";
const CALLER = "+15550179999";
const SECRET = "p1b-fake-messaging-secret";
let leadA = "";
let leadB = "";

async function seedLead(workspaceId: string): Promise<string> {
  const pipeline = await prisma.pipeline.create({
    data: { workspaceId, name: "p1b", stages: [{ id: "new", label: "New" }] },
  });
  const lead = await prisma.lead.create({
    data: { workspaceId, pipelineId: pipeline.id, name: "Caller", phone: CALLER },
  });
  return lead.id;
}

before(async () => {
  process.env.FAKE_MESSAGING_SECRET = SECRET;
  delete process.env.MESSAGING_SMS_PROVIDER;
  await prisma.callNumber.deleteMany({ where: { e164: NUMBER_A } });
  for (const id of [WS_A, WS_B]) {
    await prisma.workspace.deleteMany({ where: { id } });
    await prisma.workspace.create({ data: { id, name: id, ownerUserId: `${id}-owner` } });
  }
  await prisma.callNumber.create({ data: { workspaceId: WS_A, e164: NUMBER_A } });
  leadA = await seedLead(WS_A);
  leadB = await seedLead(WS_B);
});

after(async () => {
  await prisma.callNumber.deleteMany({ where: { e164: NUMBER_A } });
  for (const id of [WS_A, WS_B]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

function inbound(params: Record<string, string>) {
  return POST(
    new Request("http://localhost/api/messaging/inbound/sms", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(params),
    }) as unknown as NextRequest,
  );
}

describe("inbound SMS workspace resolution (H4)", () => {
  it("ignores a workspaceId param: STOP lands on the number's workspace", async () => {
    const res = await inbound({ From: CALLER, To: NUMBER_A, Body: "STOP", workspaceId: WS_B });
    assert.equal(res.status, 200);
    assert.equal(await getConsent(WS_A, leadA, "sms"), "opted_out");
    assert.equal(await getConsent(WS_B, leadB, "sms"), "unknown", "victim workspace untouched");
  });

  it("an unknown receiving number is refused even with a workspaceId param", async () => {
    const res = await inbound({ From: CALLER, To: "+15550170002", Body: "START", workspaceId: WS_B });
    assert.equal(res.status, 400);
    assert.equal(await getConsent(WS_B, leadB, "sms"), "unknown");
  });

  it("the literal dev bearer no longer authenticates when a secret is configured", async () => {
    const res = await POST(
      new Request("http://localhost/api/messaging/inbound/sms", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer fake-messaging-dev-secret" },
        body: JSON.stringify({ From: CALLER, To: NUMBER_A, Body: "START" }),
      }) as unknown as NextRequest,
    );
    assert.equal(res.status, 401);
  });
});
