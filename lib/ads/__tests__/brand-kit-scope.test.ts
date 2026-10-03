// ShapesOS — Phase 1 tests: an ad campaign may only reference a brand kit
// from its own workspace (create, update, and at generation time).
// Pure: a stub Prisma client.
// Run: npx tsx --test lib/ads/__tests__/brand-kit-scope.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { AdGuardError, createCampaign, getBrandConstraints, updateCampaign } from "../service";

const KITS = [
  { id: "kit_a", workspaceId: "ws_a", colors: {}, fonts: {}, tone: null, logoPath: null },
  { id: "kit_b", workspaceId: "ws_b", colors: { primary: "#000" }, fonts: {}, tone: "secret", logoPath: null },
];

function stubDb() {
  const writes: Array<{ op: string; data: Record<string, unknown> }> = [];
  const db = {
    brandKit: {
      findFirst: async ({ where }: { where: { id: string; workspaceId?: string } }) =>
        KITS.find((k) => k.id === where.id && (where.workspaceId === undefined || k.workspaceId === where.workspaceId)) ?? null,
    },
    adCampaign: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push({ op: "create", data });
        return { id: "camp_1", projectId: "proj_a", name: data.name, ...data };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push({ op: "update", data });
        return { id: "camp_1", projectId: "proj_a", name: "c", ...data };
      },
    },
    fileChangeLog: { create: async () => ({}) },
  };
  return { db: db as unknown as PrismaClient, writes };
}

const isGuard = (e: unknown) => e instanceof AdGuardError && /brand kit not found/i.test(e.message);

describe("ads campaigns: brandKitId must belong to the workspace", () => {
  it("create refuses another workspace's brand kit", async () => {
    const { db, writes } = stubDb();
    await assert.rejects(() => createCampaign(db, "ws_a", "proj_a", { name: "x", brandKitId: "kit_b" }), isGuard);
    assert.equal(writes.length, 0);
  });

  it("update refuses another workspace's brand kit", async () => {
    const { db, writes } = stubDb();
    await assert.rejects(() => updateCampaign(db, "ws_a", "camp_1", { brandKitId: "kit_b" }), isGuard);
    assert.equal(writes.length, 0);
  });

  it("own brand kit and clearing it still work", async () => {
    const { db, writes } = stubDb();
    await createCampaign(db, "ws_a", "proj_a", { name: "x", brandKitId: "kit_a" });
    await updateCampaign(db, "ws_a", "camp_1", { brandKitId: null });
    assert.deepEqual(writes.map((w) => w.data.brandKitId), ["kit_a", null]);
  });

  it("generation reads brand constraints only from the campaign's workspace", async () => {
    const { db } = stubDb();
    assert.equal(await getBrandConstraints(db, "ws_a", "kit_b"), null);
    assert.ok(await getBrandConstraints(db, "ws_b", "kit_b"));
  });
});
