// Marketr — Phase 13B Worker 4 tests: knowledge CRUD + tenant RLS.
// Integration: hits the real DB with fixture workspaces (created + cleaned
// up by this file), exercising the same withWorkspaceScope code paths the
// API routes use. Mirrors scripts/verify-phase13b-rls.mts.
// Run: npx tsx --test lib/intelligence/company/__tests__/knowledge-rls.test.ts
// Requires DATABASE_URL.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import {
  withWorkspaceScope,
  countWithoutScope,
} from "@/lib/substrate/memory/rls";

const WS_A = "13b-w4-a";
const WS_B = "13b-w4-b";

before(async () => {
  for (const id of [WS_A, WS_B]) {
    await prisma.workspace.deleteMany({ where: { id } });
    await prisma.workspace.create({
      data: { id, name: `13b w4 ${id}`, ownerUserId: "13b-w4-owner" },
    });
  }
});

after(async () => {
  for (const id of [WS_A, WS_B]) {
    await prisma.workspace.deleteMany({ where: { id } });
  }
  await prisma.$disconnect();
});

describe("company_knowledge CRUD (RLS-scoped)", () => {
  it("creates + reads an entry inside its own workspace scope", async () => {
    const created = await withWorkspaceScope(WS_A, (tx) =>
      tx.companyKnowledge.create({
        data: {
          workspaceId: WS_A,
          kind: "product",
          title: "Marketr",
          body: { summary: "Marketing OS", features: ["SEO", "content"] },
        },
      }),
    );
    assert.ok(created.id);

    const listed = await withWorkspaceScope(WS_A, (tx) =>
      tx.companyKnowledge.findMany({ where: { workspaceId: WS_A } }),
    );
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.title, "Marketr");
  });

  it("is invisible cross-workspace (RLS read isolation)", async () => {
    const seenFromB = await withWorkspaceScope(WS_B, (tx) =>
      tx.companyKnowledge.findMany({ where: { workspaceId: WS_A } }),
    );
    assert.equal(seenFromB.length, 0, "workspace B must not see A's entries");
  });

  it("is invisible without the GUC (fail-closed)", async () => {
    const n = await countWithoutScope("company_knowledge");
    assert.equal(n, 0, "no-GUC reads must see zero rows");
  });

  it("blocks cross-workspace INSERT (RLS WITH CHECK)", async () => {
    await assert.rejects(
      withWorkspaceScope(WS_A, (tx) =>
        tx.companyKnowledge.create({
          data: {
            workspaceId: WS_B, // lying about the tenant
            kind: "other",
            title: "smuggled",
            body: {},
          },
        }),
      ),
      "cross-workspace INSERT must be rejected by RLS",
    );
  });

  it("updates (incl. pin) and deletes within scope", async () => {
    const entry = await withWorkspaceScope(WS_A, (tx) =>
      tx.companyKnowledge.findFirst({ where: { workspaceId: WS_A } }),
    );
    assert.ok(entry);

    const updated = await withWorkspaceScope(WS_A, (tx) =>
      tx.companyKnowledge.update({
        where: { id: entry!.id },
        data: { pinned: true, title: "Marketr (pinned)" },
      }),
    );
    assert.equal(updated.pinned, true);
    assert.equal(updated.title, "Marketr (pinned)");

    // Unscoped UPDATE is a no-op under FORCE RLS.
    const unscoped = await prisma.companyKnowledge.updateMany({
      where: { id: entry!.id },
      data: { title: "hijacked" },
    });
    assert.equal(unscoped.count, 0, "unscoped UPDATE must touch zero rows");

    await withWorkspaceScope(WS_A, (tx) =>
      tx.companyKnowledge.delete({ where: { id: entry!.id } }),
    );
    const remaining = await withWorkspaceScope(WS_A, (tx) =>
      tx.companyKnowledge.count({ where: { workspaceId: WS_A } }),
    );
    assert.equal(remaining, 0);
  });
});
