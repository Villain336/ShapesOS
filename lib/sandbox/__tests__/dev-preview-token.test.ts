// ShapesOS — dev-preview capability tokens (v2). Run:
// npx tsx --test --experimental-test-module-mocks lib/sandbox/__tests__/dev-preview-token.test.ts
import { before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

interface Row {
  id: string; workspaceId: string; projectId: string; port: number; sandboxId: string; userId: string;
  tokenHash: string; tokenEnc: string; createdAt: Date; expiresAt: Date; lastRenewedAt: Date | null; revokedAt: Date | null;
}
const store = new Map<string, Row>();
let seq = 0;
const enc = new Map<string, string>(); // tokenEnc -> raw (the "secrets envelope")

const tx = {
  projectDevPreviewToken: {
    findUnique: async ({ where: { tokenHash } }: { where: { tokenHash: string } }) =>
      [...store.values()].find((r) => r.tokenHash === tokenHash) ?? null,
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      [...store.values()]
        .filter((r) =>
          r.workspaceId === where.workspaceId && r.projectId === where.projectId && r.port === where.port &&
          r.sandboxId === where.sandboxId && r.userId === where.userId && r.revokedAt === null &&
          r.expiresAt > (where.expiresAt as { gt: Date }).gt && r.createdAt > (where.createdAt as { gt: Date }).gt)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null,
    update: async ({ where: { id }, data }: { where: { id: string }; data: Partial<Row> }) => {
      const r = store.get(id);
      if (r) Object.assign(r, data);
      return r;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
      let n = 0;
      for (const r of store.values()) if (r.workspaceId === where.workspaceId && r.projectId === where.projectId && r.revokedAt === null) { Object.assign(r, data); n++; }
      return { count: n };
    },
    create: async ({ data }: { data: Omit<Row, "id" | "createdAt" | "lastRenewedAt" | "revokedAt"> }) => {
      const row: Row = { ...data, id: `t${++seq}`, createdAt: data.createdAt ?? new Date(), lastRenewedAt: null, revokedAt: null };
      store.set(row.id, row);
      return row;
    },
  },
};

mock.module("@/lib/substrate/memory/rls", {
  namedExports: { withWorkspaceScope: async (_ws: string, fn: (t: typeof tx) => Promise<unknown>) => fn(tx) },
});
// The REAL secrets envelope (dynamic import inside the module under test is
// not interceptable by mock.module): give it a throwaway key.
process.env.MARKETR_CREDENTIALS_KEY = "0".repeat(64);

let mod: typeof import("../dev-preview-token");
before(async () => {
  mod = await import("../dev-preview-token");
});

const NOW = new Date("2026-10-26T05:00:00Z");
const IN = { workspaceId: "ws1", projectId: "p1", port: 3000, sandboxId: "sb1", userId: "u1" };

describe("dev-preview capability tokens", () => {
  it("mint: 43-char base64url raw, stored as hash + envelope, never plaintext", async () => {
    const t = await mod.issueOrRenewDevPreviewToken(IN, NOW);
    assert.ok(t && /^[A-Za-z0-9_-]{43}$/.test(t.raw));
    assert.equal(t.reused, false);
    const row = [...store.values()].find((r) => r.tokenHash === mod.hashDevPreviewToken(t.raw));
    assert.ok(row, "row stored");
    assert.ok(!JSON.stringify(row).includes(t.raw), "raw is not stored anywhere (envelope is ciphertext)");
    assert.notEqual(row.tokenHash, t.raw);
    assert.equal(row.expiresAt.getTime() - NOW.getTime(), mod.DEV_PREVIEW_TOKEN_TTL_MS);
  });

  it("renew: SAME raw token re-served, expiry slides, reused=true (src stability)", async () => {
    const t1 = await mod.issueOrRenewDevPreviewToken(IN, NOW);
    const later = new Date(NOW.getTime() + 30 * 60 * 1000);
    const t2 = await mod.issueOrRenewDevPreviewToken(IN, later);
    assert.equal(t2.raw, t1.raw, "same raw token across renewal");
    assert.equal(t2.reused, true);
    assert.equal(t2.expiresAt.getTime() - later.getTime(), mod.DEV_PREVIEW_TOKEN_TTL_MS, "sliding expiry extended from the renewal time");
  });

  it("absolute cap: past 24h from createdAt a fresh token is minted even mid-session", async () => {
    store.clear();
    const t1 = await mod.issueOrRenewDevPreviewToken(IN, NOW);
    const pastCap = new Date(NOW.getTime() + mod.DEV_PREVIEW_TOKEN_MAX_LIFE_MS + 1000);
    const t2 = await mod.issueOrRenewDevPreviewToken(IN, pastCap);
    assert.notEqual(t2.raw, t1.raw, "fresh token past the absolute cap");
    assert.equal(t2.reused, false);
  });

  it("verify: valid token yields claims; project/port binding enforced", async () => {
    store.clear();
    const t = await mod.issueOrRenewDevPreviewToken(IN, NOW);
    const v = await mod.verifyDevPreviewToken("ws1", t.raw, "p1", 3000, NOW);
    assert.deepEqual(v, { userId: "u1", workspaceId: "ws1", projectId: "p1", port: 3000, sandboxId: "sb1" });
    assert.equal(await mod.verifyDevPreviewToken("ws1", t.raw, "p2", 3000, NOW), null, "other project");
    assert.equal(await mod.verifyDevPreviewToken("ws1", t.raw, "p1", 9999, NOW), null, "other port");
    assert.equal(await mod.verifyDevPreviewToken("ws1", "not-a-token", "p1", 3000, NOW), null, "shape");
  });

  it("verify NEVER extends expiry (bearer traffic cannot keep a token alive)", async () => {
    store.clear();
    const t = await mod.issueOrRenewDevPreviewToken(IN, NOW);
    const row = [...store.values()][0];
    const before_ = row.expiresAt.getTime();
    await mod.verifyDevPreviewToken("ws1", t.raw, "p1", 3000, new Date(NOW.getTime() + 10 * 60 * 1000));
    assert.equal(row.expiresAt.getTime(), before_, "expiresAt untouched by verification");
    assert.equal(row.lastRenewedAt, null);
  });

  it("expired, absolute-capped, and revoked tokens verify null", async () => {
    store.clear();
    const t = await mod.issueOrRenewDevPreviewToken(IN, NOW);
    assert.equal(await mod.verifyDevPreviewToken("ws1", t.raw, "p1", 3000, new Date(NOW.getTime() + mod.DEV_PREVIEW_TOKEN_TTL_MS + 1)), null, "expired");
    assert.equal(await mod.verifyDevPreviewToken("ws1", t.raw, "p1", 3000, new Date(NOW.getTime() + mod.DEV_PREVIEW_TOKEN_MAX_LIFE_MS + 1)), null, "absolute cap");
    await mod.revokeDevPreviewTokens("ws1", "p1", NOW);
    assert.equal(await mod.verifyDevPreviewToken("ws1", t.raw, "p1", 3000, NOW), null, "revoked");
  });

  it("undecryptable envelope: revoked and re-minted (key-rotation safe)", async () => {
    store.clear();
    const t1 = await mod.issueOrRenewDevPreviewToken(IN, NOW);
    for (const r of store.values()) r.tokenEnc = "corrupt";
    const t2 = await mod.issueOrRenewDevPreviewToken(IN, NOW);
    assert.notEqual(t2.raw, t1.raw);
    assert.equal(t2.reused, false);
  });
});
