// ShapesOS Phase 11 (seotools): files-mode site audit — scanner checks,
// category registry, fix planning and fix eligibility. No network, no DB.
// Run: npx tsx --test lib/audit/__tests__/scanner.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { LlmProvider } from "@/lib/llm/types";
import { checkHtmlPage, pageContext, scanSite } from "../scanner";
import { CATEGORY_MAP, DEFAULT_ALLOWED_CATEGORIES, ISSUE_CATEGORIES } from "../categories";
import { planFix } from "../fixer";
import { isIssueEligible } from "../runner";
import { mockScanFindings } from "../mock";
import { checkStructuredData, extractJsonLdBlocks } from "../structured-data";
import { memoryProvider } from "./memory-provider";

const GOOD_PAGE = `<!doctype html><html><head>
<title>Acme plumbing</title>
<meta name="description" content="Plumbers in Austin">
<meta property="og:title" content="Acme">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme","url":"https://acme.example"}</script>
</head><body><h1>Acme</h1><img src="/a.png" alt="A"><a href="/about.html">About</a></body></html>`;

const BAD_PAGE = `<html><head></head><body>
<h1>About us</h1>
<img src="/team.jpg">
<script src="http://cdn.example.com/x.js"></script>
<a href="/missing">gone</a>
<a href="https://elsewhere.example/">external</a>
</body></html>`;

describe("checkHtmlPage", () => {
  it("finds nothing on a complete page", () => {
    assert.deepEqual(checkHtmlPage("/index.html", GOOD_PAGE), []);
  });

  it("flags title, description, OG, alt and mixed content with lines", () => {
    const cats = checkHtmlPage("/about.html", BAD_PAGE).map((f) => `${f.category}:${f.line}`);
    assert.deepEqual(cats.sort(), ["missing-alt:3", "missing-meta-description:1", "missing-og-tags:1", "missing-title:1", "mixed-content:4"].sort());
  });

  it("flags inline style bloat over 4KB", () => {
    const html = `<head><title>x</title></head><style>${"a{color:red}".repeat(400)}</style>`;
    assert.ok(checkHtmlPage("/s.html", html).some((f) => f.category === "inline-style-bloat"));
  });
});

describe("scanSite (files mode)", () => {
  it("runs every check over the working copy", async () => {
    const provider = memoryProvider({
      "/index.html": GOOD_PAGE,
      "/about.html": BAD_PAGE,
      "/img/huge.png": { size: 600 * 1024 },
      "/docs/index.html": GOOD_PAGE.replace("/about.html", "/docs"),
    });
    const findings = await scanSite(provider);
    const cats = new Set(findings.map((f) => f.category));
    for (const c of ["missing-title", "missing-alt", "mixed-content", "broken-internal-link", "oversized-image", "missing-robots-sitemap", "missing-structured-data"]) {
      assert.ok(cats.has(c), `expected ${c}`);
    }
    const broken = findings.filter((f) => f.category === "broken-internal-link");
    assert.deepEqual(broken.map((b) => b.detail), ["Link points to /missing, which doesn't exist in the site."]);
    // /docs resolves through its index.html; the external link is out of scope.
    assert.ok(!findings.some((f) => /\/docs|elsewhere/.test(f.detail) && f.category === "broken-internal-link"));
    for (const f of findings) assert.ok(CATEGORY_MAP[f.category], `unregistered category ${f.category}`);
  });

  it("does not flag robots/sitemap when both exist and skips unreadable files", async () => {
    const provider = memoryProvider({ "/index.html": GOOD_PAGE, "/about.html": GOOD_PAGE, "/robots.txt": "User-agent: *", "/sitemap.xml": "<urlset/>", "/bin.html": { size: 10 } });
    const findings = await scanSite(provider);
    assert.deepEqual(findings, []);
  });

  it("returns nothing when the tree can't be listed", async () => {
    const provider = memoryProvider({});
    provider.listDir = async () => {
      throw new Error("offline");
    };
    assert.deepEqual(await scanSite(provider), []);
  });

  it("pageContext pulls title, h1 and text", () => {
    const ctx = pageContext(GOOD_PAGE);
    assert.equal(ctx.h1, "Acme");
    assert.match(ctx.text, /Acme/);
  });
});

describe("structured data check", () => {
  it("extracts JSON-LD blocks with lines", () => {
    const blocks = extractJsonLdBlocks(`<p>\n<script type='application/ld+json'>\n{"a":1}\n</script>`);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].line, 2);
  });

  it("reports missing and unparseable JSON-LD", () => {
    assert.equal(checkStructuredData("/x", "<html></html>")[0].category, "missing-structured-data");
    const bad = checkStructuredData("/x", `<script type="application/ld+json">{"@type": }</script>`);
    assert.equal(bad[0].category, "invalid-structured-data");
  });
});

describe("categories and eligibility", () => {
  it("every category has a unique key and manual ones are never default-allowed", () => {
    assert.equal(new Set(ISSUE_CATEGORIES.map((c) => c.key)).size, ISSUE_CATEGORIES.length);
    for (const c of ISSUE_CATEGORIES) {
      if (c.fixStrategy === "manual") assert.ok(!DEFAULT_ALLOWED_CATEGORIES.includes(c.key), c.key);
    }
  });

  it("mock findings only use registered categories", () => {
    for (const f of mockScanFindings("Demo")) assert.ok(CATEGORY_MAP[f.category]);
  });

  it("applies the trust ladder", () => {
    const settings = { enabled: true, allowedCategories: ["missing-og-tags"] };
    const issue = { status: "open", category: "missing-og-tags", autoFixable: true, destructive: false };
    assert.equal(isIssueEligible(issue, settings), true);
    assert.equal(isIssueEligible(issue, { ...settings, enabled: false }), false);
    assert.equal(isIssueEligible({ ...issue, category: "missing-alt" }, settings), false);
    assert.equal(isIssueEligible({ ...issue, category: "missing-alt", status: "approved" }, settings), true);
    assert.equal(isIssueEligible({ ...issue, destructive: true }, settings), false);
    assert.equal(isIssueEligible({ ...issue, autoFixable: false, status: "approved" }, settings), false);
  });

  it("never lets the fix agent touch a live (URL) finding", () => {
    const settings = { enabled: true, allowedCategories: ["missing-og-tags"] };
    assert.equal(
      isIssueEligible({ status: "approved", category: "missing-og-tags", autoFixable: true, destructive: false, filePath: "https://acme.example/about" }, settings),
      false,
    );
  });
});

describe("planFix", () => {
  const offline: LlmProvider = {
    name: "mock",
    isLive: false,
    isConfigured: () => false,
    generate: async () => {
      throw new Error("offline");
    },
  } as unknown as LlmProvider;
  const live = (reply: string): LlmProvider =>
    ({ name: "test", isLive: true, isConfigured: () => true, generate: async () => reply }) as unknown as LlmProvider;

  it("inserts a title from the h1 when the LLM is offline", async () => {
    const plan = await planFix("missing-title", "/about.html", BAD_PAGE, offline);
    assert.match(plan.newContent ?? "", /<title>About us<\/title>\n<\/head>/);
    assert.match(plan.preview, /^\+ .*<title>About us<\/title>/m);
    assert.match(plan.preview, /^- <html><head><\/head>/m);
  });

  it("uses (and escapes) the LLM's description", async () => {
    const plan = await planFix("missing-meta-description", "/a.html", BAD_PAGE, live('Great "plumbers"\nignored'));
    assert.match(plan.newContent ?? "", /content="Great &quot;plumbers&quot;"/);
  });

  it("rewrites mixed content and adds OG tags deterministically", async () => {
    const mixed = await planFix("mixed-content", "/a.html", BAD_PAGE, offline);
    assert.match(mixed.newContent ?? "", /src="https:\/\/cdn.example.com\/x.js"/);
    const og = await planFix("missing-og-tags", "/i.html", GOOD_PAGE, offline);
    assert.match(og.newContent ?? "", /og:description" content="Plumbers in Austin"/);
  });

  it("adds alt text to every image without one", async () => {
    const plan = await planFix("missing-alt", "/a.html", `<head></head><img src="/x/team-photo.jpg"><img src="/x/team-photo.jpg">`, offline);
    assert.equal((plan.newContent ?? "").match(/alt="team photo"/g)?.length, 2);
  });

  it("creates robots.txt and sitemap.xml", async () => {
    const plan = await planFix("missing-robots-sitemap", "/", null, offline, ["/index.html", "/a.css"]);
    assert.equal(plan.newContent, null);
    assert.match(plan.extraFiles["/robots.txt"], /Sitemap:/);
    assert.match(plan.extraFiles["/sitemap.xml"], /<loc>\/index.html<\/loc>/);
    assert.doesNotMatch(plan.extraFiles["/sitemap.xml"], /a\.css/);
  });

  it("refuses manual and unknown categories", async () => {
    await assert.rejects(planFix("broken-internal-link", "/a.html", "", offline), /human decision/);
    await assert.rejects(planFix("canonical-issue", "/a.html", "", offline), /human decision/);
    await assert.rejects(planFix("nope", "/a.html", "", offline), /Unknown issue category/);
  });
});
