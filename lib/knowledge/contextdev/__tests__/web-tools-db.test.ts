// ShapesOS Phase 11 (seotools): web_scrape / web_crawl against Postgres (as
// the app role) with the Context.dev HTTP API stubbed (labelled mock — live
// Context.dev calls are UNVERIFIED-LIVE): vault key lookup, the daily credit
// budget (charged per call, over-budget → approval, nothing fetched), SSRF
// refusal before the vendor is asked, sitemap filtering, vendor errors.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… MARKETR_CREDENTIALS_KEY=… npx tsx --test lib/knowledge/contextdev/__tests__/web-tools-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import type { ToolContext } from "@/lib/chat/tools";
import { toolAction, toolGroup } from "@/lib/chat/tools";
import { evaluateTier } from "@/lib/orchestrator/authority";
import { storeContextDevKey } from "../keys";
import { getDailyBudget, setDailyCap } from "../budget-store";
import { setWebToolDepsForTests, web_crawl, web_scrape } from "../web-tools";

const RUN = `p11w-${Date.now().toString(36)}`;
const WS = `${RUN}-ws`;
const WS_NOKEY = `${RUN}-nokey`;
const USER = `${RUN}-user`;
const calls: string[] = [];

const ctx = (workspaceId = WS): ToolContext => ({ projectId: "p", workspaceId, userId: USER, role: "editor", confirmed: true });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

before(async () => {
  for (const id of [WS, WS_NOKEY]) await prisma.workspace.create({ data: { id, name: id, ownerUserId: USER } });
  await storeContextDevKey(USER, WS, "cd-test-key");
  await setDailyCap(WS, 8);
  setWebToolDepsForTests({
    resolve: async (host) => (host.endsWith(".internal.example") ? ["10.1.2.3"] : ["93.184.216.34"]),
    fetchImpl: async (input) => {
      const u = new URL(input);
      calls.push(`${u.pathname}?${u.searchParams.get("url") ?? u.searchParams.get("domain")}`);
      if (u.pathname === "/v1/web/scrape/sitemap") {
        return json({
          urls: [
            "https://acme.example/blog/one",
            "https://acme.example/pricing",
            "https://acme.example/blog/two",
            "https://evil.example/blog/x",
            "https://acme.example/blog/one#dup",
            "https://acme.example/blog/three",
          ],
        });
      }
      const target = u.searchParams.get("url") ?? "";
      if (target.includes("/broken")) return json({ error: "x" }, 500);
      return json({ markdown: `# Page ${target}\n\nBody of ${target}`, metadata: { title: `T ${new URL(target).pathname}` } });
    },
  });
});

after(async () => {
  setWebToolDepsForTests(null);
  for (const id of [WS, WS_NOKEY]) await prisma.workspace.deleteMany({ where: { id } });
});

describe("web tools", () => {
  it("are web-group, Tier-0 metered reads", () => {
    for (const name of ["web_scrape", "web_crawl"]) {
      assert.equal(toolGroup(name), "web");
      assert.equal(evaluateTier({ kind: toolAction(name) }, { smallActionThresholdCents: 0 } as never), 0);
    }
  });

  it("say 'not connected' without a key and never fake a page", async () => {
    const r = await web_scrape.execute(ctx(WS_NOKEY), { url: "https://acme.example/" });
    assert.match(r.summary, /isn't connected/);
    assert.deepEqual(calls, []);
  });

  it("refuse internal targets before the vendor is asked", async () => {
    for (const url of ["http://127.0.0.1/admin", "https://db.internal.example/", "ftp://acme.example/"]) {
      const r = await web_scrape.execute(ctx(), { url });
      assert.match(r.summary, /Can't fetch that URL/, url);
    }
    assert.match((await web_crawl.execute(ctx(), { url: "169.254.169.254" })).summary, /Can't crawl that URL/);
    assert.deepEqual(calls, []);
  });

  it("web_scrape returns markdown and charges 1 credit", async () => {
    const before = (await getDailyBudget(WS)).usedToday;
    const r = await web_scrape.execute(ctx(), { url: "acme.example/pricing" });
    assert.match(r.summary, /^T \/pricing — https:\/\/acme.example\/pricing\n\n# Page https:\/\/acme.example\/pricing/);
    assert.deepEqual(calls.splice(0), ["/v1/web/scrape/markdown?https://acme.example/pricing"]);
    assert.equal((await getDailyBudget(WS)).usedToday, before + 1);
  });

  it("web_crawl stays on the site, under the prefix, within the page budget", async () => {
    const before = (await getDailyBudget(WS)).usedToday;
    const r = await web_crawl.execute(ctx(), { url: "https://acme.example", pathPrefix: "/blog/", maxPages: 2 });
    const d = r.details as { pages: { url: string }[]; credits: number; discovered: number };
    assert.deepEqual(d.pages.map((p) => p.url), ["https://acme.example/blog/one", "https://acme.example/blog/two"]);
    assert.equal(d.credits, 3);
    assert.equal(d.discovered, 6);
    assert.ok(!calls.some((c) => c.includes("evil.example")));
    assert.match(r.summary, /Read 2 of 2 pages from acme.example \(3 credits\)/);
    assert.equal((await getDailyBudget(WS)).usedToday, before + 3);
    calls.splice(0);
  });

  it("over budget → approval, and the pages are not fetched", async () => {
    // 1 + 3 used so far of 8: a 5-page crawl (1 + 5) doesn't fit.
    const r = await web_crawl.execute(ctx(), { url: "https://acme.example", maxPages: 5 });
    assert.match(r.summary, /^Not fetched: .*approval required/);
    assert.equal((r.details as { needsApproval: boolean }).needsApproval, true);
    assert.ok(!calls.some((c) => c.startsWith("/v1/web/scrape/markdown")));
    calls.splice(0);
  });

  it("reports vendor errors instead of content", async () => {
    await setDailyCap(WS, 100);
    const r = await web_scrape.execute(ctx(), { url: "https://acme.example/broken" });
    assert.match(r.summary, /couldn't fetch .* \(UPSTREAM_ERROR\)/);
  });
});
