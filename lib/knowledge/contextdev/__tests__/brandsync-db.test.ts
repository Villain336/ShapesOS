// ShapesOS Phase 15.1 — BUG A: every Context.dev brand sync failed because
// proposeBrandSync priced the call as contextDevCreditsFor("brand"), which
// throws ("unknown operation") — the operation is "brand_retrieve". This DB
// suite runs the real proposeBrandSync (vault key, daily budget, brand_syncs
// row) against Postgres as the app role, with the Context.dev HTTP API
// stubbed (labelled MOCK — the live brand endpoint is UNVERIFIED-LIVE).
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… MARKETR_CREDENTIALS_KEY=… npx tsx --test lib/knowledge/contextdev/__tests__/brandsync-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { storeContextDevKey } from "../keys";
import { getDailyBudget } from "../budget-store";
import { proposeBrandSync } from "../brandsync";
import { CONTEXTDEV_CREDIT_COSTS } from "../costs";

const RUN = `p15bs-${Date.now().toString(36)}`;
const WS = `${RUN}-ws`;
const USER = `${RUN}-user`;
const calls: string[] = [];

// MOCK Context.dev: /brand/retrieve returns a fixed profile.
const fakeFetch: typeof fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  calls.push(u.pathname);
  return new Response(
    JSON.stringify({ brand: { name: "Acme Corp", colors: ["#112233", "#445566"], fonts: ["Archivo"] } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

before(async () => {
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: USER } });
  await storeContextDevKey(USER, WS, "cd-test-key-p15");
});

after(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

describe("proposeBrandSync (BUG A)", () => {
  it("prices the brand fetch as brand_retrieve, fetches once and holds the diff for approval", async () => {
    const before = await getDailyBudget(WS);
    const row = await proposeBrandSync(WS, { domain: "https://acme.example/" }, fakeFetch);
    assert.equal(row.status, "pending_approval");
    assert.equal(row.creditsUsed, CONTEXTDEV_CREDIT_COSTS.brand_retrieve);
    assert.equal(row.creditsUsed, 10);
    assert.deepEqual(calls, ["/v1/brand/retrieve"]);
    const afterBudget = await getDailyBudget(WS);
    assert.equal(afterBudget.usedToday - before.usedToday, 10, "the daily budget is charged the brand_retrieve cost");
    const failed = await prisma.brandSync.count({ where: { workspaceId: WS, status: "failed" } });
    assert.equal(failed, 0);
  });
});
