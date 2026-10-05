// ShapesOS Phase 11 (seotools): live-URL crawl — status codes, redirects,
// canonical / hreflang / noindex, robots + sitemap, outbound links,
// rendering fallback, SSRF refusal. Fetch is stubbed; no network.
// Run: npx tsx --test lib/audit/__tests__/live.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FetchedPage } from "@/lib/intelligence/fleet/polite-fetch";
import { checkIndexingSignals, crawlSite, crawlKey, LiveAuditError, robotsSitemaps, tagAttributes, type LiveFetcher, type PageRenderer } from "../live";
import { sandboxChromiumRenderer } from "../render-sandbox";
import type { Sandbox, SandboxExecResult } from "@/lib/sandbox/types";

const publicDns = async () => ["93.184.216.34"];

type Stub = { status: number; text?: string; contentType?: string; redirects?: { from: string; to: string; status: number }[]; headers?: Record<string, string> } | "throw";

function stubFetcher(routes: Record<string, Stub>): LiveFetcher & { calls: string[]; delays: Record<string, number> } {
  const calls: string[] = [];
  const delays: Record<string, number> = {};
  return {
    calls,
    delays,
    setCrawlDelay(domain, seconds) {
      delays[domain] = seconds;
    },
    async get(url): Promise<FetchedPage> {
      calls.push(url);
      const r = routes[url];
      if (r === "throw") throw new Error("connect ECONNREFUSED");
      if (!r) return { url, status: 404, text: "not found", contentType: "text/plain", redirects: [], headers: {} };
      const redirects = r.redirects ?? [];
      return {
        url,
        status: r.status,
        text: r.text ?? "",
        contentType: r.contentType ?? "text/html; charset=utf-8",
        redirects,
        finalUrl: redirects.length ? redirects[redirects.length - 1].to : url,
        headers: r.headers ?? {},
      };
    },
  };
}

const page = (title: string, body: string, head = "") =>
  `<!doctype html><html><head><title>${title}</title><meta name="description" content="d"><meta property="og:title" content="t">` +
  `<link rel="canonical" href="https://acme.example${title === "Home" ? "/" : `/${title.toLowerCase()}`}">` +
  `<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"Acme","url":"https://acme.example/"}</script>${head}</head><body>${body}</body></html>`;

describe("pure helpers", () => {
  it("parses tag attributes with quoting styles and entities", () => {
    const attrs = tagAttributes(`<link rel=canonical href='https://a.example/?a=1&amp;b=2'><link REL="alternate" hreflang="en">`, "link");
    assert.deepEqual(attrs, [
      { rel: "canonical", href: "https://a.example/?a=1&b=2" },
      { rel: "alternate", hreflang: "en" },
    ]);
  });

  it("reads Sitemap lines from robots.txt and normalizes crawl keys", () => {
    assert.deepEqual(robotsSitemaps("User-agent: *\nSitemap: https://a.example/s.xml\nsitemap:https://a.example/b.xml"), [
      "https://a.example/s.xml",
      "https://a.example/b.xml",
    ]);
    assert.equal(crawlKey("https://a.example/x?y=1#frag"), "https://a.example/x?y=1");
  });

  it("checks canonical, hreflang and noindex signals", () => {
    const url = "https://acme.example/de";
    const html = `<head>
      <link rel="canonical" href="https://other.example/de"><link rel="canonical" href="/x">
      <link rel="alternate" hreflang="en_US" href="https://acme.example/en">
      <link rel="alternate" hreflang="fr" href="/fr">
      <link rel="alternate" hreflang="es" href="https://acme.example/es"><link rel="alternate" hreflang="es" href="https://acme.example/es2">
      <meta name="robots" content="NOINDEX, follow"></head>`;
    const { findings, canonical } = checkIndexingSignals(url, html);
    const details = findings.map((f) => `${f.category}|${f.detail}`).join("\n");
    assert.equal(canonical, "https://other.example/de");
    assert.match(details, /canonical-issue\|.*declares 2 different canonical/);
    assert.match(details, /canonical-issue\|.*another domain/);
    assert.match(details, /hreflang-issue\|.*invalid hreflang value: "en_US"/);
    assert.match(details, /hreflang-issue\|.*without an absolute URL/);
    assert.match(details, /hreflang-issue\|.*none points back at this page/);
    assert.match(details, /hreflang-issue\|.*maps hreflang es to more than one URL/);
    assert.match(details, /noindex-page\|.*meta robots/);
    assert.ok(findings.every((f) => f.autoFixable === false));
  });

  it("reads noindex from the X-Robots-Tag header and accepts a clean page", () => {
    const clean = `<link rel="canonical" href="https://acme.example/a"><link rel="alternate" hreflang="x-default" href="https://acme.example/a"><link rel="alternate" hreflang="en-GB" href="https://acme.example/a">`;
    assert.deepEqual(checkIndexingSignals("https://acme.example/a", clean).findings, []);
    const hdr = checkIndexingSignals("https://acme.example/a", clean, { "x-robots-tag": "noindex" }).findings;
    assert.equal(hdr[0].category, "noindex-page");
    assert.match(hdr[0].detail, /X-Robots-Tag/);
  });
});

describe("crawlSite", () => {
  const routes: Record<string, Stub> = {
    "https://acme.example/robots.txt": { status: 200, contentType: "text/plain", text: "User-agent: *\nDisallow: /private\nCrawl-delay: 3\nSitemap: https://acme.example/sitemap.xml" },
    "https://acme.example/sitemap.xml": {
      status: 200,
      contentType: "application/xml",
      text: `<urlset><url><loc>https://acme.example/</loc></url><url><loc>https://acme.example/gone</loc></url><url><loc>https://evil.example/x</loc></url></urlset>`,
    },
    "https://acme.example/": {
      status: 200,
      text: page(
        "Home",
        `<a href="/about">About</a><a href="/old">Old</a><a href="/private/x">P</a><a href="/missing">M</a>` +
          `<a href="https://partner.example/ok">ok</a><a href="https://dead.example/x">dead</a><a href="https://down.example/">down</a><a href="https://wall.example/">wall</a>`,
      ),
    },
    "https://acme.example/about": { status: 200, text: page("About", `<img src="x.png"><a href="/">home</a>`, `<meta name="robots" content="noindex">`) },
    "https://acme.example/old": {
      status: 200,
      redirects: [
        { from: "https://acme.example/old", to: "https://acme.example/older", status: 301 },
        { from: "https://acme.example/older", to: "https://acme.example/about", status: 301 },
      ],
      text: page("About", ""),
    },
    "https://acme.example/gone": { status: 410, text: "" },
    "https://acme.example/missing": { status: 404, text: "" },
    "https://partner.example/ok": { status: 200 },
    "https://dead.example/x": { status: 404 },
    "https://down.example/": "throw",
    "https://wall.example/": { status: 403 },
  };

  it("crawls politely and reports live findings", async () => {
    const fetcher = stubFetcher(routes);
    const { findings, crawl } = await crawlSite({ startUrl: "https://acme.example", fetcher, resolve: publicDns });

    assert.ok(!fetcher.calls.includes("https://acme.example/private/x"), "robots.txt Disallow respected");
    assert.ok(!fetcher.calls.some((c) => c.startsWith("https://evil.example")), "off-domain sitemap entries ignored");
    assert.equal(fetcher.delays["acme.example"], 3, "crawl-delay handed to the fetcher");
    assert.equal(crawl.pagesBlockedByRobots, 1);
    assert.equal(crawl.robots.found, true);
    assert.equal(crawl.sitemap.found, true);
    assert.equal(crawl.sitemap.urlCount, 2);
    assert.equal(crawl.rendering, "static");
    assert.equal(crawl.statusCounts["2xx"], 3);
    assert.equal(crawl.statusCounts["4xx"], 2);
    assert.equal(crawl.externalChecked, 4);

    const by = (cat: string) => findings.filter((f) => f.category === cat);
    assert.deepEqual(by("broken-page").map((f) => f.detail), ["https://acme.example/gone returns HTTP 410."]);
    assert.deepEqual(by("broken-internal-link").map((f) => `${f.filePath} ${f.detail}`), [
      "https://acme.example/ Link points to https://acme.example/missing, which returns HTTP 404.",
    ]);
    assert.match(by("redirect-chain")[0].detail, /redirects 2 times .* \(301 → 301\)/);
    assert.equal(by("noindex-page")[0].filePath, "https://acme.example/about");
    assert.equal(by("missing-alt")[0].filePath, "https://acme.example/about");
    const ext = by("broken-external-link").map((f) => f.detail).sort();
    assert.deepEqual(ext, ["Outbound link to https://dead.example/x returns HTTP 404.", "Outbound link to https://down.example/ could not be reached."]);
    assert.ok(!findings.some((f) => f.category === "missing-robots-sitemap"));
    assert.ok(findings.every((f) => f.autoFixable === false), "live findings are never auto-fixable");
  });

  it("respects the page budget and reports truncation", async () => {
    const fetcher = stubFetcher(routes);
    const { crawl } = await crawlSite({ startUrl: "https://acme.example/", fetcher, resolve: publicDns, maxPages: 1, maxExternalChecks: 0 });
    assert.equal(crawl.pagesCrawled, 1);
    assert.equal(crawl.truncated, true);
    assert.equal(crawl.externalChecked, 0);
  });

  it("flags missing robots.txt / sitemap and unreachable start pages", async () => {
    const fetcher = stubFetcher({ "https://bare.example/": "throw" });
    const { findings, crawl } = await crawlSite({ startUrl: "https://bare.example/", fetcher, resolve: publicDns });
    assert.equal(crawl.robots.found, false);
    assert.match(findings.find((f) => f.category === "missing-robots-sitemap")!.detail, /robots\.txt and sitemap\.xml/);
    assert.match(findings.find((f) => f.category === "broken-page")!.detail, /could not be fetched/);
  });

  it("refuses private and malformed start URLs before fetching", async () => {
    const fetcher = stubFetcher({});
    await assert.rejects(crawlSite({ startUrl: "http://127.0.0.1/", fetcher, resolve: publicDns }), LiveAuditError);
    await assert.rejects(crawlSite({ startUrl: "https://intranet.example/", fetcher, resolve: async () => ["10.0.0.4"] }), /disallowed address/);
    await assert.rejects(crawlSite({ startUrl: "ftp://acme.example/", fetcher, resolve: publicDns }), LiveAuditError);
    assert.deepEqual(fetcher.calls, []);
  });

  it("uses the renderer's DOM when it works and labels a fallback when it doesn't", async () => {
    const spa: Record<string, Stub> = {
      "https://spa.example/": { status: 200, text: `<html><head></head><body><div id="root"></div></body></html>` },
    };
    const rendered: PageRenderer = {
      label: "Test renderer",
      render: async () => ({ html: page("Home", "<p>rendered</p>") }),
    };
    const ok = await crawlSite({ startUrl: "https://spa.example/", fetcher: stubFetcher(spa), resolve: publicDns, renderer: rendered });
    assert.equal(ok.crawl.rendering, "js");
    assert.equal(ok.crawl.pages[0].rendered, true);
    assert.ok(!ok.findings.some((f) => f.category === "missing-title"));

    const down: PageRenderer = { label: "Test renderer", render: async () => null };
    const fallback = await crawlSite({ startUrl: "https://spa.example/", fetcher: stubFetcher(spa), resolve: publicDns, renderer: down });
    assert.equal(fallback.crawl.rendering, "static");
    assert.match(fallback.crawl.renderingNote, /unavailable; static HTML was audited instead/);
    assert.ok(fallback.findings.some((f) => f.category === "missing-title"));
  });

  it("does not audit pages that redirect off the site", async () => {
    const fetcher = stubFetcher({
      "https://acme.example/": {
        status: 200,
        redirects: [{ from: "https://acme.example/", to: "https://other.example/", status: 302 }],
        text: "<html><head></head><body><img src=x></body></html>",
      },
    });
    const { findings } = await crawlSite({ startUrl: "https://acme.example/", fetcher, resolve: publicDns });
    assert.ok(!findings.some((f) => f.category === "missing-alt"));
  });
});

describe("sandboxChromiumRenderer", () => {
  function fakeSandbox(handler: (cmd: string | string[]) => Partial<SandboxExecResult>): Sandbox {
    return {
      id: "sb",
      provider: "docker",
      workdir: "/work",
      exec: async (cmd: string | string[]) => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false, durationMs: 1, ...handler(cmd) }),
    } as unknown as Sandbox;
  }

  it("returns null with a reason when the image has no Chromium", async () => {
    const r = sandboxChromiumRenderer(fakeSandbox(() => ({ exitCode: 1 })));
    assert.equal(await r.render("https://a.example/"), null);
    assert.match(r.reason() ?? "", /no headless Chromium/);
  });

  it("dumps the DOM with Chromium when present", async () => {
    const seen: (string | string[])[] = [];
    const r = sandboxChromiumRenderer(
      fakeSandbox((cmd) => {
        seen.push(cmd);
        return typeof cmd === "string" ? { stdout: "/usr/bin/chromium\n" } : { stdout: "<html><body>ok</body></html>" };
      }),
    );
    assert.deepEqual(await r.render("https://a.example/"), { html: "<html><body>ok</body></html>" });
    const call = seen[1] as string[];
    assert.equal(call[0], "/usr/bin/chromium");
    assert.ok(call.includes("--dump-dom") && call.at(-1) === "https://a.example/");
  });
});

describe("PoliteFetcher redirect reporting (Phase 11 extension)", () => {
  it("records each followed hop, the final URL and headers", async () => {
    const { PoliteFetcher } = await import("@/lib/intelligence/fleet/polite-fetch");
    const hops: Record<string, Response> = {
      "https://a.example/old": new Response(null, { status: 301, headers: { location: "/mid" } }),
      "https://a.example/mid": new Response(null, { status: 302, headers: { location: "https://a.example/new" } }),
      "https://a.example/new": new Response("<html>x</html>", { status: 200, headers: { "content-type": "text/html", "X-Robots-Tag": "noindex" } }),
    };
    const f = new PoliteFetcher({ minDelayMs: 0, fetchImpl: (async (u: string) => hops[u]) as unknown as typeof fetch, resolve: publicDns });
    const res = await f.get("https://a.example/old", { maxChars: 3 });
    assert.equal(res.status, 200);
    assert.equal(res.finalUrl, "https://a.example/new");
    assert.deepEqual(res.redirects?.map((h) => h.status), [301, 302]);
    assert.equal(res.headers?.["x-robots-tag"], "noindex");
    assert.equal(res.text, "<ht");
  });
});
