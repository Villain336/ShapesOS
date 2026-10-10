// Phase 21A (WS=agentweb): the agent web layer against Postgres as the app role.
//   1. RLS: every new table is invisible without the workspace GUC and across workspaces;
//   2. captures are stored workspace-scoped, verify while signed, and expire with retention;
//   3. the site capability registry is per workspace, counts what worked, and feeds the selector;
//   4. settings are validated (cap, retention, provider order).
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… npx tsx --test lib/agentweb/__tests__/agentweb-db.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

process.env.MARKETR_CREDENTIALS_KEY ||= randomBytes(32).toString("hex");
process.env.MARKETR_STORAGE ||= "local";

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { captureOf, signCapture, receiptSecret } from "../receipts";
import { getCapture, listCaptures, purgeExpiredCaptures, storeCapture } from "../captures-store";
import { failedChannels, getSiteCapability, listSiteCapabilities, recordOutcome, recordProbe } from "../registry";
import { detectChannels } from "../channels";
import { getConfig, saveConfig, SettingsError } from "../settings";

const RUN = `p21aw-${Date.now().toString(36)}`;
const A = `${RUN}-a`;
const B = `${RUN}-b`;

before(async () => {
  for (const id of [A, B]) await prisma.workspace.create({ data: { id, name: id, ownerUserId: `${id}-owner`, plan: "pro" } });
});
after(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [A, B] } } });
  await prisma.$disconnect();
});

const signed = (url: string, html = "<p>hello</p>") => signCapture(captureOf({ url, html, fetchedAt: new Date() }), receiptSecret());

describe("RLS on the new tables", () => {
  it("no workspace GUC: zero rows from every table; a write is refused", async () => {
    await storeCapture(A, signed("https://rls.test/"), { via: "fetch", retentionDays: 5 });
    for (const t of ["web_captures", "web_answers", "agentweb_settings", "agentweb_site_capabilities"]) {
      const rows = await prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM ${t}`);
      assert.equal(rows.length, 0, t);
    }
    await assert.rejects(() => prisma.$executeRawUnsafe(`INSERT INTO agentweb_settings (workspace_id, updated_at) VALUES ('${A}', now())`), /row-level security|violates/i);
  });

  it("a workspace cannot write a row for another workspace", async () => {
    await assert.rejects(
      () => withWorkspaceScope(A, (tx) => (tx as typeof prisma).webAnswer.create({ data: { workspaceId: B, userId: "u", question: "q" } })),
      /row-level security|violates/i,
    );
  });
});

describe("captures", () => {
  it("are stored, listed and read only inside their own workspace", async () => {
    const c = signed("https://scoped.test/page", "<p>only for A</p>");
    await storeCapture(A, c, { via: "search-snippet", provider: "mock", answerId: "ans1", bodyText: "only for A" });
    assert.equal((await getCapture(A, c.id))?.url, "https://scoped.test/page");
    assert.equal((await getCapture(A, c.id))?.bodyText, "only for A");
    assert.equal(await getCapture(B, c.id), null);
    assert.deepEqual((await listCaptures(B)).map((x) => x.id), []);
    assert.deepEqual((await listCaptures(A, { answerId: "ans1" })).map((x) => x.id), [c.id]);
  });

  it("report whether the signature still verifies", async () => {
    const c = signed("https://verify.test/");
    await storeCapture(A, c, { via: "fetch" });
    const got = (await getCapture(A, c.id))!;
    assert.deepEqual([got.signedWith, got.verified], ["hmac-sha256", true]);
    await withWorkspaceScope(A, (tx) => (tx as typeof prisma).webCapture.update({ where: { workspaceId_id: { workspaceId: A, id: c.id } }, data: { url: "https://tampered.test/" } }));
    assert.equal((await getCapture(A, c.id))!.verified, false);
  });

  it("expire with retention: gone from reads, then deleted with their blob", async () => {
    const c = signed("https://old.test/", "<p>old</p>");
    await storeCapture(A, c, { via: "fetch", bodyText: "old", retentionDays: 1 });
    await withWorkspaceScope(A, (tx) => (tx as typeof prisma).webCapture.update({ where: { workspaceId_id: { workspaceId: A, id: c.id } }, data: { retentionUntil: new Date(Date.now() - 1000) } }));
    assert.equal(await getCapture(A, c.id), null);
    assert.ok((await purgeExpiredCaptures(A)) >= 1);
    const left = await withWorkspaceScope(A, (tx) => (tx as typeof prisma).webCapture.count({ where: { workspaceId: A, id: c.id } }));
    assert.equal(left, 0);
  });

  it("the workspace's retention setting decides the default lifetime", async () => {
    await saveConfig(B, { captureRetentionDays: 3 }, ["mock"]);
    const c = signed("https://days.test/");
    await storeCapture(B, c, { via: "fetch" });
    const days = Math.round(((await getCapture(B, c.id))!.retentionUntil.getTime() - Date.now()) / 86_400_000);
    assert.equal(days, 3);
  });
});

describe("site capability registry", () => {
  it("records the probe per workspace and counts what worked", async () => {
    const report = detectChannels({ origin: "https://site.test", html: `<form toolname="x" tooldescription="y"><input name="a"></form>`, files: {} });
    await recordProbe(A, report);
    await recordOutcome(A, "https://site.test", "declared-tools", false);
    await recordOutcome(A, "https://site.test", "declared-tools", false);
    await recordOutcome(A, "https://site.test", "structured-data", true, { intent: "opening hours" });
    const cap = (await getSiteCapability(A, "https://site.test"))!;
    assert.deepEqual(cap.declared.tools, [{ source: "webmcp-declarative", name: "x" }]);
    assert.equal(cap.worked["declared-tools"]!.failed, 2);
    assert.equal(cap.worked["structured-data"]!.ok, 1);
    assert.equal(cap.flows[0]!.intent, "opening hours");
    assert.deepEqual(failedChannels(cap), ["declared-tools"]);
  });

  it("is per workspace: B sees nothing of A's site", async () => {
    assert.equal(await getSiteCapability(B, "https://site.test"), null);
    assert.deepEqual(await listSiteCapabilities(B), []);
    await recordOutcome(B, "https://site.test", "a11y-tree", true);
    assert.deepEqual(Object.keys((await getSiteCapability(B, "https://site.test"))!.worked), ["a11y-tree"]);
    assert.equal((await getSiteCapability(A, "https://site.test"))!.worked["a11y-tree"], undefined);
  });
});

describe("settings", () => {
  it("default, then validated saves", async () => {
    assert.deepEqual(await getConfig(`${RUN}-none`), { providerOrder: [], captureRetentionDays: 30, answerCapCredits: 25 });
    const saved = await saveConfig(A, { providerOrder: ["exa", "brave", "exa"], answerCapCredits: 40 }, ["brave", "exa", "mock"]);
    assert.deepEqual(saved.providerOrder, ["exa", "brave"]);
    assert.equal((await getConfig(A)).answerCapCredits, 40);
  });
  it("rejects a cap out of range, an unknown provider and a bad retention", async () => {
    await assert.rejects(() => saveConfig(A, { answerCapCredits: 0 }, ["mock"]), SettingsError);
    await assert.rejects(() => saveConfig(A, { providerOrder: ["bing"] }, ["mock"]), /Unknown search provider: bing/);
    await assert.rejects(() => saveConfig(A, { captureRetentionDays: 0 }, ["mock"]), SettingsError);
  });
});
