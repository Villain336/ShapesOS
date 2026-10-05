// ShapesOS — billing reads under the least-privilege app role.
// lib/metering/billing.ts used to create billing_subscriptions (and the top-up
// idempotency table) with runtime DDL on every cold start. The runtime role
// has no CREATE right on the schema, so /dashboard/billing 500'd ("permission
// denied for schema public"). The tables now come from migrations and the
// runtime DDL only runs when a table is genuinely missing.
// Run (DB suite, as the app role): DATABASE_URL=… npx tsx --test lib/metering/__tests__/billing-least-privilege-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getSubscriptionState, getTopUpHistory } from "../billing";

const WS = `billing-lp-${randomUUID().slice(0, 8)}`;

before(async () => {
  await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at)
    VALUES (${WS}, ${WS}, ${"test:" + WS}, now()) ON CONFLICT DO NOTHING`;
});

after(async () => {
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS}`.catch(() => {});
  await prisma.$disconnect();
});

describe("billing under the least-privilege role", () => {
  it("reads subscription state and top-up history without DDL rights", async () => {
    const priv = await prisma.$queryRaw<Array<{ can_create: boolean }>>`
      SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS can_create`;
    if (priv[0].can_create) {
      // Run as a superuser/owner the test proves nothing; CI runs it as the app role.
      return;
    }
    const state = await getSubscriptionState(WS);
    assert.ok(state, "subscription state resolves");
    const history = await getTopUpHistory(WS);
    assert.ok(Array.isArray(history));
  });
});
