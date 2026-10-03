// Marketr — Phase 10 M4: sitemap parsing + diff tests.
// Run: npx tsx --test lib/intelligence/fleet/__tests__/sitemap.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchSitemapEntries, parseSitemapXml } from "../sitemap";
import { diffSitemap } from "../discovery";
import { isOnWatchedDomain } from "../polite-fetch";

describe("fetchSitemapEntries allowUrl gate (H8)", () => {
  it("never fetches or returns off-domain child sitemaps and <loc> URLs", async () => {
    const fetched: string[] = [];
    const pages: Record<string, string> = {
      "https://comp.example/sitemap.xml": `<sitemapindex>
        <sitemap><loc>https://comp.example/pages.xml</loc></sitemap>
        <sitemap><loc>http://169.254.169.254/latest/meta-data/</loc></sitemap>
      </sitemapindex>`,
      "https://comp.example/pages.xml": `<urlset>
        <url><loc>https://comp.example/ok</loc></url>
        <url><loc>http://10.0.0.5/admin</loc></url>
        <url><loc>https://evil.test/x</loc></url>
      </urlset>`,
    };
    const entries = await fetchSitemapEntries(
      "https://comp.example/sitemap.xml",
      async (u) => {
        fetched.push(u);
        return { status: pages[u] ? 200 : 404, text: pages[u] ?? "" };
      },
      { allowUrl: (u) => isOnWatchedDomain(u, "comp.example") },
    );
    assert.deepEqual(entries.map((e) => e.url), ["https://comp.example/ok"]);
    assert.deepEqual(fetched, ["https://comp.example/sitemap.xml", "https://comp.example/pages.xml"]);
  });
});

const URLSET_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://comp.example/pricing</loc><lastmod>2026-09-20T10:00:00Z</lastmod></url>
  <url><loc>https://comp.example/blog/new-post?ref=home&amp;x=1</loc><lastmod>2026-09-25</lastmod></url>
  <url><loc>https://comp.example/about</loc></url>
  <url></url>
</urlset>`;

const INDEX_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://comp.example/sitemap-pages.xml</loc></sitemap>
  <sitemap><loc>https://comp.example/sitemap-blog.xml</loc></sitemap>
</sitemapindex>`;

const CHILD_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://comp.example/from-child</loc></url>
</urlset>`;

describe("parseSitemapXml", () => {
  it("extracts loc + lastmod, decodes entities, skips empty locs", () => {
    const entries = parseSitemapXml(URLSET_FIXTURE);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].url, "https://comp.example/pricing");
    assert.equal(entries[0].lastmod, "2026-09-20T10:00:00Z");
    // &amp; decoded inside the URL
    assert.equal(entries[1].url, "https://comp.example/blog/new-post?ref=home&x=1");
    assert.equal(entries[1].lastmod, "2026-09-25");
    assert.equal(entries[2].url, "https://comp.example/about");
    assert.equal(entries[2].lastmod, undefined);
  });

  it("returns [] on non-sitemap junk", () => {
    assert.deepEqual(parseSitemapXml("<html>nope</html>"), []);
    assert.deepEqual(parseSitemapXml(""), []);
  });
});

describe("fetchSitemapEntries (index recursion)", () => {
  it("follows sitemapindex children and dedupes", async () => {
    const pages: Record<string, string> = {
      "https://comp.example/sitemap.xml": INDEX_FIXTURE,
      "https://comp.example/sitemap-pages.xml": URLSET_FIXTURE,
      "https://comp.example/sitemap-blog.xml": CHILD_FIXTURE,
    };
    const entries = await fetchSitemapEntries(
      "https://comp.example/sitemap.xml",
      async (url) => ({ status: 200, text: pages[url] ?? "" }),
    );
    const urls = entries.map((e) => e.url);
    assert.ok(urls.includes("https://comp.example/pricing"));
    assert.ok(urls.includes("https://comp.example/from-child"));
    assert.equal(urls.length, new Set(urls).size, "no duplicate URLs");
  });

  it("never throws on unreachable sitemaps — returns what it got", async () => {
    const entries = await fetchSitemapEntries("https://comp.example/sitemap.xml", async () => {
      throw new Error("boom");
    });
    assert.deepEqual(entries, []);
  });
});

describe("diffSitemap", () => {
  const lastDiffAt = new Date("2026-09-22T00:00:00Z");
  const prevSeen = new Set(["https://comp.example/pricing", "https://comp.example/old"]);

  it("flags added / removed / lastmod-updated URLs", () => {
    const entries = parseSitemapXml(URLSET_FIXTURE);
    const diff = diffSitemap(entries, prevSeen, lastDiffAt);
    // /pricing has lastmod 2026-09-20 < lastDiffAt 2026-09-22 → NOT updated
    assert.deepEqual(diff.added.map((e) => e.url).sort(), [
      "https://comp.example/about",
      "https://comp.example/blog/new-post?ref=home&x=1",
    ]);
    assert.deepEqual(diff.removed, ["https://comp.example/old"]);
    assert.deepEqual(diff.updated, []);
    assert.equal(diff.totalSeen, 3);
  });

  it("flags a known URL whose lastmod is newer than the last diff run", () => {
    const diff = diffSitemap(
      [{ url: "https://comp.example/pricing", lastmod: "2026-09-24T10:00:00Z" }],
      prevSeen,
      lastDiffAt,
    );
    assert.equal(diff.added.length, 0);
    assert.deepEqual(diff.updated.map((e) => e.url), ["https://comp.example/pricing"]);
  });

  it("first run: everything is added, nothing removed", () => {
    const diff = diffSitemap(parseSitemapXml(URLSET_FIXTURE), new Set(), null);
    assert.equal(diff.added.length, 3);
    assert.equal(diff.removed.length, 0);
    assert.equal(diff.updated.length, 0);
  });

  it("dedupes duplicate locs inside one sitemap", () => {
    const diff = diffSitemap(
      [
        { url: "https://comp.example/a" },
        { url: "https://comp.example/a", lastmod: "2026-09-24" },
      ],
      new Set(),
      null,
    );
    assert.equal(diff.added.length, 1);
    assert.equal(diff.totalSeen, 1);
  });
});
