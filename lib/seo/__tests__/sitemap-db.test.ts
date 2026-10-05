// ShapesOS Phase 11 (seotools): SiteBuilder sitemaps against Postgres (as
// the app role):
//   1. refreshSiteSitemap writes sitemap.xml (absolute URLs from the newest
//      real deployment), the robots.txt Sitemap line and the IndexNow key
//      file; a hand-written sitemap is kept; no origin → nothing written.
//   2. Applying a draft rebuilds the sitemap for the applied pages.
//   3. submitSiteSitemap records every attempt with its real status
//      (stubbed HTTP — labelled mock); RLS: no GUC → zero rows, another
//      workspace sees none.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… npx tsx --test lib/seo/__tests__/sitemap-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { prisma } from "@/lib/prisma";
import { countWithoutScope } from "@/lib/substrate/memory/rls";
import { readSiteWorkingCopy, writeSiteWorkingCopy } from "@/lib/sites/files";
import { createSiteRevision } from "@/lib/sites/revisions";
import { applySiteRevision } from "@/lib/sites/apply";
import { indexNowKey, refreshSiteSitemap, SHAPES_SITEMAP_MARKER } from "../sitemap";
import { listSitemapSubmissions, submitSiteSitemap, SitemapSubmitError } from "../sitemap-submit";

const RUN = `p11s-${Date.now().toString(36)}`;
const WS_A = `${RUN}-a`;
const WS_B = `${RUN}-b`;
const USER = `${RUN}-user`;
const SECRET = "test-secret";
let projectId = "";
let siteId = "";
const storage = mkdtempSync(path.join(tmpdir(), "shapes-sitemap-"));
const savedStorage = process.env.SITE_STORAGE_DIR;
const savedKey = process.env.MARKETR_CREDENTIALS_KEY;
const publicDns = async () => ["93.184.216.34"];

const PAGES = [
  { path: "/index.html", content: "<h1>Home</h1>" },
  { path: "/pricing.html", content: "<h1>Pricing</h1>" },
  { path: "/thanks.html", content: '<meta name="robots" content="noindex"><h1>Thanks</h1>' },
];

const read = async () => new Map((await readSiteWorkingCopy(siteId)).files.map((f) => [f.path, f.content]));

before(async () => {
  process.env.SITE_STORAGE_DIR = storage;
  process.env.MARKETR_CREDENTIALS_KEY = SECRET;
  for (const id of [WS_A, WS_B]) await prisma.workspace.create({ data: { id, name: id, ownerUserId: USER } });
  projectId = (await prisma.project.create({ data: { workspaceId: WS_A, domain: "" } })).id;
  siteId = (await prisma.site.create({ data: { projectId, name: "Sitemap site", sourceType: "file", configEnc: "" } })).id;
  await writeSiteWorkingCopy(siteId, PAGES);
});

after(async () => {
  for (const id of [WS_A, WS_B]) await prisma.workspace.deleteMany({ where: { id } });
  await fs.rm(storage, { recursive: true, force: true });
  if (savedStorage === undefined) delete process.env.SITE_STORAGE_DIR;
  else process.env.SITE_STORAGE_DIR = savedStorage;
  if (savedKey === undefined) delete process.env.MARKETR_CREDENTIALS_KEY;
  else process.env.MARKETR_CREDENTIALS_KEY = savedKey;
});

describe("site sitemaps", () => {
  it("writes nothing while the site has no live URL", async () => {
    const r = await refreshSiteSitemap({ siteId, projectId });
    assert.equal(r.skipped, "no_origin");
    assert.deepEqual(r.written, []);
    await assert.rejects(submitSiteSitemap({ workspaceId: WS_A, projectId, siteId }), (e: unknown) => e instanceof SitemapSubmitError && e.code === "no_origin");
  });

  it("builds sitemap.xml, robots.txt and the IndexNow key from the live deployment", async () => {
    await prisma.deployment.create({ data: { siteId, projectId, target: "netlify", url: "https://sitemap-site.netlify.app", status: "ready" } });
    const r = await refreshSiteSitemap({ siteId, projectId });
    const key = indexNowKey(siteId, SECRET);
    assert.equal(r.sitemapUrl, "https://sitemap-site.netlify.app/sitemap.xml");
    assert.equal(r.urlCount, 2);
    assert.deepEqual(r.written.sort(), ["/robots.txt", "/sitemap.xml", `/${key}.txt`].sort());
    const files = await read();
    assert.match(files.get("/sitemap.xml")!, /<loc>https:\/\/sitemap-site.netlify.app\/<\/loc>[\s\S]*<loc>https:\/\/sitemap-site.netlify.app\/pricing<\/loc>/);
    assert.doesNotMatch(files.get("/sitemap.xml")!, /thanks/);
    assert.match(files.get("/robots.txt")!, /Sitemap: https:\/\/sitemap-site.netlify.app\/sitemap.xml/);
    assert.equal(files.get(`/${key}.txt`), key);
    // Second run: nothing changes.
    assert.deepEqual((await refreshSiteSitemap({ siteId, projectId })).written, []);
    const log = await prisma.fileChangeLog.findFirst({ where: { siteId, actor: "system" } });
    assert.match(log?.summary ?? "", /Rebuilt/);
  });

  it("rebuilds when a person applies a draft", async () => {
    const current = (await readSiteWorkingCopy(siteId)).files;
    const draft = await createSiteRevision({
      workspaceId: WS_A,
      siteId,
      status: "draft",
      source: "agent",
      files: [...current.filter((f) => f.path !== "/sitemap.xml"), { path: "/features.html", content: "<h1>Features</h1>" }],
    });
    await applySiteRevision({ workspaceId: WS_A, projectId, siteId, revisionId: draft.id, userId: USER, force: true });
    const files = await read();
    assert.match(files.get("/sitemap.xml") ?? "", /\/features<\/loc>/);
    assert.ok(files.get("/sitemap.xml")!.includes(SHAPES_SITEMAP_MARKER));
  });

  it("never overwrites a hand-written sitemap", async () => {
    const mine = '<?xml version="1.0"?><urlset><url><loc>https://sitemap-site.netlify.app/custom</loc></url></urlset>';
    await writeSiteWorkingCopy(siteId, [...(await readSiteWorkingCopy(siteId)).files.filter((f) => f.path !== "/sitemap.xml"), { path: "/sitemap.xml", content: mine }]);
    const r = await refreshSiteSitemap({ siteId, projectId });
    assert.equal(r.skipped, "user_managed");
    assert.equal((await read()).get("/sitemap.xml"), mine);
  });

  it("records submissions with their real status, isolated per workspace", async () => {
    const indexNowOk = (async () => new Response("", { status: 202 })) as unknown as typeof fetch;
    const out = await submitSiteSitemap(
      { workspaceId: WS_A, projectId, siteId, submittedBy: USER },
      { fetchImpl: indexNowOk, resolve: publicDns }, // GSC uses the real vault lookup: nothing is connected
    );
    assert.equal(out.sitemapUrl, "https://sitemap-site.netlify.app/sitemap.xml");
    assert.equal(out.urlCount, 3);
    assert.deepEqual(out.results.map((r) => [r.target, r.status]), [
      ["gsc", "not_connected"],
      ["indexnow", "submitted"],
    ]);
    const rows = await listSitemapSubmissions(WS_A, siteId);
    assert.deepEqual(rows.map((r) => r.status).sort(), ["not_connected", "submitted"]);
    assert.ok(rows.every((r) => r.submittedBy === USER && r.urlCount === 3));
    assert.equal((await listSitemapSubmissions(WS_B, siteId)).length, 0, "another workspace sees none");
    assert.equal(await countWithoutScope("site_sitemap_submissions"), 0, "no GUC → zero rows");
  });
});
