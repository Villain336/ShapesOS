// ShapesOS — Phase 2 (F) DB test: completing a legal deadline is guarded
// (open → done via updateMany, count===1), so a double click / retry /
// concurrent request creates exactly ONE next occurrence, and recurring
// series stay anchored to their first date through the real store.
// Run: npx tsx --test lib/legal/__tests__/deadline-done.test.ts
// Requires DATABASE_URL (listed in scripts/test/db-tests.txt).

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { PrismaLegalStore } from "@/lib/legal/prisma-store";
import { LegalError } from "@/lib/legal/types";

const WS = `p2f-legal-${Date.now().toString(36)}`;
const store = new PrismaLegalStore(prisma);

before(async () => {
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: `${WS}-owner` } });
});

after(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

async function deadline(templateKey: string, dueIso: string, recurrence: "monthly" | "annual" | "none") {
  return prisma.legalDeadline.create({
    data: { workspaceId: WS, templateKey, title: templateKey, dueDate: new Date(`${dueIso}T00:00:00Z`), recurrence },
  });
}

const openFor = (templateKey: string) =>
  prisma.legalDeadline.findMany({ where: { workspaceId: WS, templateKey, status: "open" } });

describe("markDeadlineDone is guarded", () => {
  it("three concurrent completions create exactly one next occurrence", async () => {
    const d = await deadline("p2f-annual-report", "2026-11-01", "annual");
    const results = await Promise.all([
      store.markDeadlineDone(WS, d.id),
      store.markDeadlineDone(WS, d.id),
      store.markDeadlineDone(WS, d.id),
    ]);
    assert.ok(results.every((r) => r.status === "done"), "every caller sees it done (idempotent)");
    const open = await openFor("p2f-annual-report");
    assert.equal(open.length, 1, "one next occurrence, not three");
    assert.equal(open[0]!.dueDate!.toISOString().slice(0, 10), "2027-11-01");
  });

  it("a sequential double-complete is a no-op the second time", async () => {
    const d = await deadline("p2f-quarterly", "2026-12-15", "monthly");
    await store.markDeadlineDone(WS, d.id);
    await store.markDeadlineDone(WS, d.id);
    assert.equal((await openFor("p2f-quarterly")).length, 1);
  });

  it("a dismissed deadline cannot be completed (409 code)", async () => {
    const d = await deadline("p2f-dismissed", "2026-12-15", "annual");
    await store.updateDeadline(WS, d.id, { status: "dismissed" });
    await assert.rejects(store.markDeadlineDone(WS, d.id), (e: LegalError) => e.code === "DEADLINE_NOT_OPEN");
    assert.equal((await openFor("p2f-dismissed")).length, 0);
  });
});

describe("recurrence is anchored to the series' first date", () => {
  it("monthly from Jan 31 walks Feb 28 → Mar 31 → Apr 30 through the store", async () => {
    let d = await deadline("p2f-monthly-eom", "2026-01-31", "monthly");
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      await store.markDeadlineDone(WS, d.id);
      const [next] = await openFor("p2f-monthly-eom");
      seen.push(next!.dueDate!.toISOString().slice(0, 10));
      assert.equal(next!.recurrenceAnchor!.toISOString().slice(0, 10), "2026-01-31");
      d = next!;
    }
    assert.deepEqual(seen, ["2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("annual from 2028-02-29 returns to Feb 29 in 2032", async () => {
    let d = await deadline("p2f-leap", "2028-02-29", "annual");
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      await store.markDeadlineDone(WS, d.id);
      const [next] = await openFor("p2f-leap");
      seen.push(next!.dueDate!.toISOString().slice(0, 10));
      d = next!;
    }
    assert.deepEqual(seen, ["2029-02-28", "2030-02-28", "2031-02-28", "2032-02-29"]);
  });

  it("re-dating an occurrence makes the new date the anchor", async () => {
    const d = await deadline("p2f-redate", "2026-01-31", "monthly");
    await store.markDeadlineDone(WS, d.id);
    const [feb] = await openFor("p2f-redate");
    await store.updateDeadline(WS, feb!.id, { dueDate: "2026-02-15T00:00:00Z" });
    await store.markDeadlineDone(WS, feb!.id);
    const [mar] = await openFor("p2f-redate");
    assert.equal(mar!.dueDate!.toISOString().slice(0, 10), "2026-03-15");
  });
});
