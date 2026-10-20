// ShapesOS — Phase 17 (latency, A7): the ops overview's "payments last 30
// days" is one SQL aggregate per kind; it equals the old in-memory sum over
// the same rows (refunds subtract) — on seeded data bigger than the old
// 5,000-row read, which the old code under-counted. App role, FORCE RLS.
// Run: DATABASE_URL=<app role> npx tsx --test lib/ops/__tests__/overview-payments-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { getOpsOverview, paymentsNetCents } from "../overview";

const RUN = randomUUID().slice(0, 8);
const WS = `p17ov-${RUN}`;
const WS_OTHER = `p17ov-o-${RUN}`;

before(async () => {
  for (const id of [WS, WS_OTHER]) await prisma.workspace.create({ data: { id, name: id, ownerUserId: `owner-${RUN}` } });
  const now = Date.now();
  const kinds = ["charge", "refund", "payout"] as const;
  const statuses = ["succeeded", "succeeded", "succeeded", "pending", "failed"] as const;
  const rows = Array.from({ length: 5_200 }, (_, i) => ({
    workspaceId: WS,
    kind: kinds[i % 3]!,
    status: statuses[i % 5]!,
    amountCents: 100 + (i % 977),
    // Some inside the window, some 40 days old.
    createdAt: new Date(now - (i % 7 === 0 ? 40 : i % 29) * 86_400_000),
  }));
  await withWorkspaceScope(WS, (tx) => tx.opsPayment.createMany({ data: rows }), { timeoutMs: 60_000 });
  // Another workspace's payments never count.
  await withWorkspaceScope(WS_OTHER, (tx) => tx.opsPayment.create({ data: { workspaceId: WS_OTHER, kind: "charge", status: "succeeded", amountCents: 999_999 } }));
});

after(async () => {
  for (const id of [WS, WS_OTHER]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

describe("ops overview payments (SQL aggregate)", () => {
  it("equals the in-memory sum over every row in the window (no 5,000-row cap)", async () => {
    const since = new Date(Date.now() - 30 * 24 * 3600_000);
    const all = await withWorkspaceScope(WS, (tx) =>
      tx.opsPayment.findMany({ where: { workspaceId: WS, status: "succeeded", createdAt: { gte: since } }, select: { kind: true, amountCents: true } }),
    );
    assert.ok(all.length > 2_500, `seeded ${all.length} rows in the window`);
    const expected = all.reduce((s, p) => s + (p.kind === "refund" ? -p.amountCents : p.amountCents), 0);
    const overview = await withWorkspaceScope(WS, (tx) => getOpsOverview(tx, WS));
    assert.equal(overview.paymentsLast30dCents, expected);
  });

  it("paymentsNetCents: refunds subtract, charges and payouts add", () => {
    assert.equal(paymentsNetCents([{ kind: "charge", sumCents: 1000 }, { kind: "refund", sumCents: 300 }, { kind: "payout", sumCents: 50 }]), 750);
    assert.equal(paymentsNetCents([]), 0);
  });
});
