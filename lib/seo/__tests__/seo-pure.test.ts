// ShapesOS Phase 11 (seotools): pure SEO helpers — cost gates (backlinks,
// local), autopilot validation/dedupe/markdown, internal-link graph and
// suggestions, programmatic publish classification and payload builders.
// Run: npx tsx --test lib/seo/__tests__/seo-pure.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkPullBudget,
  estimateListPullCost,
  MAX_BACKLINK_ROWS_PER_PULL,
  monthKey,
} from "../backlinks-cost";
import { checkLocalBudget, estimateGridRunCost, MAX_GRID_CELLS_PER_RUN, LOCAL_PRICING } from "../local-cost";
import {
  capCandidates,
  clampMaxItemsPerRun,
  dedupeCandidates,
  isAutoApproveEligible,
  isKilledForProject,
  markdownToSimpleBlocks,
  MAX_ITEMS_PER_RUN_HARD_CAP,
  scopeKeyFor,
  validatePublishTarget,
  validateRuleInput,
  type AutopilotCandidate,
} from "../autopilot";
import {
  buildLinkGraph,
  contentTokens,
  extractInternalHrefs,
  MAX_SUGGESTIONS,
  normalizeInternalUrl,
  suggestInternalLinks,
} from "../internal-links";
import {
  buildHeadMeta,
  buildSiteHtml,
  classifyPush,
  resolveDestination,
  siteFilePathForUrl,
} from "../programmatic-publish";

describe("backlink cost gate", () => {
  it("estimates request + per-row cost and clamps rows", () => {
    assert.equal(estimateListPullCost(1000), 0.06);
    assert.equal(estimateListPullCost(Number.NaN), 0.024);
    assert.equal(estimateListPullCost(10 ** 9), estimateListPullCost(MAX_BACKLINK_ROWS_PER_PULL));
  });

  it("fails closed on bad numbers, row cap and budget", () => {
    assert.equal(checkPullBudget(Number.NaN, 0, 25).ok, false);
    assert.equal(checkPullBudget(100, -1, 25).ok, false);
    assert.equal(checkPullBudget(100, 0, Number.POSITIVE_INFINITY).ok, false);
    assert.match(checkPullBudget(MAX_BACKLINK_ROWS_PER_PULL + 1, 0, 25).blockedReason ?? "", /per-pull limit/);
    assert.match(checkPullBudget(1000, 24.99, 25).blockedReason ?? "", /exceed/);
    const ok = checkPullBudget(1000, 0, 25);
    assert.equal(ok.ok, true);
    assert.ok(Math.abs(ok.estimatedCostUsd - 0.084) < 1e-9);
  });

  it("monthKey is YYYY-MM", () => {
    assert.equal(monthKey(new Date("2026-10-04T12:00:00Z")), "2026-10");
  });
});

describe("local SEO cost gate", () => {
  it("prices grid cells with a hard cap", () => {
    assert.equal(estimateGridRunCost(4), Math.round(4 * LOCAL_PRICING.mapsSerpRequestUsd * 10_000) / 10_000);
    assert.equal(estimateGridRunCost(10_000), estimateGridRunCost(MAX_GRID_CELLS_PER_RUN));
  });

  it("blocks NaN and over-budget operations", () => {
    assert.equal(checkLocalBudget(Number.NaN, 0, 10).ok, false);
    assert.equal(checkLocalBudget(1, 0, Number.NaN).ok, false);
    assert.equal(checkLocalBudget(6, 5, 10).ok, false);
    assert.equal(checkLocalBudget(5, 5, 10).ok, true);
  });
});

describe("autopilot rules", () => {
  it("clamps items per run", () => {
    assert.equal(clampMaxItemsPerRun(0), 1);
    assert.equal(clampMaxItemsPerRun("x"), 5);
    assert.equal(clampMaxItemsPerRun(10_000), MAX_ITEMS_PER_RUN_HARD_CAP);
  });

  it("validates rule input and publish targets", () => {
    assert.throws(() => validateRuleInput({ name: " ", source: "decay_refresh" }), /name/);
    assert.throws(() => validateRuleInput({ name: "x", source: "nope" }), /source/);
    assert.throws(() => validateRuleInput({ name: "x", source: "programmatic_template" }), /programmaticTemplateId/);
    const r = validateRuleInput({ name: " Weekly ", source: "decay_refresh", cadence: "hourly", autoApprove: "yes" });
    assert.equal(r.name, "Weekly");
    assert.equal(r.cadence, "manual");
    assert.equal(r.autoApprove, false);
    assert.equal(r.enabled, true);
    assert.throws(() => validatePublishTarget({ kind: "ftp" }), /publishTarget.kind/);
    assert.deepEqual(validatePublishTarget({ kind: "wordpress", siteId: " s1 ", connectionId: "" }), {
      kind: "wordpress",
      siteId: "s1",
      connectionId: null,
      webflowCollectionId: null,
    });
  });

  it("dedupes in-flight candidates and caps by priority", () => {
    const c = (sourceRef: string, priority: number): AutopilotCandidate => ({
      kind: "decay_refresh",
      sourceRef,
      title: sourceRef,
      priority,
      brief: "",
    });
    const deduped = dedupeCandidates([c("a", 3), c("b", 1), c("c", 2)], [
      { kind: "decay_refresh", sourceRef: "a", status: "pending" },
      { kind: "decay_refresh", sourceRef: "c", status: "rejected" },
    ]);
    assert.deepEqual(deduped.map((x) => x.sourceRef), ["b", "c"]);
    assert.deepEqual(capCandidates([c("a", 3), c("b", 1), c("c", 2)], 2).map((x) => x.sourceRef), ["b", "c"]);
  });

  it("only decay refreshes can auto-approve; kill scope is exclusive", () => {
    assert.equal(isAutoApproveEligible("decay_refresh", true), true);
    assert.equal(isAutoApproveEligible("programmatic_page", true), false);
    assert.equal(scopeKeyFor({ workspaceId: "w" }), "workspace:w");
    assert.throws(() => scopeKeyFor({ workspaceId: "w", projectId: "p" }));
    assert.throws(() => scopeKeyFor({}));
    assert.equal(isKilledForProject([{ scopeKey: "workspace:w", killed: true }], "w", "p"), true);
    assert.equal(isKilledForProject([{ scopeKey: "project:other", killed: true }], "w", "p"), false);
  });

  it("converts draft markdown to simple blocks", () => {
    const blocks = markdownToSimpleBlocks("# Title\n\nLine one\nline two\n\n- a\n* b\n\n## Sub\n### Deep\ntext");
    assert.deepEqual(blocks, [
      { type: "h1", text: "Title" },
      { type: "paragraph", text: "Line one line two" },
      { type: "bullet", text: "a" },
      { type: "bullet", text: "b" },
      { type: "h2", text: "Sub" },
      { type: "h3", text: "Deep" },
      { type: "paragraph", text: "text" },
    ]);
  });
});

describe("internal links", () => {
  it("normalizes URLs for graph identity", () => {
    assert.equal(normalizeInternalUrl("https://WWW.Acme.com/Blog/?x=1#y"), "acme.com/blog");
    assert.equal(normalizeInternalUrl("/About/"), "/about");
    assert.equal(normalizeInternalUrl("https://acme.com"), "acme.com/");
  });

  it("tokenizes with stopwords and naive singulars", () => {
    assert.deepEqual([...contentTokens("The best plumbers in Austin, how to guide")], ["best", "plumber", "austin"]);
  });

  it("builds a graph that ignores self-links and external edges", () => {
    const g = buildLinkGraph(
      [
        { url: "https://a.com/x", title: "X", targetKeywords: [], bestRank: null },
        { url: "https://a.com/y", title: "Y", targetKeywords: [], bestRank: null },
      ] as never,
      [
        { from: "https://a.com/x", to: "https://a.com/y" },
        { from: "https://a.com/x", to: "https://a.com/x" },
        { from: "https://a.com/x", to: "https://other.com/z" },
      ],
    );
    assert.equal(g.inbound.get("a.com/y")!.size, 1);
    assert.equal(g.outbound.get("a.com/x")!.size, 1);
  });

  it("suggests high-value and keyword-relevant links, one card per pair", () => {
    const pages = [
      { url: "https://a.com/plumbing-austin", title: "Emergency plumbing Austin", targetKeywords: ["emergency plumbing austin"], bestRank: 4 },
      { url: "https://a.com/blog/burst-pipes", title: "Burst pipes emergency plumbing", targetKeywords: ["burst pipe emergency"], bestRank: null },
      { url: "https://a.com/about", title: "About us", targetKeywords: [], bestRank: null },
    ] as never;
    const s = suggestInternalLinks(pages, [{ from: "https://a.com/about", to: "https://a.com/blog/burst-pipes" }]);
    assert.ok(s.length > 0 && s.length <= MAX_SUGGESTIONS);
    const reasons = new Set(s.map((d) => d.reason));
    // The ranking page is also an orphan; the higher-scoring high-value card wins the pair.
    assert.ok(reasons.has("high_value_underlinked"));
    assert.ok(reasons.has("keyword_relevant"));
    assert.ok(!s.some((d) => d.targetUrl.endsWith("/about")), "a page with no topical tokens gets no source");
    for (let i = 1; i < s.length; i++) assert.ok(s[i - 1].score >= s[i].score);
    const pairs = s.map((d) => `${d.sourceUrl}>${d.targetUrl}`);
    assert.equal(new Set(pairs).size, pairs.length);
  });

  it("extracts same-host hrefs only", () => {
    const html = `<a href="/a">A</a><a href='https://www.acme.com/b#x'>B</a><a href=c>C</a>
      <a href="https://evil.test/">E</a><a href="mailto:x@y">M</a><a href="#top">T</a>`;
    assert.deepEqual(extractInternalHrefs(html, "https://acme.com/dir/page").sort(), [
      "https://acme.com/a",
      "https://acme.com/dir/c",
      "https://www.acme.com/b",
    ]);
    assert.deepEqual(extractInternalHrefs(html, "not a url"), []);
  });
});

describe("programmatic publish", () => {
  const template = { defaultPublishTarget: "wordpress", defaultTargetSiteId: "site-t", defaultWebflowCollectionId: null };

  it("resolves destination precedence explicit > page > template", () => {
    assert.deepEqual(
      resolveDestination({ page: { publishTarget: "none", targetSiteId: null, webflowCollectionId: null }, template }),
      { kind: "wordpress", siteId: "site-t", collectionId: null },
    );
    assert.equal(
      resolveDestination({ page: { publishTarget: "webflow", targetSiteId: "p", webflowCollectionId: "c" }, template }).kind,
      "webflow",
    );
    assert.equal(
      resolveDestination({ explicit: { target: "none" }, page: { publishTarget: "webflow", targetSiteId: null, webflowCollectionId: null }, template }).kind,
      "none",
    );
  });

  it("classifies pushes: update in place only for the same destination", () => {
    const dest = { kind: "webflow" as const, siteId: "s", collectionId: "A" };
    const published = { status: "published", publishTarget: "webflow", targetSiteId: "s", targetCollectionId: "A", externalId: "ext" };
    assert.deepEqual(classifyPush({ ...published, dest }), { mode: "update", blockedReason: null });
    assert.match(classifyPush({ ...published, dest: { ...dest, collectionId: "B" } }).blockedReason ?? "", /Already published/);
    assert.match(classifyPush({ ...published, status: "discarded", dest }).blockedReason ?? "", /status/);
    assert.deepEqual(classifyPush({ ...published, status: "ready", dest }), { mode: "create", blockedReason: null });
  });

  it("builds escaped head meta and full documents", () => {
    const meta = buildHeadMeta({ description: 'A "quoted" <desc>', canonical: "https://a.com/x", noindex: true });
    assert.match(meta, /content="A &quot;quoted&quot; &lt;desc&gt;"/);
    assert.match(meta, /rel="canonical" href="https:\/\/a.com\/x"/);
    assert.match(meta, /noindex, follow/);
    const html = buildSiteHtml({ title: "T & U", description: "", canonical: null, noindex: false, bodyHtml: "<p>x</p>" });
    assert.match(html, /<title>T &amp; U<\/title>/);
    assert.doesNotMatch(html, /canonical/);
  });

  it("maps page URLs to working-copy file paths", () => {
    assert.equal(siteFilePathForUrl("/services/austin/"), "/services/austin.html");
    assert.equal(siteFilePathForUrl("/"), "/index.html");
  });
});
