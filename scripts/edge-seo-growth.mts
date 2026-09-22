// Marketr — GROUP C edge-case sweep: SEO growth stack
// (programmatic, autopilot, backlinks, internal links, retention, local).
//
// READ-ONLY on all source: pure functions + mock databases only.
// No live DB, no network, no LLM. Deterministic: three runs must print
// identical pass/fail counts.
//
// Run: npx tsx scripts/edge-seo-growth.mts

import {
  buildPageUrl,
  duplicateRate,
  evaluateGates,
  extractVariables,
  generatePage,
  hashPageContent,
  normalizeUrlPattern,
  parseCsv,
  QUALITY_FLAGS,
  resolveRowValues,
  simpleBlocksToTiptap,
  slugify,
  substitute,
  substituteTiptapText,
  tiptapText,
  MAX_DATASET_ROWS,
  MAX_SLUG_SEGMENT_LENGTH,
  type SimpleBlock,
} from "@/lib/seo/programmatic";
import {
  buildHeadMeta,
  buildSiteHtml,
  classifyPush,
  destinationLabel,
  isPublishTarget,
  resolveDestination,
  siteFilePathForUrl,
  webflowFieldDataForPage,
} from "@/lib/seo/programmatic-publish";
import {
  capCandidates,
  clampMaxItemsPerRun,
  dedupeCandidates,
  fallbackTitle,
  isAutoApproveEligible,
  isKilledForProject,
  markdownToSimpleBlocks,
  markdownToTiptap,
  scopeKeyFor,
  validatePublishTarget,
  validateRuleInput,
  MAX_ITEMS_PER_RUN_HARD_CAP,
  type AutopilotCandidate,
} from "@/lib/seo/autopilot";
import {
  approveAutopilotItem,
  createAutopilotRule,
  isAutopilotKilled,
  killAutopilot,
  rejectAutopilotItem,
  runAutopilotRule,
  unkillAutopilot,
  updateAutopilotRule,
} from "@/lib/seo/autopilot-service";
import {
  checkPullBudget,
  estimateListPullCost,
  estimateSummaryPullCost,
  monthKey,
  BACKLINKS_PRICING,
  DEFAULT_MONTHLY_SPEND_CAP_USD,
  MAX_BACKLINK_ROWS_PER_PULL,
} from "@/lib/seo/backlinks-cost";
import {
  buildLinkGraph,
  contentTokens,
  extractInternalHrefs,
  normalizeInternalUrl,
  suggestInternalLinks,
  MAX_SUGGESTIONS,
  MIN_TOKEN_OVERLAP,
} from "@/lib/seo/internal-links";
import { projectEdges } from "@/lib/seo/internal-links-sync";
import { computeDecay } from "@/lib/retention/decay";
import { detectCitation, snapshotChanges } from "@/lib/retention/ai-visibility";
import { diffCompetitorSnapshots } from "@/lib/retention/radar";
import {
  combineScore,
  dayBucket,
  resolveWeights,
  DEFAULT_WEIGHTS,
} from "@/lib/retention/visibility-score";
import {
  clampGridSize,
  diffGridRuns,
  generateGridCells,
  matchClientPosition,
  normalizeBusinessName,
  summarizeGridRun,
} from "@/lib/local/grid";
import {
  classifySentiment,
  extractThemes,
  heuristicSentiment,
  reviewSeverity,
} from "@/lib/local/sentiment";
import { prisma } from "@/lib/prisma";
import {
  monthlyBacklinkSpendUsd,
  previewBacklinkPull,
  runBacklinkPull,
} from "@/lib/seo/backlink-pull";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface ModStats { run: number; passed: number; failed: number }
const stats = new Map<string, ModStats>();
const failures: string[] = [];

function mod(name: string): ModStats {
  let s = stats.get(name);
  if (!s) { s = { run: 0, passed: 0, failed: 0 }; stats.set(name, s); }
  return s;
}

function check(module: string, name: string, cond: unknown, detail?: string) {
  const s = mod(module);
  s.run++;
  if (cond) { s.passed++; }
  else {
    s.failed++;
    failures.push(`[${module}] ${name}${detail ? `\n      → ${detail}` : ""}`);
    console.error(`FAIL [${module}] ${name}`);
  }
}

function eq(module: string, name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(module, name, a === e, `expected ${e}, got ${a}`);
}

function throwsSync(module: string, name: string, fn: () => unknown, match?: RegExp) {
  try {
    fn();
    check(module, name, false, "expected a throw, none happened");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(module, name, !match || match.test(msg), `threw "${msg}" — did not match ${match}`);
  }
}

async function throwsAsync(module: string, name: string, fn: () => Promise<unknown>, match?: RegExp) {
  try {
    await fn();
    check(module, name, false, "expected a throw, none happened");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(module, name, !match || match.test(msg), `threw "${msg}" — did not match ${match}`);
  }
}

// ===========================================================================
// 1. lib/seo/programmatic.ts — substitution, CSV, slugs, hashing, gates
// ===========================================================================
{
  const M = "programmatic";

  // --- {{variable}} substitution edges ---
  eq(M, "sub: unicode/emoji/RTL value preserved",
    substitute("Hi {{name}}!", { name: "José 🎉 مرحبا" }).text, "Hi José 🎉 مرحبا!");
  eq(M, "sub: empty string value",
    substitute("Hi {{name}}!", { name: "" }), { text: "Hi !", missing: ["name"] });
  eq(M, "sub: whitespace-only value",
    substitute("Hi {{name}}!", { name: "   " }), { text: "Hi !", missing: ["name"] });
  eq(M, "sub: null value counts as missing",
    substitute("Hi {{name}}!", { name: null }), { text: "Hi !", missing: ["name"] });
  eq(M, "sub: undefined value counts as missing",
    substitute("Hi {{name}}!", { name: undefined }), { text: "Hi !", missing: ["name"] });
  // Injection-like payload: replacement text must NOT be re-scanned (single pass).
  eq(M, "sub: value containing {{y}} is not re-substituted",
    substitute("{{x}}", { x: "{{y}}" }), { text: "{{y}}", missing: [] });
  eq(M, "sub: adjacent duplicates {{x}}{{x}}",
    substitute("{{x}}{{x}}", {}), { text: "", missing: ["x"] });
  // Dotted var names are outside the supported charset → left literal.
  eq(M, "sub: dotted var name not substituted (literal)",
    substitute("{{user.name}}", { "user.name": "Bo" }).text, "{{user.name}}");
  eq(M, "sub: var name with space not substituted (literal)",
    substitute("{{my var}}", {}).text, "{{my var}}");
  // Quadruple braces: inner {{x}} substitutes, outer braces leak literally.
  eq(M, "sub: {{{{x}}}} brace nesting",
    substitute("{{{{x}}}}", { x: "Austin" }).text, "{{Austin}}");
  eq(M, "sub: empty template string", substitute("", { a: "b" }), { text: "", missing: [] });
  eq(M, "sub: 100k-char template does not hang",
    substitute("x".repeat(100_000) + "{{a}}", { a: "b" }).text.length, 100_001);
  eq(M, "sub: fallback containing pipe chars",
    substitute("{{x|a|b}}", {}), { text: "a|b", missing: [] });
  eq(M, "sub: fallback with braces-adjacent text",
    substitute("[{{x|d}}]", {}), { text: "[d]", missing: [] });
  throwsSync(M, "sub: null text throws TypeError (out-of-contract)", () =>
    substitute(null as unknown as string, {}), /./);

  // extractVariables edges
  eq(M, "extract: unicode var name ignored", extractVariables("{{café}} {{city}}").map((v) => v.name), ["city"]);
  eq(M, "extract: empty/falsy texts", extractVariables("", "{{a}}"), [{ name: "a" }]);
  eq(M, "extract: fallback with empty string", extractVariables("{{a|}}"), [{ name: "a", fallback: "" }]);
  eq(M, "extract: first fallback wins on repeat", extractVariables("{{a|x}} {{a|y}}"), [{ name: "a", fallback: "x" }]);
  eq(M, "extract: later fallback fills earlier bare var",
    extractVariables("{{a}} {{a|y}}"), [{ name: "a", fallback: "y" }]);

  // --- slug edges ---
  eq(M, "slug: identical titles collide", slugify("Hello World!"), slugify("hello world"));
  eq(M, "slug: unicode-only collapses to page", slugify("北京 مرحبا"), "page");
  eq(M, "slug: emoji stripped", slugify("Plumbing 🎉"), "plumbing");
  eq(M, "slug: RTL stripped to page", slugify("مرحبا"), "page");
  eq(M, "slug: empty → page", slugify(""), "page");
  eq(M, "slug: whitespace → page", slugify("   "), "page");
  eq(M, "slug: exactly at 96-char cap kept whole",
    slugify("a".repeat(96)), "a".repeat(96));
  eq(M, "slug: 97 chars truncated to cap", slugify("a".repeat(97)).length <= MAX_SLUG_SEGMENT_LENGTH, true);
  eq(M, "slug: no reserved-word filtering (documents absence)",
    slugify("admin"), "admin");
  eq(M, "slug: trailing hyphens trimmed after slice",
    slugify("a".repeat(95) + "!!!"), "a".repeat(95));
  throwsSync(M, "slug: null throws (out-of-contract)", () => slugify(null as unknown as string), /./);

  // --- normalizeUrlPattern edges ---
  eq(M, "pattern: triple braces untouched", normalizeUrlPattern("/{{{city}}}"), "/{{{city}}}");
  eq(M, "pattern: empty braces untouched", normalizeUrlPattern("/{{}}/x"), "/{{}}/x");
  eq(M, "pattern: spaced braces untouched", normalizeUrlPattern("/{ city }"), "/{ city }");

  // --- buildPageUrl edges ---
  const bp0 = buildPageUrl("", {});
  check(M, "buildPageUrl: empty pattern → / + page slug",
    bp0.url === "/" && bp0.slug === "page" && bp0.missing.length === 0, JSON.stringify(bp0));
  eq(M, "buildPageUrl: root pattern",
    buildPageUrl("/", {}).url, "/page");
  const bpDbl = buildPageUrl("/a//b", {});
  check(M, "buildPageUrl: double slashes never collapse into collisions",
    bpDbl.url === "/a/page/b" && bpDbl.slug === "a/page/b", JSON.stringify(bpDbl));
  const bpUni = buildPageUrl("/x/{{city}}", { city: "北京" });
  check(M, "buildPageUrl: unicode segment → page",
    bpUni.url === "/x/page" && bpUni.slug === "x/page", JSON.stringify(bpUni));
  const collision = buildPageUrl("/s/{{a}}/{{b}}", { a: "New York", b: "new-york" });
  eq(M, "buildPageUrl: distinct values can still collide (new york ×2)",
    collision.slug, "s/new-york/new-york");

  // --- CSV edges ---
  eq(M, "csv: mid-string BOM stripped by cell trim (documents)",
    parseCsv("a\n\uFEFFb").rows, [{ a: "b" }]);
  eq(M, "csv: mismatched columns — extra cells silently dropped",
    parseCsv("a,b\n1,2,3").rows, [{ a: "1", b: "2" }]);
  eq(M, "csv: short row pads with empty",
    parseCsv("a,b,c\n1").rows, [{ a: "1", b: "", c: "" }]);
  eq(M, "csv: unterminated quote accepted",
    parseCsv('a\n"x').rows, [{ a: "x" }]);
  eq(M, "csv: lone CR is a newline", parseCsv("a\rb").rows, [{ a: "b" }]);
  eq(M, "csv: only-whitespace rows dropped",
    parseCsv("a\n1\n   \n2").rows, [{ a: "1" }, { a: "2" }]);
  eq(M, "csv: header only → no rows", parseCsv("a,b\n"), { columns: ["a", "b"], rows: [] });
  eq(M, "csv: quoted empty field → row filtered as empty (documents)",
    parseCsv('a\n""').rows, []);
  eq(M, "csv: quote then junk char", parseCsv('a\n"b"c').rows, [{ a: "bc" }]);
  eq(M, "csv: 10001 rows parse (cap is enforced by callers, not the parser)",
    parseCsv("a\n" + "1\n".repeat(10001)).rows.length, 10001);
  eq(M, "csv: MAX_DATASET_ROWS constant is 10000", MAX_DATASET_ROWS, 10000);
  eq(M, "csv: duplicate header names — last wins",
    parseCsv("a,a\n1,2").rows, [{ a: "2" }]);

  // --- hashing edges ---
  const emptyHash1 = hashPageContent({ title: "", description: "", blocks: {} });
  const emptyHash2 = hashPageContent({ title: "  ", description: "\n", blocks: null });
  eq(M, "hash: all-empty content hashes are identical (by design → duplicate flag)",
    emptyHash1, emptyHash2);
  check(M, "hash: empty hash is sha256 hex", /^[0-9a-f]{64}$/.test(emptyHash1));
  eq(M, "hash: empty vs non-empty differ",
    emptyHash1 === hashPageContent({ title: "x", description: "", blocks: {} }), false);

  // --- duplicateRate edges ---
  eq(M, "dupRate: empty → 0", duplicateRate([]), 0);
  eq(M, "dupRate: all null → 0", duplicateRate([null, undefined, ""]), 0);
  eq(M, "dupRate: two identical → 1", duplicateRate(["a", "a"]), 1);

  // --- evaluateGates boundaries ---
  const gateBase = {
    flags: [] as string[], missingVariables: [] as string[], wordCount: 500,
    minWordCount: 300, templateDuplicateRate: 0, duplicateRateCap: 0.05,
    checkDuplicateRate: true,
  };
  eq(M, "gates: duplicate rate exactly AT cap passes",
    evaluateGates({ ...gateBase, templateDuplicateRate: 0.05 }).pass, true);
  eq(M, "gates: duplicate rate 1 epsilon over cap blocks",
    evaluateGates({ ...gateBase, templateDuplicateRate: 0.050001 }).pass, false);
  eq(M, "gates: wordCount exactly at min passes",
    evaluateGates({ ...gateBase, flags: [], wordCount: 300, minWordCount: 300 }).pass, true);
  eq(M, "gates: zero cap blocks any duplicates",
    evaluateGates({ ...gateBase, templateDuplicateRate: 0.001, duplicateRateCap: 0 }).pass, false);

  // --- generatePage / substituteTiptapText edges ---
  const tpl = {
    urlPattern: "/s/{{city}}",
    titleTemplate: "{{service}} in {{city}}",
    descriptionTemplate: "Best {{service}}.",
    contentBlocks: simpleBlocksToTiptap([{ type: "paragraph", text: "{{service}} rocks" } as SimpleBlock]),
    minWordCount: 1,
    duplicateRateCap: 0.05,
  };
  const g1 = generatePage(tpl, { city: "Austin", service: "Plumbing" }, "https://example.com/");
  eq(M, "generatePage: trailing-slash origin canonical", g1.canonical, "https://example.com/s/austin");
  const g2 = generatePage(tpl, { city: "", service: "" }, "https://example.com");
  check(M, "generatePage: empty values still flag missing vars", g2.flags.includes(QUALITY_FLAGS.missingVariable));
  const sub2 = substituteTiptapText({ type: "doc", content: [] }, { a: "b" });
  eq(M, "substituteTiptapText: non-text doc untouched", (sub2.doc as { type: string }).type, "doc");
  eq(M, "substituteTiptapText: null doc passthrough", substituteTiptapText(null, {}).doc, null);
}

// ===========================================================================
// 2. lib/seo/programmatic-publish.ts — pure destination/payload/idempotency
// ===========================================================================
{
  const M = "programmatic-publish";
  const page = { publishTarget: "wordpress", targetSiteId: "site-wp", webflowCollectionId: null as string | null };
  const tplD = { defaultPublishTarget: "webflow", defaultTargetSiteId: "site-wf", defaultWebflowCollectionId: "col-x" };

  // destination precedence edges
  eq(M, "dest: invalid explicit target normalizes to none (API validates upstream)",
    resolveDestination({ explicit: { target: "bogus" }, page, template: tplD }).kind, "none");
  eq(M, "dest: explicit empty-string target → none",
    resolveDestination({ explicit: { target: "" }, page, template: tplD }).kind, "none");
  eq(M, "dest: explicit {} (no target) falls back to page",
    resolveDestination({ explicit: {}, page, template: tplD }).kind, "wordpress");
  eq(M, "dest: invalid page target falls back to template default",
    resolveDestination({
      page: { publishTarget: "bogus", targetSiteId: null, webflowCollectionId: null },
      template: tplD,
    }).kind, "webflow");
  eq(M, "dest: invalid page target + invalid template default → none",
    resolveDestination({
      page: { publishTarget: "bogus", targetSiteId: null, webflowCollectionId: null },
      template: { defaultPublishTarget: "bogus", defaultTargetSiteId: null, defaultWebflowCollectionId: null },
    }).kind, "none");
  eq(M, "dest: explicit null target uses page",
    resolveDestination({ explicit: { target: null }, page, template: tplD }).kind, "wordpress");

  // classifyPush edges
  const wpDest = { kind: "wordpress" as const, siteId: "s1", collectionId: null as string | null };
  eq(M, "classify: empty-string status blocked",
    classifyPush({ status: "", publishTarget: "none", targetSiteId: null, targetCollectionId: null, externalId: null, dest: wpDest }).blockedReason !== null, true);
  // FIXED (day-1, #16): webflow collection id is part of the same-target check.
  const wfDestB = { kind: "webflow" as const, siteId: "s1", collectionId: "col-B" };
  const crossCollection = classifyPush({
    status: "published", publishTarget: "webflow", targetSiteId: "s1", targetCollectionId: "col-A",
    externalId: "item-1", dest: wfDestB,
  });
  check(M, "FIXED classify: published to col-A re-pushed to col-B is not 'update'",
    !(crossCollection.mode === "update" && crossCollection.blockedReason === null),
    `got mode=${crossCollection.mode}, blockedReason=${crossCollection.blockedReason}`);
  const wfDestA = { kind: "webflow" as const, siteId: "s1", collectionId: "col-A" };
  const sameCollection = classifyPush({
    status: "published", publishTarget: "webflow", targetSiteId: "s1", targetCollectionId: "col-A",
    externalId: "item-1", dest: wfDestA,
  });
  check(M, "classify: same collection re-push is 'update'",
    sameCollection.mode === "update" && sameCollection.blockedReason === null,
    `got mode=${sameCollection.mode}`);

  // siteFilePathForUrl edges
  eq(M, "path: root url → /index.html", siteFilePathForUrl("/"), "/index.html");
  eq(M, "path: empty url → /index.html", siteFilePathForUrl(""), "/index.html");
  eq(M, "path: query string kept in filename (documents)",
    siteFilePathForUrl("/a?b=c"), "/a?b=c.html");
  throwsSync(M, "path: traversal throws", () => siteFilePathForUrl("/../secret"), /escapes/);
  throwsSync(M, "path: backslash traversal throws", () => siteFilePathForUrl("..\\secret"), /escapes/);

  // payload builder edges
  eq(M, "head: empty description + null canonical + indexable → empty",
    buildHeadMeta({ description: "   ", canonical: null, noindex: false }), "");
  eq(M, "head: empty-string canonical skipped",
    buildHeadMeta({ description: "d", canonical: "", noindex: false }).includes("canonical"), false);
  const wf = webflowFieldDataForPage({ title: "t", slug: "s", metaHtml: "", bodyHtml: "<p>b</p>" });
  eq(M, "webflow: empty meta → no leading newline",
    (JSON.parse(wf) as { "page-html": string })["page-html"], "<p>b</p>");
  eq(M, "label: csv", destinationLabel({ kind: "csv", siteId: null, collectionId: null }), "CSV export (internal)");
  eq(M, "label: none", destinationLabel({ kind: "none", siteId: null, collectionId: null }), "none (inherit → nothing)");
  check(M, "isPublishTarget: case-sensitive", !isPublishTarget("WordPress"));
  check(M, "isPublishTarget: rejects undefined", !isPublishTarget(undefined));
  const doc = buildSiteHtml({ title: "", description: "", canonical: null, noindex: false, bodyHtml: "" });
  check(M, "site html: empty inputs still well-formed", doc.startsWith("<!DOCTYPE html>") && doc.includes("<title></title>"));
}

// ===========================================================================
// 3. lib/seo/autopilot.ts — pure engine
// ===========================================================================
{
  const M = "autopilot";

  // clamp boundaries: 50 vs 51
  eq(M, "clamp: 50 → 50", clampMaxItemsPerRun(50), 50);
  eq(M, "clamp: 51 → 50 (hard cap)", clampMaxItemsPerRun(51), 50);
  eq(M, "clamp: 1 → 1", clampMaxItemsPerRun(1), 1);
  eq(M, "clamp: 1.9 → 1", clampMaxItemsPerRun(1.9), 1);
  eq(M, "clamp: Infinity → default 5", clampMaxItemsPerRun(Infinity), 5);
  eq(M, "clamp: -Infinity → default 5 (not finite → default)", clampMaxItemsPerRun(-Infinity), 5);
  eq(M, "clamp: null → default 5", clampMaxItemsPerRun(null), 5);

  // validateRuleInput edges
  eq(M, "validate: name of only whitespace throws", (() => { try { validateRuleInput({ name: "   ", source: "decay_refresh" }); return "no-throw"; } catch { return "threw"; } })(), "threw");
  const longName = validateRuleInput({ name: "x".repeat(200), source: "decay_refresh" });
  eq(M, "validate: name truncated to 120", longName.name.length, 120);
  eq(M, "validate: autoApprove truthy-string stays OFF (strict === true)",
    validateRuleInput({ name: "r", source: "decay_refresh", autoApprove: "true" }).autoApprove, false);
  eq(M, "validate: autoApprove 1 stays OFF",
    validateRuleInput({ name: "r", source: "decay_refresh", autoApprove: 1 }).autoApprove, false);
  eq(M, "validate: maxItemsPerRun 10000 clamped to 50",
    validateRuleInput({ name: "r", source: "decay_refresh", maxItemsPerRun: 10000 }).maxItemsPerRun, 50);
  eq(M, "validate: unknown cadence → manual",
    validateRuleInput({ name: "r", source: "decay_refresh", cadence: "hourly" }).cadence, "manual");
  throwsSync(M, "validate: publishTarget array throws", () => validatePublishTarget([]), /kind/);
  eq(M, "validate: publishTarget whitespace siteId → null",
    validatePublishTarget({ kind: "wordpress", siteId: "   " })?.siteId, null);

  // dedupe edges
  const cands: AutopilotCandidate[] = [
    { kind: "decay_refresh", sourceRef: "a", title: "A", priority: 1, brief: "b" },
    { kind: "keyword_brief", sourceRef: "a", title: "B", priority: 1, brief: "b" },
  ];
  eq(M, "dedupe: same sourceRef but different kind is NOT deduped",
    dedupeCandidates(cands, [{ kind: "decay_refresh", sourceRef: "a", status: "pending" }]).length, 1);
  eq(M, "dedupe: killed items do not block",
    dedupeCandidates(cands.slice(0, 1), [{ kind: "decay_refresh", sourceRef: "a", status: "killed" }]).length, 1);
  eq(M, "dedupe: published items do not block",
    dedupeCandidates(cands.slice(0, 1), [{ kind: "decay_refresh", sourceRef: "a", status: "published" }]).length, 1);
  eq(M, "dedupe: empty candidates", dedupeCandidates([], [{ kind: "decay_refresh", sourceRef: "a", status: "pending" }]), []);

  // cap edges: exactly 50 vs 51 candidates at cap 50
  const fiftyOne = Array.from({ length: 51 }, (_, i) => ({ kind: "decay_refresh" as const, sourceRef: `s${i}`, title: "t", priority: i, brief: "b" }));
  eq(M, "cap: 51 candidates at maxItems 50 → 50", capCandidates(fiftyOne, 50).length, 50);
  eq(M, "cap: 51 candidates at maxItems 51 → 50 (hard cap)", capCandidates(fiftyOne, 51).length, 50);
  const ties = [
    { kind: "decay_refresh" as const, sourceRef: "a", title: "t", priority: 1, brief: "b" },
    { kind: "decay_refresh" as const, sourceRef: "b", title: "t", priority: 1, brief: "b" },
  ];
  eq(M, "cap: priority ties keep insertion order (stable sort)",
    capCandidates(ties, 2).map((c) => c.sourceRef), ["a", "b"]);
  eq(M, "cap: negative maxItems → clamp 1", capCandidates(ties, -3).length, 1);

  // auto-approve boundary
  eq(M, "auto-approve: decay+true eligible", isAutoApproveEligible("decay_refresh", true), true);
  eq(M, "auto-approve: programmatic+true NOT eligible", isAutoApproveEligible("programmatic_page", true), false);
  eq(M, "auto-approve: keyword+true NOT eligible", isAutoApproveEligible("keyword_brief", true), false);

  // kill-switch scope edges
  throwsSync(M, "scope: whitespace-only workspaceId throws", () => scopeKeyFor({ workspaceId: "   " }), /requires/);
  eq(M, "killed: killed=false row never kills",
    isKilledForProject([{ scopeKey: "workspace:w1", killed: false }, { scopeKey: "project:p1", killed: false }], "w1", "p1"), false);
  eq(M, "killed: similar-but-different scope keys do not match",
    isKilledForProject([{ scopeKey: "workspace:w10", killed: true }], "w1", "p1"), false);
  eq(M, "killed: substring scope key does not match",
    isKilledForProject([{ scopeKey: "project:p1-evil", killed: true }], "w1", "p1"), false);

  // markdown edges
  eq(M, "md: h4 becomes paragraph text (only h1-h3 supported)",
    markdownToSimpleBlocks("#### Deep").map((b) => b.type), ["paragraph"]);
  eq(M, "md: ordered list becomes ONE paragraph (no list support; lines joined)",
    markdownToSimpleBlocks("1. first\n2. second").map((b) => b.type), ["paragraph"]);
  eq(M, "md: blockquote becomes paragraph",
    markdownToSimpleBlocks("> quoted").map((b) => b.type), ["paragraph"]);
  eq(M, "md: trimmed '#' is not a heading → paragraph (documents)",
    markdownToSimpleBlocks("# \n\ntext").map((b) => b.type), ["paragraph", "paragraph"]);
  eq(M, "md: lone CR normalized",
    markdownToSimpleBlocks("# T\rBody").map((b) => b.type), ["h1", "paragraph"]);
  eq(M, "md: setext heading not parsed",
    markdownToSimpleBlocks("Title\n===").map((b) => b.type), ["paragraph"]);
  eq(M, "md: 100k-char single line → one paragraph",
    markdownToSimpleBlocks("x".repeat(100_000)).length, 1);
  eq(M, "md: bullet directly after text without blank line",
    markdownToSimpleBlocks("para\n- item").map((b) => b.type), ["paragraph", "bullet"]);
  eq(M, "fallbackTitle: long sourceRef truncated",
    fallbackTitle("decay_refresh", "x".repeat(100)).length <= "decay refresh — ".length + 24, true);
}

// ===========================================================================
// 4. lib/seo/autopilot-service.ts — orchestration with mock DBs
// ===========================================================================
{
  const M = "autopilot-service";

  interface Call { model: string; method: string; args?: unknown }

  // Stateful mock with a FAITHFUL Prisma where-clause simulation for the
  // kill-switch lookup. Post-fix, isAutopilotKilled delegates to
  // getKillStatus and queries where: { scopeKey: { in: [...] } }.
  function statefulDb(seedKillRows: Array<{ workspaceId: string | null; projectId: string | null; scopeKey: string; killed: boolean }> = []) {
    const calls: Call[] = [];
    const killRows = seedKillRows.map((r) => ({ ...r }));
    const itemStore: Array<Record<string, unknown>> = [];
    const runUpdates: Array<{ data: Record<string, unknown> }> = [];
    const db = {
      autopilotRule: {
        findFirst: async () => ({
          id: "rule1", projectId: "p1", source: "decay_refresh", programmaticTemplateId: null,
          maxItemsPerRun: 5, autoApprove: false, enabled: true, publishTarget: null, name: "R",
        }),
        create: async (a: { data: Record<string, unknown> }) => {
          calls.push({ model: "autopilotRule", method: "create", args: a });
          return { id: "rule-new", ...a.data };
        },
        update: async (a: unknown) => { calls.push({ model: "autopilotRule", method: "update", args: a }); return {}; },
      },
      autopilotKillSwitch: {
        findMany: async (a?: { where?: { scopeKey?: { in?: string[] }; workspaceId?: string; OR?: Array<{ projectId?: string }> } }) => {
          calls.push({ model: "autopilotKillSwitch", method: "findMany", args: a });
          const w = a?.where ?? {};
          // Fixed query shape (day-1): scopeKey IN [workspace:.., project:..].
          if (w.scopeKey?.in) {
            const keys = w.scopeKey.in;
            return killRows.filter((r) => keys.includes(r.scopeKey));
          }
          // Legacy pre-fix shape: top-level keys are ANDed (kept for
          // documentation; product code no longer queries this way).
          return killRows.filter(
            (r) =>
              (w.workspaceId === undefined || r.workspaceId === w.workspaceId) &&
              (!w.OR || w.OR.some((o) => o.projectId === undefined || r.projectId === o.projectId)),
          );
        },
        upsert: async (a: { where: { scopeKey: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
          calls.push({ model: "autopilotKillSwitch", method: "upsert", args: a });
          const ex = killRows.find((r) => r.scopeKey === a.where.scopeKey);
          if (ex) Object.assign(ex, a.update);
          else killRows.push({
            workspaceId: (a.create.workspaceId as string | null) ?? null,
            projectId: (a.create.projectId as string | null) ?? null,
            scopeKey: a.create.scopeKey as string,
            killed: a.create.killed as boolean,
          });
          return {};
        },
      },
      autopilotRun: {
        create: async (a: unknown) => { calls.push({ model: "autopilotRun", method: "create", args: a }); return { id: "run1" }; },
        update: async (a: { data: Record<string, unknown> }) => { calls.push({ model: "autopilotRun", method: "update", args: a }); runUpdates.push(a); return {}; },
        updateMany: async (a: unknown) => { calls.push({ model: "autopilotRun", method: "updateMany", args: a }); return { count: 0 }; },
      },
      autopilotItem: {
        findMany: async (a?: unknown) => {
          calls.push({ model: "autopilotItem", method: "findMany", args: a });
          return itemStore.filter((i) => ["pending", "approved"].includes(i.status as string));
        },
        findFirst: async () => null,
        create: async (a: { data: Record<string, unknown> }) => {
          calls.push({ model: "autopilotItem", method: "create", args: a });
          const row = { id: `item-${itemStore.length + 1}`, ...a.data };
          itemStore.push(row);
          return row;
        },
        update: async (a: unknown) => { calls.push({ model: "autopilotItem", method: "update", args: a }); return {}; },
        updateMany: async (a: unknown) => { calls.push({ model: "autopilotItem", method: "updateMany", args: a }); return { count: 0 }; },
      },
      contentDecayFinding: {
        findMany: async () => [{ id: "f1", url: "/a", phrases: ["kw a"], decayScore: 80 }],
      },
      fileChangeLog: {
        create: async (a: { data: { action: string; summary: string } }) => { calls.push({ model: "fileChangeLog", method: "create", args: a }); return {}; },
      },
    };
    return { db: db as never, calls, killRows, itemStore, runUpdates };
  }

  const stubGen = async (c: AutopilotCandidate) => ({ title: c.title, markdown: `# ${c.title}\n\nBody.` });

  // --- FIXED (day-1): kill switch lookup uses scopeKey, matching the UI ---
  {
    const seeded = statefulDb([
      { workspaceId: null, projectId: "p1", scopeKey: "project:p1", killed: true },
    ]);
    const killed = await isAutopilotKilled(seeded.db, "w1", "p1");
    check(M, "FIXED kill: project-scoped kill row blocks the project",
      killed === true,
      `isAutopilotKilled("w1","p1") returned ${killed} with a killed project:p1 row present`);
  }
  {
    const seeded = statefulDb([
      { workspaceId: "w1", projectId: null, scopeKey: "workspace:w1", killed: true },
    ]);
    const killed = await isAutopilotKilled(seeded.db, "w1", "p1");
    check(M, "FIXED kill: workspace-scoped kill row blocks its projects",
      killed === true,
      `isAutopilotKilled("w1","p1") returned ${killed} with a killed workspace:w1 row present`);
  }
  {
    // Consequence fixed: a run can no longer proceed while engaged.
    const s = statefulDb([
      { workspaceId: null, projectId: "p1", scopeKey: "project:p1", killed: true },
    ]);
    let threw = false;
    try { await runAutopilotRule(s.db, { workspaceId: "w1", projectId: "p1", ruleId: "rule1", actor: "u1", draftGenerator: stubGen }); }
    catch { threw = true; }
    check(M, "FIXED kill: engaged kill switch stops runAutopilotRule",
      threw === true, `run started and generated ${s.itemStore.length} item(s) despite engaged kill switch`);
  }
  {
    // Non-killed rows still don't block.
    const s = statefulDb([
      { workspaceId: null, projectId: "p1", scopeKey: "project:p1", killed: false },
    ]);
    const killed = await isAutopilotKilled(s.db, "w1", "p1");
    check(M, "FIXED kill: killed=false row does not block", killed === false,
      `isAutopilotKilled returned ${killed} for a non-killed row`);
  }

  // --- kill mid-run: freeze semantics ---
  // NOTE: the kill lookup is fixed (scopeKey-based), so the mock needs no
  // patching here — this block exercises the post-generation race with the
  // real product code path.
  {
    const s = statefulDb();
    let genCalls = 0;
    const killerGen = async (c: AutopilotCandidate) => {
      genCalls++;
      await killAutopilot(s.db, { workspaceId: "w1", projectId: "p1", actor: "u1", reason: "test" });
      return { title: c.title, markdown: "# t\n\nbody" };
    };
    // three findings → kill lands during the first candidate
    (s.db as unknown as { contentDecayFinding: { findMany: () => Promise<unknown[]> } }).contentDecayFinding.findMany =
      async () => [
        { id: "f1", url: "/a", phrases: ["a"], decayScore: 80 },
        { id: "f2", url: "/b", phrases: ["b"], decayScore: 70 },
        { id: "f3", url: "/c", phrases: ["c"], decayScore: 60 },
      ];
    await throwsAsync(M, "kill mid-run: run aborts with killed error",
      () => runAutopilotRule(s.db, { workspaceId: "w1", projectId: "p1", ruleId: "rule1", actor: "u1", draftGenerator: killerGen }),
      /killed/i);
    check(M, "kill mid-run: generator ran exactly once (remaining items frozen)",
      genCalls === 1, `generator ran ${genCalls} time(s)`);
    check(M, "kill mid-run: run row marked killed",
      s.runUpdates.some((u) => u.data.status === "killed"),
      JSON.stringify(s.runUpdates.map((u) => u.data.status)));
    check(M, "kill mid-run: killAutopilot froze in-flight items via updateMany",
      s.calls.some((c) => c.model === "autopilotItem" && c.method === "updateMany"));
    // The in-progress candidate's item is created AFTER killAutopilot ran → not frozen.
    const createdStatuses = s.itemStore.map((i) => i.status);
    check(M, "BUG kill: item created after the mid-run kill is left pending (not frozen)",
      createdStatuses.every((st) => st === "killed"),
      `item statuses after kill: ${JSON.stringify(createdStatuses)} — the in-progress candidate slips through unfrozen`);
  }

  // --- no silent resume ---
  {
    const s = statefulDb();
    await killAutopilot(s.db, { workspaceId: "w1", projectId: "p1", actor: "u1" });
    const runCallsBefore = s.calls.filter((c) => c.model === "autopilotRun").length;
    await unkillAutopilot(s.db, { workspaceId: "w1", projectId: "p1", actor: "u1" });
    const runTouched = s.calls.filter((c) => c.model === "autopilotRun").length > runCallsBefore;
    check(M, "kill: un-kill does not touch runs (no silent resume)", !runTouched);
    const unk = s.calls.find((c) => c.model === "autopilotKillSwitch" && c.method === "upsert" && (c.args as { update: { killed: boolean } }).update.killed === false);
    check(M, "kill: un-kill is an explicit upsert", !!unk);
    // stale kill metadata (killedAt/killedBy/reason) is left behind — cosmetic
    const row = s.killRows.find((r) => r.scopeKey === "project:p1");
    check(M, "kill: un-kill leaves killedAt/killedBy/reason stale (documents)",
      row !== undefined, "row exists; metadata not cleared — cosmetic");
  }

  // --- skippedInFlight counts cap-cut items as "already in flight" ---
  {
    const s = statefulDb();
    (s.db as unknown as { autopilotRule: { findFirst: () => Promise<unknown> } }).autopilotRule.findFirst =
      async () => ({
        id: "rule1", projectId: "p1", source: "decay_refresh", programmaticTemplateId: null,
        maxItemsPerRun: 2, autoApprove: false, enabled: true, publishTarget: null, name: "R",
      });
    (s.db as unknown as { contentDecayFinding: { findMany: () => Promise<unknown[]> } }).contentDecayFinding.findMany =
      async () => [
        { id: "f1", url: "/a", phrases: ["a"], decayScore: 80 },
        { id: "f2", url: "/b", phrases: ["b"], decayScore: 70 },
        { id: "f3", url: "/c", phrases: ["c"], decayScore: 60 },
      ];
    const res = await runAutopilotRule(s.db, { workspaceId: "w1", projectId: "p1", ruleId: "rule1", actor: "u1", draftGenerator: stubGen });
    eq(M, "run: 3 candidates, cap 2 → 2 generated", res.generated, 2);
    const finishedAudit = s.calls
      .filter((c) => c.model === "fileChangeLog")
      .map((c) => (c.args as { data: { action: string; summary: string } }).data)
      .find((d) => d.action === "autopilot_run_finished");
    check(M, "BUG run: skippedInFlight mislabels cap-cut items as 'already in flight'",
      res.skippedInFlight === 0,
      `skippedInFlight=${res.skippedInFlight} with zero in-flight items; audit says "${finishedAudit?.summary}"`);
  }

  // --- concurrent same-rule runs: no atomic guard → duplicates ---
  {
    const shared = statefulDb();
    const mkFindings = async () => [{ id: "f1", url: "/a", phrases: ["a"], decayScore: 80 }];
    (shared.db as unknown as { contentDecayFinding: { findMany: () => Promise<unknown[]> } }).contentDecayFinding.findMany = mkFindings;
    await runAutopilotRule(shared.db, { workspaceId: "w1", projectId: "p1", ruleId: "rule1", actor: "u1", draftGenerator: stubGen });
    // Second sweep overlaps: its in-flight read is stale (sees nothing).
    const stale = statefulDb();
    (stale.db as unknown as { contentDecayFinding: { findMany: () => Promise<unknown[]> } }).contentDecayFinding.findMany = mkFindings;
    // share the item store to simulate the same table, but the in-flight
    // read returns the pre-run snapshot (empty).
    (stale.db as unknown as { autopilotItem: { findMany: () => Promise<unknown[]> } }).autopilotItem.findMany = async () => [];
    const resB = await runAutopilotRule(stale.db, { workspaceId: "w1", projectId: "p1", ruleId: "rule1", actor: "u1", draftGenerator: stubGen });
    check(M, "BUG run: overlapping same-rule sweeps duplicate candidates (no atomic guard)",
      resB.generated === 0,
      `second overlapping sweep generated ${resB.generated} duplicate item(s) for sourceRef f1`);
  }

  // --- "skilled" regex over-match: non-kill errors classified as killed ---
  {
    const s = statefulDb();
    const badGen = async (_c: AutopilotCandidate): Promise<{ title: string; markdown: string }> => {
      throw new Error("generator unskilled at this task");
    };
    await throwsAsync(M, "run: generator error propagates", () =>
      runAutopilotRule(s.db, { workspaceId: "w1", projectId: "p1", ruleId: "rule1", actor: "u1", draftGenerator: badGen }), /unskilled/);
    const status = s.runUpdates[s.runUpdates.length - 1]?.data.status;
    check(M, "BUG run: /killed/i matches 'unskilled' → run mis-marked killed instead of failed",
      status === "failed",
      `run status = "${status}" for a non-kill generator error; failure alert also skipped on the killed path`);
  }

  // --- auto-approval boundary: decay vs non-decay with autoApprove on ---
  {
    const s = statefulDb();
    (s.db as unknown as { autopilotRule: { findFirst: () => Promise<unknown> } }).autopilotRule.findFirst =
      async () => ({
        id: "rule1", projectId: "p1", source: "keyword_opportunity", programmaticTemplateId: null,
        maxItemsPerRun: 5, autoApprove: true, enabled: true, publishTarget: null, name: "R",
      });
    (s.db as unknown as { keyword: { findMany: () => Promise<unknown[]> } }).keyword = {
      findMany: async () => [{ id: "k1", phrase: "best crm", volume: 1000 }],
    } as never;
    const res = await runAutopilotRule(s.db, { workspaceId: "w1", projectId: "p1", ruleId: "rule1", actor: "u1", draftGenerator: stubGen });
    eq(M, "run: keyword_brief with autoApprove ON → 0 auto-approved", res.autoApproved, 0);
    check(M, "run: keyword_brief items stay pending",
      s.itemStore.every((i) => i.status === "pending"));
  }

  // --- rule CRUD validation through the service ---
  {
    const s = statefulDb();
    await createAutopilotRule(s.db, { workspaceId: "w1", projectId: "p1", input: { name: "R", source: "decay_refresh", maxItemsPerRun: 999 } });
    const created = s.calls.find((c) => c.model === "autopilotRule" && c.method === "create");
    eq(M, "service: create clamps maxItemsPerRun to 50",
      (created?.args as { data: { maxItemsPerRun: number } } | undefined)?.data.maxItemsPerRun, 50);
    await throwsAsync(M, "service: create with bad source throws",
      () => createAutopilotRule(s.db, { workspaceId: "w1", projectId: "p1", input: { name: "R", source: "nope" } }), /source/);
  }
  {
    const s = statefulDb();
    (s.db as unknown as { autopilotRule: { findFirst: () => Promise<unknown> } }).autopilotRule.findFirst =
      async () => ({ id: "rule1", projectId: "p1", name: "R", source: "decay_refresh", programmaticTemplateId: null, cadence: "weekly", maxItemsPerRun: 5, autoApprove: false, publishTarget: null, enabled: true });
    await updateAutopilotRule(s.db, { workspaceId: "w1", projectId: "p1", ruleId: "rule1", input: { autoApprove: true } });
    const upd = s.calls.find((c) => c.model === "autopilotRule" && c.method === "update");
    eq(M, "service: partial update flips autoApprove",
      (upd?.args as { data: { autoApproved?: boolean; autoApprove?: boolean } } | undefined)?.data.autoApprove, true);
    await throwsAsync(M, "service: update of missing rule throws",
      () => {
        const s2 = statefulDb();
        (s2.db as unknown as { autopilotRule: { findFirst: () => Promise<unknown> } }).autopilotRule.findFirst = async () => null;
        return updateAutopilotRule(s2.db, { workspaceId: "w1", projectId: "p1", ruleId: "nope", input: { name: "x" } });
      }, /not found/);
  }

  // --- approval gates ---
  {
    const s = statefulDb();
    const pending = { id: "item-1", status: "pending", title: "T", kind: "decay_refresh", runId: "run1", rule: { publishTarget: null } };
    (s.db as unknown as { autopilotItem: { findFirst: () => Promise<unknown> } }).autopilotItem.findFirst = async () => pending;
    await approveAutopilotItem(s.db, { workspaceId: "w1", projectId: "p1", itemId: "item-1", actor: "u1" });
    const upd = s.calls.find((c) => c.model === "autopilotItem" && c.method === "update");
    eq(M, "gate: pending → approved",
      (upd?.args as { data: { status: string } } | undefined)?.data.status, "approved");
    // reject works while killed (approve does not) — documents the asymmetry
    const s2 = statefulDb([{ workspaceId: "w1", projectId: null, scopeKey: "workspace:w1", killed: true }]);
    (s2.db as unknown as { autopilotItem: { findFirst: () => Promise<unknown> } }).autopilotItem.findFirst = async () => pending;
    await rejectAutopilotItem(s2.db, { workspaceId: "w1", projectId: "p1", itemId: "item-1", actor: "u1" });
    const rej = s2.calls.find((c) => c.model === "autopilotItem" && c.method === "update");
    check(M, "gate: reject works while killed (approve is blocked) — documents asymmetry",
      (rej?.args as { data: { status: string } } | undefined)?.data.status === "rejected");
    await throwsAsync(M, "gate: approve of already-approved item throws",
      () => {
        const s3 = statefulDb();
        (s3.db as unknown as { autopilotItem: { findFirst: () => Promise<unknown> } }).autopilotItem.findFirst =
          async () => ({ ...pending, status: "approved" });
        return approveAutopilotItem(s3.db, { workspaceId: "w1", projectId: "p1", itemId: "item-1", actor: "u1" });
      }, /cannot be approved/);
  }
}

// ===========================================================================
// 5. lib/seo/backlinks-cost.ts — budget gate boundaries (pure)
// ===========================================================================
{
  const M = "backlinks-cost";

  eq(M, "cost: pricing constants", BACKLINKS_PRICING, { requestUsd: 0.024, perRowUsd: 0.000036 });
  eq(M, "cost: default cap", DEFAULT_MONTHLY_SPEND_CAP_USD, 25);
  eq(M, "cost: estimate(10000) = 0.024 + 10000*0.000036",
    estimateListPullCost(10000), 0.384);
  eq(M, "cost: estimate(10001) clamped to 10000 rows",
    estimateListPullCost(10001), estimateListPullCost(10000));
  eq(M, "cost: estimate(1)", estimateListPullCost(1), 0.024);
  eq(M, "cost: estimate(0) still bills the request",
    estimateListPullCost(0), 0.024);
  eq(M, "cost: estimate(-5) floored at 0", estimateListPullCost(-5), 0.024);
  eq(M, "cost: estimate(2.9) floors to 2", estimateListPullCost(2.9), 0.0241);
  eq(M, "cost: summary estimate", estimateSummaryPullCost(), 0.024);
  check(M, "cost: estimate(NaN) → NaN (documents gap)", Number.isNaN(estimateListPullCost(NaN)));

  // Boundary: exactly at cap vs one cent over.
  const est100 = estimateListPullCost(100) + estimateSummaryPullCost(); // ≈ 0.0516
  check(M, "cost: full estimate for 100 rows ≈ 0.0516", Math.abs(est100 - 0.0516) < 1e-9, String(est100));
  const atCap = checkPullBudget(100, 0, est100);
  eq(M, "budget: spend exactly AT cap → allowed", atCap.ok, true);
  const overCap = checkPullBudget(100, 0, est100 - 0.01);
  eq(M, "budget: 1 cent over cap → blocked", overCap.ok, false);
  check(M, "budget: over-cap reason names the estimate", (overCap.blockedReason ?? "").includes("0.0516"));
  // used + estimate exactly == cap → allowed (<=); 1e-9 over → blocked.
  const est1 = estimateListPullCost(1) + estimateSummaryPullCost();
  eq(M, "budget: used + estimate exactly == cap → allowed", checkPullBudget(1, 10, 10 + est1).ok, true);
  eq(M, "budget: used + estimate 1e-9 over cap → blocked", checkPullBudget(1, 10, 10 + est1 - 1e-9).ok, false);
  // FIXED (day-1): non-numeric inputs fail CLOSED — NaN comparisons can no
  // longer sail through the gate.
  const nanRes = checkPullBudget(NaN, 0, 25);
  check(M, "FIXED budget: NaN rows are blocked",
    nanRes.ok === false,
    `checkPullBudget(NaN, 0, 25) → ok=${nanRes.ok}, estimatedCostUsd=${nanRes.estimatedCostUsd}`);
  const nanCap = checkPullBudget(500, 5, NaN);
  check(M, "FIXED budget: NaN cap is blocked",
    nanCap.ok === false,
    `checkPullBudget(500, 5, NaN) → ok=${nanCap.ok}`);
  const strCap = checkPullBudget(500, "5" as unknown as number, "x" as unknown as number);
  check(M, "FIXED budget: non-numeric used/cap are blocked",
    strCap.ok === false,
    `checkPullBudget(500, "5", "x") → ok=${strCap.ok}`);
  const infCap = checkPullBudget(500, 0, Number.POSITIVE_INFINITY);
  check(M, "FIXED budget: Infinity cap is blocked",
    infCap.ok === false,
    `checkPullBudget(500, 0, Infinity) → ok=${infCap.ok}`);

  // Row cap boundary: 10000 vs 10001.
  eq(M, "budget: 10000 rows → ok", checkPullBudget(10000, 0, 25).ok, true);
  const over = checkPullBudget(10001, 0, 25);
  eq(M, "budget: 10001 rows → blocked_limit", over.ok, false);
  check(M, "budget: 10001 reason names the 10,000 limit", (over.blockedReason ?? "").includes("10,000"));
  eq(M, "budget: 10001 estimate still computed at cap",
    over.estimatedCostUsd, estimateListPullCost(10000) + estimateSummaryPullCost());

  // Zero / negative caps.
  eq(M, "budget: $0 cap blocks everything", checkPullBudget(1, 0, 0).ok, false);
  eq(M, "budget: negative cap blocks", checkPullBudget(1, 0, -5).ok, false);

  // monthKey: UTC billing boundary (timezone edge).
  eq(M, "monthKey: 2026-09-01T00:30+14:00 is still August in UTC",
    monthKey(new Date("2026-09-01T00:30:00+14:00")), "2026-08");
  eq(M, "monthKey: plain UTC date", monthKey(new Date("2026-03-15T12:00:00Z")), "2026-03");
  check(M, "monthKey: yyyy-mm shape", /^\d{4}-\d{2}$/.test(monthKey()));
}

// ===========================================================================
// 6. lib/seo/internal-links.ts — pure suggestion engine
// ===========================================================================
{
  const M = "internal-links";

  // normalizeInternalUrl edges
  eq(M, "url: empty → ''", normalizeInternalUrl(""), "");
  eq(M, "url: whitespace → ''", normalizeInternalUrl("   "), "");
  eq(M, "url: case + www + trailing slash", normalizeInternalUrl("https://WWW.Example.COM/Blog/"), "example.com/blog");
  eq(M, "url: query + hash stripped", normalizeInternalUrl("https://example.com/a?x=1#y"), "example.com/a");
  eq(M, "url: relative path kept", normalizeInternalUrl("/Blog/"), "/blog");
  eq(M, "url: bare domain gets /", normalizeInternalUrl("https://example.com"), "example.com/");
  eq(M, "url: schemeless host treated as relative path (documents)",
    normalizeInternalUrl("example.com/page"), "/example.com/page");
  eq(M, "url: port dropped", normalizeInternalUrl("https://example.com:8080/x"), "example.com/x");

  // contentTokens edges
  eq(M, "tokens: stopwords ('tips' is one) + short tokens removed",
    [...contentTokens("the best plumbing tips for you")].sort(), ["best", "plumbing"]);
  eq(M, "tokens: naive singularization", [...contentTokens("plumbers")], ["plumber"]);
  eq(M, "tokens: 'ss' words not singularized", [...contentTokens("glass")], ["glass"]);
  eq(M, "tokens: unicode splits tokens (documents)", [...contentTokens("café")], ["caf"]);
  eq(M, "tokens: empty → empty set", contentTokens("").size, 0);
  eq(M, "tokens: numbers kept when ≥3 chars", [...contentTokens("top 100 plumbers")].sort(), ["100", "plumber", "top"]);

  // buildLinkGraph edges
  const g0 = buildLinkGraph([], []);
  eq(M, "graph: empty in/out", g0.pages.size, 0);
  const gDup = buildLinkGraph(
    [
      { url: "https://example.com/Blog", targetKeywords: ["a"], bestRank: 5 },
      { url: "https://example.com/blog", targetKeywords: ["b"], bestRank: 3 },
    ],
    [],
  );
  eq(M, "graph: duplicate normalized urls — last page wins (documents)",
    gDup.pages.get("example.com/blog")?.bestRank, 3);
  const gSelf = buildLinkGraph(
    [{ url: "https://example.com/a", targetKeywords: [], bestRank: null }],
    [{ from: "https://example.com/a", to: "https://example.com/a" }],
  );
  eq(M, "graph: self-links skipped", gSelf.inbound.get("example.com/a")?.size, 0);
  const gExt = buildLinkGraph(
    [
      { url: "https://example.com/a", targetKeywords: [], bestRank: null },
      { url: "https://other.com/b", targetKeywords: [], bestRank: null },
    ],
    [{ from: "https://example.com/a", to: "https://other.com/b" }],
  );
  eq(M, "graph: cross-host edge kept when both pages known",
    gExt.outbound.get("example.com/a")?.has("other.com/b"), true);

  // suggestInternalLinks edges
  eq(M, "suggest: single page → no suggestions",
    suggestInternalLinks([{ url: "https://example.com/a", targetKeywords: [], bestRank: null }], []).length, 0);
  eq(M, "suggest: no pages → none", suggestInternalLinks([], []).length, 0);
  // orphan with no topical overlap → no suggestion (bestSource needs ≥1 token)
  const noOverlap = suggestInternalLinks(
    [
      { url: "https://example.com/plumbing", targetKeywords: ["emergency plumber austin"], bestRank: null },
      { url: "https://example.com/xyz", targetKeywords: [], bestRank: null },
    ],
    [],
  );
  eq(M, "suggest: orphan with zero token overlap gets no suggestion (documents)",
    noOverlap.filter((d) => d.targetUrl === "https://example.com/xyz").length, 0);
  // orphan with exactly 1 shared token: bestSource finds a source but
  // keyword_relevant needs ≥2, so the orphan draft survives with reason=orphan.
  const orphanSug = suggestInternalLinks(
    [
      { url: "https://example.com/a", targetKeywords: ["austin plumber"], bestRank: null },
      { url: "https://example.com/x", targetKeywords: ["plumber xyzzy"], bestRank: null },
    ],
    [],
  );
  check(M, "suggest: orphan surfaced with reason=orphan",
    orphanSug.some((d) => d.reason === "orphan" && d.targetUrl === "https://example.com/a"));
  // high-value underlinked boundary: rank 10 vs 11
  const hv10 = suggestInternalLinks(
    [
      { url: "https://example.com/a", targetKeywords: ["plumber austin"], bestRank: 10 },
      { url: "https://example.com/b", targetKeywords: ["austin plumber"], bestRank: null },
    ],
    [],
  );
  check(M, "suggest: rank exactly 10 counts as high-value",
    hv10.some((d) => d.reason === "high_value_underlinked"));
  const hv11 = suggestInternalLinks(
    [
      { url: "https://example.com/a", targetKeywords: ["plumber austin"], bestRank: 11 },
      { url: "https://example.com/b", targetKeywords: ["austin plumber"], bestRank: null },
    ],
    [],
  );
  check(M, "suggest: rank 11 is not high-value",
    !hv11.some((d) => d.reason === "high_value_underlinked"));
  // keyword_relevant overlap boundary: MIN_TOKEN_OVERLAP = 2
  eq(M, "MIN_TOKEN_OVERLAP is 2", MIN_TOKEN_OVERLAP, 2);
  const kr = suggestInternalLinks(
    [
      { url: "https://example.com/a", targetKeywords: ["austin plumber cost guide"], bestRank: null },
      { url: "https://example.com/b", targetKeywords: ["plumber austin"], bestRank: null },
    ],
    [],
  );
  check(M, "suggest: ≥2 shared tokens → keyword_relevant",
    kr.some((d) => d.reason === "keyword_relevant"));
  // scores within 0..100 and sorted desc, capped at MAX_SUGGESTIONS
  const many = Array.from({ length: 30 }, (_, i) => ({
    url: `https://example.com/p${i}`,
    targetKeywords: [`austin plumber service ${i}`],
    bestRank: null as number | null,
  }));
  const manySug = suggestInternalLinks(many, []);
  check(M, "suggest: scores in 0..100", manySug.every((d) => d.score >= 0 && d.score <= 100));
  check(M, "suggest: sorted desc", manySug.every((d, i) => i === 0 || manySug[i - 1].score >= d.score));
  check(M, "suggest: capped at MAX_SUGGESTIONS", manySug.length <= MAX_SUGGESTIONS);
  // anchor fallback when target has no keywords/title
  const anchorSug = suggestInternalLinks(
    [
      { url: "https://example.com/a", targetKeywords: ["austin plumber"], bestRank: null },
      { url: "https://example.com/b", targetKeywords: ["austin plumber"], bestRank: null },
    ],
    [],
  );
  check(M, "suggest: anchor non-empty", anchorSug.every((d) => d.suggestedAnchor.length > 0));

  // extractInternalHrefs edges
  eq(M, "hrefs: invalid base → []", extractInternalHrefs('<a href="/x">', "not a url"), []);
  eq(M, "hrefs: empty html → []", extractInternalHrefs("", "https://example.com"), []);
  eq(M, "hrefs: skips mailto/tel/javascript",
    extractInternalHrefs('<a href="mailto:a@b.c">x</a><a href="tel:1">y</a><a href="javascript:void(0)">z</a><a href="/ok">w</a>', "https://example.com"),
    ["https://example.com/ok"]);
  eq(M, "hrefs: single-quoted + unquoted",
    extractInternalHrefs("<a href='/s'>a</a><a href=/u>b</a>", "https://example.com").sort(),
    ["https://example.com/s", "https://example.com/u"]);
  eq(M, "hrefs: external host excluded",
    extractInternalHrefs('<a href="https://evil.com/x">e</a>', "https://example.com"), []);
  eq(M, "hrefs: protocol-relative external excluded",
    extractInternalHrefs('<a href="//evil.com/x">e</a>', "https://example.com"), []);
  eq(M, "hrefs: hash-only skipped",
    extractInternalHrefs('<a href="#top">t</a>', "https://example.com"), []);
  eq(M, "hrefs: relative resolved against base",
    extractInternalHrefs('<a href="sub/page">s</a>', "https://example.com/dir/"), ["https://example.com/dir/sub/page"]);
  eq(M, "hrefs: duplicates deduped",
    extractInternalHrefs('<a href="/x">a</a><a href="/x">b</a>', "https://example.com"), ["https://example.com/x"]);

  // projectEdges seam (DB-free part of internal-links-sync)
  eq(M, "sync: projectEdges returns [] (no crawl yet)", await projectEdges("p1"), []);
}

// ===========================================================================
// 7. lib/retention/decay.ts — computeDecay boundaries (pure)
// ===========================================================================
{
  const M = "decay";
  const pt = (daysAgo: number, position: number | null): { checkedAt: Date; position: number | null } => ({
    checkedAt: new Date(Date.UTC(2026, 8, 21 - daysAgo)),
    position,
  });

  let r = computeDecay([]);
  eq(M, "decay: empty history → score 0", r.decayScore, 0);
  eq(M, "decay: empty history currentPosition null", r.currentPosition, null);
  r = computeDecay([pt(2, null), pt(1, null), pt(0, null)]);
  eq(M, "decay: all-null history → 0, not droppedOut", [r.decayScore, r.droppedOut], [0, false]);
  r = computeDecay([pt(1, 3), pt(0, 3)]);
  eq(M, "decay: no movement → 0", r.decayScore, 0);
  eq(M, "decay: no movement positionsLost 0", r.positionsLost, 0);
  // noise boundary: drop of exactly 2 → 0; drop of 3 → scored
  r = computeDecay([pt(1, 1), pt(0, 3)]);
  eq(M, "decay: drop of exactly 2 is noise → 0", r.decayScore, 0);
  r = computeDecay([pt(1, 1), pt(0, 4)]);
  eq(M, "decay: drop of 3 from #1 → 3*8=24", r.decayScore, 24);
  // docstring examples
  r = computeDecay([pt(1, 1), pt(0, 15)]);
  eq(M, "decay: #1→#15 capped at 100", r.decayScore, 100);
  r = computeDecay([pt(1, 5), pt(0, 12)]);
  eq(M, "decay: #5→#12 = 7*5 = 35", r.decayScore, 35);
  r = computeDecay([pt(1, 20), pt(0, 35)]);
  eq(M, "decay: #20→#35 = 15*3 = 45", r.decayScore, 45);
  // multiplier boundaries: peak 3 vs 4, 10 vs 11
  r = computeDecay([pt(1, 3), pt(0, 8)]);
  eq(M, "decay: peak #3 uses ×8", r.decayScore, 40);
  r = computeDecay([pt(1, 4), pt(0, 9)]);
  eq(M, "decay: peak #4 uses ×5", r.decayScore, 25);
  r = computeDecay([pt(1, 10), pt(0, 15)]);
  eq(M, "decay: peak #10 uses ×5", r.decayScore, 25);
  r = computeDecay([pt(1, 11), pt(0, 16)]);
  eq(M, "decay: peak #11 uses ×3", r.decayScore, 15);
  // dropout boundaries: peak 10 → 100, peak 11 → 80
  r = computeDecay([pt(2, 10), pt(1, 12), pt(0, null)]);
  eq(M, "decay: dropped out from peak #10 → 100", [r.decayScore, r.droppedOut], [100, true]);
  r = computeDecay([pt(2, 11), pt(1, 12), pt(0, null)]);
  eq(M, "decay: dropped out from peak #11 → 80", [r.decayScore, r.droppedOut], [80, true]);
  eq(M, "decay: dropped out positionsLost null", r.positionsLost, null);
  // action boundaries: drop 7 → internal_links, 8 → refresh_content, 20 → rebuild
  r = computeDecay([pt(1, 5), pt(0, 12)]);
  eq(M, "decay: drop 7 → internal_links", r.suggestedAction, "internal_links");
  r = computeDecay([pt(1, 5), pt(0, 13)]);
  eq(M, "decay: drop exactly 8 → refresh_content", r.suggestedAction, "refresh_content");
  r = computeDecay([pt(1, 5), pt(0, 25)]);
  eq(M, "decay: drop exactly 20 → rebuild", r.suggestedAction, "rebuild");
  r = computeDecay([pt(1, 30), pt(0, null)]);
  eq(M, "decay: dropped out → rebuild", r.suggestedAction, "rebuild");
  // severity boundaries
  r = computeDecay([pt(1, 1), pt(0, 15)]);
  eq(M, "decay: score 100 → critical", r.severity, "critical");
  r = computeDecay([pt(1, 5), pt(0, 19)]);
  eq(M, "decay: score 70 → critical", [r.decayScore, r.severity], [70, "critical"]);
  r = computeDecay([pt(1, 5), pt(0, 18)]);
  eq(M, "decay: score 65 → warn", [r.decayScore, r.severity], [65, "warn"]);
  r = computeDecay([pt(1, 5), pt(0, 13)]);
  eq(M, "decay: score 40 → warn", [r.decayScore, r.severity], [40, "warn"]);
  r = computeDecay([pt(1, 5), pt(0, 12)]);
  eq(M, "decay: score 35 → info", [r.decayScore, r.severity], [35, "info"]);
  // peak tie → earliest wins
  r = computeDecay([pt(2, 5), pt(1, 3), pt(0, 3)]);
  eq(M, "decay: peak tie → earliest peakAt", r.peakAt?.toISOString(), new Date(Date.UTC(2026, 8, 20)).toISOString());
  // single ranked point among nulls
  r = computeDecay([pt(2, null), pt(1, 7), pt(0, 7)]);
  eq(M, "decay: single ranked point, no drop → 0", r.decayScore, 0);
  // improvement then decay: peak is global best
  r = computeDecay([pt(3, 10), pt(2, 5), pt(1, 8), pt(0, 12)]);
  eq(M, "decay: peak is global best (5), drop 7 → 35", [r.peakPosition, r.decayScore], [5, 35]);
}

// ===========================================================================
// 8. lib/retention/ai-visibility.ts — pure citation/change detection
// ===========================================================================
{
  const M = "ai-visibility";

  const snap = (cites: Array<{ domain?: string; url?: string | null }>) =>
    ({ aiOverviewPresent: true, aiOverviewCitations: cites }) as never;

  eq(M, "cite: exact domain match", detectCitation(snap([{ domain: "example.com", url: "https://example.com/p" }]), "example.com"), { siteCited: true, citedUrl: "https://example.com/p" });
  eq(M, "cite: subdomain counts", detectCitation(snap([{ domain: "blog.example.com" }]), "example.com").siteCited, true);
  eq(M, "cite: different domain", detectCitation(snap([{ domain: "other.com" }]), "example.com"), { siteCited: false, citedUrl: null });
  eq(M, "cite: suffix-lookalike does not match", detectCitation(snap([{ domain: "notexample.com" }]), "example.com").siteCited, false);
  eq(M, "cite: www + case normalized", detectCitation(snap([{ domain: "WWW.Example.COM" }]), "example.com").siteCited, true);
  eq(M, "cite: missing citations array → not cited", detectCitation({ aiOverviewPresent: false } as never, "example.com"), { siteCited: false, citedUrl: null });
  eq(M, "cite: ref without domain skipped", detectCitation(snap([{}]), "example.com").siteCited, false);
  eq(M, "cite: null url → citedUrl null", detectCitation(snap([{ domain: "example.com", url: null }]), "example.com"), { siteCited: true, citedUrl: null });
  eq(M, "cite: empty project domain → false", detectCitation(snap([{ domain: "example.com" }]), ""), { siteCited: false, citedUrl: null });

  eq(M, "change: null previous → appeared", snapshotChanges(null, { aiOverviewPresent: true, siteCited: false }), { appeared: true, disappeared: false, citationGained: false, citationLost: false });
  eq(M, "change: disappeared", snapshotChanges({ aiOverviewPresent: true, siteCited: true }, { aiOverviewPresent: false, siteCited: false }), { appeared: false, disappeared: true, citationGained: false, citationLost: true });
  eq(M, "change: no change", snapshotChanges({ aiOverviewPresent: true, siteCited: true }, { aiOverviewPresent: true, siteCited: true }), { appeared: false, disappeared: false, citationGained: false, citationLost: false });
  eq(M, "change: citation gained while overview persisted", snapshotChanges({ aiOverviewPresent: true, siteCited: false }, { aiOverviewPresent: true, siteCited: true }).citationGained, true);
}

// ===========================================================================
// 9. lib/retention/radar.ts — diffCompetitorSnapshots boundaries (pure)
// ===========================================================================
{
  const M = "radar";
  const kw = (phrase: string, position: number | null, url: string | null = null, volume: number | null = 500) =>
    ({ phrase, position, url, volume });

  // new_keyword: volume boundary 200, position boundary 50
  let ev = diffCompetitorSnapshots(null, [kw("a", 5, "https://c.com/a", 200)], []);
  eq(M, "radar: volume exactly 200 → new_keyword", ev.length, 1);
  ev = diffCompetitorSnapshots(null, [kw("a", 5, "https://c.com/a", 199)], []);
  eq(M, "radar: volume 199 → no event", ev.length, 0);
  ev = diffCompetitorSnapshots(null, [kw("a", 50, "https://c.com/a", 500)], []);
  eq(M, "radar: position exactly 50 considered", ev.length, 1);
  ev = diffCompetitorSnapshots(null, [kw("a", 51, "https://c.com/a", 500)], []);
  eq(M, "radar: position 51 ignored", ev.length, 0);
  ev = diffCompetitorSnapshots(null, [kw("a", null, "https://c.com/a", 500)], []);
  eq(M, "radar: null position ignored", ev.length, 0);
  ev = diffCompetitorSnapshots(null, [kw("a", 5, "https://c.com/a", null)], []);
  eq(M, "radar: null volume → no new_keyword", ev.length, 0);
  // phrase normalization: case-insensitive dedupe
  ev = diffCompetitorSnapshots([kw("Best CRM", 5, "https://c.com/a", 500)], [kw("best crm", 5, "https://c.com/a", 500)], []);
  eq(M, "radar: case-only phrase change → no new_keyword", ev.length, 0);

  // keyword_gain boundaries: ≥10 gain, landing ≤20
  ev = diffCompetitorSnapshots([kw("a", 30, "https://c.com/a", 500)], [kw("a", 20, "https://c.com/a", 500)], []);
  eq(M, "radar: gain exactly 10 into top 20 → keyword_gain",
    ev.map((e) => e.eventType), ["keyword_gain"]);
  ev = diffCompetitorSnapshots([kw("a", 30, "https://c.com/a", 500)], [kw("a", 21, "https://c.com/a", 500)], []);
  eq(M, "radar: gain 9 → no event", ev.length, 0);
  ev = diffCompetitorSnapshots([kw("a", 31, "https://c.com/a", 500)], [kw("a", 21, "https://c.com/a", 500)], []);
  eq(M, "radar: gain 10 but lands at 21 → no event", ev.length, 0);
  ev = diffCompetitorSnapshots([kw("a", 60, "https://c.com/a", 500)], [kw("a", 15, "https://c.com/a", 500)], []);
  eq(M, "radar: climb from outside top-50 into top 20 → keyword_gain",
    ev.map((e) => e.eventType), ["keyword_gain"]);

  // new_page: ≥2 keywords on unseen URL, top 30
  ev = diffCompetitorSnapshots(
    [kw("a", 5, "https://c.com/old", 500), kw("b", 8, "https://c.com/old", 500)],
    [kw("a", 5, "https://c.com/new", 500), kw("b", 8, "https://c.com/new", 500)],
    [],
  );
  eq(M, "radar: unseen URL ×2 keywords → new_page", ev.map((e) => e.eventType), ["new_page"]);
  ev = diffCompetitorSnapshots(
    [kw("a", 5, "https://c.com/old", 500)],
    [kw("a", 5, "https://c.com/new", 500)],
    [],
  );
  eq(M, "radar: unseen URL ×1 keyword → no new_page", ev.length, 0);
  ev = diffCompetitorSnapshots(
    [kw("a", 31, "https://c.com/old", 500), kw("b", 32, "https://c.com/old", 500)],
    [kw("a", 31, "https://c.com/new", 500), kw("b", 32, "https://c.com/new", 500)],
    [],
  );
  eq(M, "radar: unseen URL but positions >30 → no new_page", ev.length, 0);
  // BUG (minor): raw URL string identity — trailing slash makes a "new page"
  ev = diffCompetitorSnapshots(
    [kw("a", 5, "https://c.com/page", 500), kw("b", 8, "https://c.com/page", 500)],
    [kw("a", 5, "https://c.com/page/", 500), kw("b", 8, "https://c.com/page/", 500)],
    [],
  );
  check(M, "radar: trailing-slash-only URL change must not fire new_page",
    !ev.some((e) => e.eventType === "new_page"),
    `got events: ${JSON.stringify(ev.map((e) => e.eventType))} — URL identity is a raw string compare, no normalization`);

  // lost_to_competitor
  ev = diffCompetitorSnapshots(
    [kw("crm", 8, "https://c.com/crm", 900)],
    [kw("crm", 3, "https://c.com/crm", 900)],
    [{ phrase: "crm", current: 5, previous: 5 }],
  );
  eq(M, "radar: competitor newly outranks us → lost_to_competitor",
    ev.map((e) => e.eventType), ["lost_to_competitor"]);
  eq(M, "radar: loss details carry positions",
    (ev[0]?.details as { ourPosition: number; competitorPosition: number }).competitorPosition, 3);
  ev = diffCompetitorSnapshots(
    [kw("crm", 3, "https://c.com/crm", 900)],
    [kw("crm", 3, "https://c.com/crm", 900)],
    [{ phrase: "crm", current: 6, previous: 5 }],
  );
  eq(M, "radar: already losing before → no repeat event", ev.length, 0);
  ev = diffCompetitorSnapshots(
    [kw("crm", 5, "https://c.com/crm", 900)],
    [kw("crm", 5, "https://c.com/crm", 900)],
    [{ phrase: "crm", current: 5, previous: 6 }],
  );
  eq(M, "radar: tie is not a loss", ev.length, 0);
  ev = diffCompetitorSnapshots(
    [],
    [kw("crm", 3, "https://c.com/crm", 900)],
    [{ phrase: "crm", current: null, previous: null }],
  );
  eq(M, "radar: we never ranked + competitor ranks → lost_to_competitor (plus new_keyword; documents)",
    ev.map((e) => e.eventType), ["new_keyword", "lost_to_competitor"]);
  ev = diffCompetitorSnapshots(null, [], []);
  eq(M, "radar: empty latest → no events", ev.length, 0);
}

// ===========================================================================
// 10. lib/retention/visibility-score.ts — pure weight/score/date math
// ===========================================================================
{
  const M = "visibility-score";

  eq(M, "weights: empty → defaults", resolveWeights({}), DEFAULT_WEIGHTS);
  eq(M, "weights: null → defaults", resolveWeights(null), DEFAULT_WEIGHTS);
  eq(M, "weights: undefined → defaults", resolveWeights(undefined), DEFAULT_WEIGHTS);
  eq(M, "weights: negative → default for that key",
    resolveWeights({ rankings: -1 }), { ...DEFAULT_WEIGHTS });
  eq(M, "weights: NaN → default for that key",
    resolveWeights({ aiPresence: NaN }).aiPresence, DEFAULT_WEIGHTS.aiPresence);
  eq(M, "weights: all zeros → defaults", resolveWeights({ rankings: 0, aiPresence: 0, freshness: 0, coverage: 0 }), DEFAULT_WEIGHTS);
  eq(M, "weights: non-number ignored", resolveWeights({ rankings: "high" }), DEFAULT_WEIGHTS);
  eq(M, "weights: extra keys ignored, rankings normalized to 0.667",
    resolveWeights({ rankings: 1, backlinks: 99 } as never).rankings, 0.667);
  const w = resolveWeights({ rankings: 1, aiPresence: 1, freshness: 1, coverage: 1 });
  eq(M, "weights: equal split", w, { rankings: 0.25, aiPresence: 0.25, freshness: 0.25, coverage: 0.25 });
  const w2 = resolveWeights({ rankings: 2, aiPresence: 0, freshness: 0, coverage: 0 });
  eq(M, "weights: single component → 1", w2.rankings, 1);
  const w3 = resolveWeights({ rankings: 1, aiPresence: 2, freshness: 3, coverage: 4 });
  check(M, "weights: normalized ≈ 1",
    Math.abs(w3.rankings + w3.aiPresence + w3.freshness + w3.coverage - 1) < 0.002,
    JSON.stringify(w3));

  eq(M, "combine: all 100 → 100",
    combineScore({ rankings: 100, aiPresence: 100, freshness: 100, coverage: 100, weights: DEFAULT_WEIGHTS }), 100);
  eq(M, "combine: all 0 → 0",
    combineScore({ rankings: 0, aiPresence: 0, freshness: 0, coverage: 0, weights: DEFAULT_WEIGHTS }), 0);
  eq(M, "combine: weighted math",
    combineScore({ rankings: 80, aiPresence: 60, freshness: 40, coverage: 20, weights: DEFAULT_WEIGHTS }), 61);
  eq(M, "combine: rounds to int",
    combineScore({ rankings: 33, aiPresence: 33, freshness: 33, coverage: 33, weights: DEFAULT_WEIGHTS }), 33);

  // dayBucket: DST-safe (UTC). 2026-03-08 is the US spring-forward Sunday.
  eq(M, "dayBucket: UTC midnight",
    dayBucket(new Date("2026-09-21T15:30:00-04:00")).toISOString(), "2026-09-21T00:00:00.000Z");
  eq(M, "dayBucket: DST-transition day buckets correctly",
    dayBucket(new Date("2026-03-08T03:30:00-04:00")).toISOString(), "2026-03-08T00:00:00.000Z");
  eq(M, "dayBucket: late UTC evening rolls to next UTC day",
    dayBucket(new Date("2026-09-21T23:30:00-04:00")).toISOString(), "2026-09-22T00:00:00.000Z");
}

// ===========================================================================
// 11. lib/local/grid.ts — pure geo-grid geometry + summarization
// ===========================================================================
{
  const M = "grid";

  eq(M, "clamp: 1 → 2 (min)", clampGridSize(1), 2);
  eq(M, "clamp: 2 → 2", clampGridSize(2), 2);
  eq(M, "clamp: 9 → 9 (max)", clampGridSize(9), 9);
  eq(M, "clamp: 10 → 9", clampGridSize(10), 9);
  eq(M, "clamp: 0 → 2", clampGridSize(0), 2);
  eq(M, "clamp: -3 → 2", clampGridSize(-3), 2);
  eq(M, "clamp: NaN → 5", clampGridSize(NaN), 5);
  eq(M, "clamp: Infinity → 5", clampGridSize(Infinity), 5);
  eq(M, "clamp: 2.9 → 2", clampGridSize(2.9), 2);

  const cells = generateGridCells(35.0, -80.0, 5, 3);
  eq(M, "grid: 3×3 → 9 cells", cells.length, 9);
  const again = generateGridCells(35.0, -80.0, 5, 3);
  eq(M, "grid: deterministic across calls", cells, again);
  const center = cells.find((c) => c.row === 1 && c.col === 1)!;
  eq(M, "grid: center cell ≈ center", [center.lat, center.lng], [35, -80]);
  const c00 = cells.find((c) => c.row === 0 && c.col === 0)!;
  const c22 = cells.find((c) => c.row === 2 && c.col === 2)!;
  check(M, "grid: symmetric about center",
    Math.abs(c00.lat + c22.lat - 70) < 2e-6 && Math.abs(c00.lng + c22.lng + 160) < 2e-6);
  eq(M, "grid: size 1 clamps to 2×2 (documents dead n===1 branch)",
    generateGridCells(35, -80, 5, 1).length, 4);
  eq(M, "grid: size 10 clamps to 9×9 = 81, throw unreachable (documents)",
    generateGridCells(35, -80, 5, 10).length, 81);
  const tiny = generateGridCells(35, -80, 0, 3);
  check(M, "grid: radius 0 clamped to 0.1mi span",
    Math.abs(tiny[0].lat - 35) < 0.002 && Math.abs(tiny[0].lat - 35) > 0);
  const pole = generateGridCells(90, 0, 5, 3);
  check(M, "grid: north pole — no NaN/Infinity", pole.every((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng)));
  const negR = generateGridCells(35, -80, -5, 3);
  check(M, "grid: negative radius clamped, finite", negR.every((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng)));

  // normalizeBusinessName edges
  eq(M, "biz: apostrophes stripped", normalizeBusinessName("O'Brien Plumbing"), "obrien plumbing");
  eq(M, "biz: symbols → spaces", normalizeBusinessName("AT&T Plumbing!"), "at t plumbing");
  eq(M, "biz: unicode stripped (documents)", normalizeBusinessName("Café Müller"), "caf m ller");
  eq(M, "biz: empty → ''", normalizeBusinessName(""), "");
  eq(M, "biz: whitespace → ''", normalizeBusinessName("   "), "");

  // matchClientPosition edges
  eq(M, "match: empty client → null",
    matchClientPosition([{ businessName: "Acme" }], ""), null);
  eq(M, "match: whitespace client → null",
    matchClientPosition([{ businessName: "Acme" }], "   "), null);
  eq(M, "match: exact (case-insensitive)",
    matchClientPosition([{ businessName: "ACME Plumbing" }], "acme plumbing"), 1);
  eq(M, "match: substring both directions",
    matchClientPosition([{ businessName: "Acme" }], "Acme Plumbing Company"), 1);
  eq(M, "match: token-overlap fallback",
    matchClientPosition([{ businessName: "Acme Plumbing Co" }], "Acme Plumbing"), 1);
  eq(M, "match: absent → null",
    matchClientPosition([{ businessName: "Beta Corp" }], "Acme Plumbing"), null);
  eq(M, "match: skips empty listing names",
    matchClientPosition([{ businessName: "" }, { businessName: "Acme Plumbing" }], "Acme Plumbing"), 2);
  // BUG: substring false positive — "als" is inside "false".
  eq(M, "BUG match: 'Al's' must not match 'False Positive LLC' (substring false positive)",
    matchClientPosition([{ businessName: "False Positive LLC" }], "Al's"), null);

  // summarize/diff edges
  eq(M, "summary: empty → zeros", summarizeGridRun([]), { cells: 0, coveragePct: 0, avgPosition: null });
  eq(M, "summary: none present",
    summarizeGridRun([{ row: 0, col: 0, lat: 0, lng: 0, position: null, topBusiness: null }]),
    { cells: 1, coveragePct: 0, avgPosition: null });
  eq(M, "summary: rounding",
    summarizeGridRun([
      { row: 0, col: 0, lat: 0, lng: 0, position: 1, topBusiness: "a" },
      { row: 0, col: 1, lat: 0, lng: 0, position: 2, topBusiness: "a" },
      { row: 0, col: 2, lat: 0, lng: 0, position: null, topBusiness: "b" },
    ]), { cells: 3, coveragePct: 66.7, avgPosition: 1.5 });
  eq(M, "diff: coverage + position improvement",
    diffGridRuns(
      { cells: 4, coveragePct: 50, avgPosition: 3 },
      { cells: 4, coveragePct: 75, avgPosition: 2 },
    ), { coverageDeltaPct: 25, avgPositionDelta: 1 });
  eq(M, "diff: null avg → null delta",
    diffGridRuns(
      { cells: 4, coveragePct: 50, avgPosition: null },
      { cells: 4, coveragePct: 75, avgPosition: 2 },
    ), { coverageDeltaPct: 25, avgPositionDelta: null });
}

// ===========================================================================
// 12. lib/local/sentiment.ts — heuristic sentiment + themes
// ===========================================================================
{
  const M = "sentiment";

  eq(M, "heur: null/null → neu", heuristicSentiment(null, null), "neu");
  eq(M, "heur: empty text + 5★ → pos (rating prior)", heuristicSentiment("", 5), "pos");
  eq(M, "heur: empty text + 1★ → neg", heuristicSentiment("", 1), "neg");
  eq(M, "heur: empty text + 3★ → neu", heuristicSentiment("", 3), "neu");
  eq(M, "heur: one positive word at 3★ → neu (needs ±2)", heuristicSentiment("amazing", 3), "neu");
  eq(M, "heur: two positive words → pos", heuristicSentiment("amazing wonderful", 3), "pos");
  eq(M, "heur: two negative words → neg", heuristicSentiment("terrible awful", 3), "neg");
  eq(M, "heur: rating exactly 2 → neg prior", heuristicSentiment("", 2), "neg");
  eq(M, "heur: rating exactly 4 → pos prior", heuristicSentiment("", 4), "pos");
  eq(M, "heur: rating 2.5 → no prior (documents)", heuristicSentiment("ok", 2.5), "neu");
  eq(M, "heur: rating 0 → neg prior (documents)", heuristicSentiment("", 0), "neg");
  eq(M, "heur: rating 6 → pos prior (documents)", heuristicSentiment("", 6), "pos");
  eq(M, "heur: negation not handled — 'not great' is neu (documents)",
    heuristicSentiment("not great", 3), "neu");
  eq(M, "heur: emoji-only → neu (documents)", heuristicSentiment("⭐⭐⭐⭐⭐", null), "neu");
  eq(M, "heur: single sentiment word at null rating → neu (needs ±2)", heuristicSentiment("terrible", null), "neu");
  eq(M, "heur: repeated word counts each time",
    heuristicSentiment("great great", 3), "pos");
  eq(M, "heur: 100k-char review does not hang",
    heuristicSentiment("ok ".repeat(50_000), 3), "neu");
  eq(M, "heur: positive cancels negative", heuristicSentiment("great terrible", 3), "neu");

  // classifySentiment: never throws; heuristic path in sandbox
  const c1 = await classifySentiment(null, null);
  check(M, "classify: null → valid shape", ["pos", "neu", "neg"].includes(c1.sentiment));
  const c2 = await classifySentiment("amazing wonderful fantastic", 5);
  if (c2.via === "heuristic") {
    eq(M, "classify: heuristic path matches heuristicSentiment", c2.sentiment, heuristicSentiment("amazing wonderful fantastic", 5));
  } else {
    check(M, "classify: live LLM path returned valid sentiment", ["pos", "neu", "neg"].includes(c2.sentiment));
  }
  const c3 = await classifySentiment("x".repeat(100_000), 1);
  check(M, "classify: 100k chars does not throw", ["pos", "neu", "neg"].includes(c3.sentiment));

  // extractThemes edges
  eq(M, "themes: basic doc frequency",
    extractThemes(["plumber came fast", "fast plumber arrived", "slow service"]), [
      { theme: "fast", count: 2 },
      { theme: "plumber", count: 2 },
    ]);
  eq(M, "themes: min 2 docs", extractThemes(["unique word here", "other words there"]), []);
  eq(M, "themes: limit 8",
    extractThemes(Array.from({ length: 10 }, (_, i) => `theme${i} common`, ).flatMap((t) => [t, t])).length <= 8, true);
  eq(M, "themes: empty → []", extractThemes([]), []);
  eq(M, "themes: all-null → []", extractThemes([null, null]), []);
  eq(M, "themes: ties alphabetical",
    extractThemes(["beta alpha", "alpha beta"]), [
      { theme: "alpha", count: 2 },
      { theme: "beta", count: 2 },
    ]);
  eq(M, "themes: stopwords excluded",
    extractThemes(["the service was great", "great service indeed"]).every((t) => t.theme !== "service" && t.theme !== "the"), true);
  // BUG (minor): docstring says "minus stopwords and sentiment words" — sentiment words are NOT removed.
  const themed = extractThemes(["great service great staff", "great prices great value", "terrible wait terrible food", "terrible staff terrible time"]);
  check(M, "BUG themes: sentiment words must be excluded per docstring",
    themed.every((t) => t.theme !== "great" && t.theme !== "terrible"),
    `got ${JSON.stringify(themed)} — POSITIVE_WORDS/NEGATIVE_WORDS are never filtered despite the docstring`);

  eq(M, "severity: 1 → critical", reviewSeverity(1), "critical");
  eq(M, "severity: 2 → warn", reviewSeverity(2), "warn");
  eq(M, "severity: 3 → info", reviewSeverity(3), "info");
  eq(M, "severity: null → info", reviewSeverity(null), "info");
  eq(M, "severity: 5 → info", reviewSeverity(5), "info");
  eq(M, "severity: 0 → info (documents)", reviewSeverity(0), "info");
}

// ===========================================================================
// 13. lib/seo/backlink-pull.ts — orchestration with a patched prisma singleton
//     (in-memory fakes; no DB, no network — the sandbox has no DataForSEO
//     keys, so getSeoProvider() would return the mock provider, but every
//     test below passes an explicit fake provider for determinism).
// ===========================================================================
{
  const M = "backlink-pull";
  const P = prisma as unknown as Record<string, any>;
  const pulls: Array<Record<string, any>> = [];
  const backlinks: Array<Record<string, any>> = [];
  let aggSum: number | null = 0;
  let cap: number | null = 25;
  let findManyCalls = 0;
  P.backlinkPull = {
    create: async (a: { data: Record<string, any> }) => {
      const row = { id: `pull-${pulls.length + 1}`, ...a.data };
      pulls.push(row);
      return row;
    },
    aggregate: async () => ({ _sum: { actualCostUsd: aggSum } }),
  };
  P.workspace = { findUnique: async () => ({ backlinksSpendCapUsd: cap }) };
  P.fileChangeLog = { create: async () => ({ id: "log-1" }) };
  P.backlink = {
    findUnique: async (a: any) => {
      const w = a.where.projectId_sourceUrl_targetUrl;
      return backlinks.find(
        (b) => b.projectId === w.projectId && b.sourceUrl === w.sourceUrl && b.targetUrl === w.targetUrl,
      ) ?? null;
    },
    create: async (a: { data: Record<string, any> }) => {
      const row = { id: `bl-${backlinks.length + 1}`, ...a.data };
      backlinks.push(row);
      return row;
    },
    update: async (a: any) => {
      const b = backlinks.find((x) => x.id === a.where.id);
      if (!b) throw new Error("backlink row not found");
      Object.assign(b, a.data);
      return b;
    },
    findMany: async (a: any) => {
      findManyCalls++;
      return backlinks.filter((b) => b.projectId === a.where.projectId && b.status === a.where.status);
    },
    count: async (a: any) =>
      backlinks.filter((b) => b.projectId === a.where.projectId && b.status === a.where.status).length,
  };
  P.backlinkSummary = { upsert: async (a: any) => ({ ...a.create }) };

  const fakeProvider = (over: Record<string, any>) =>
    ({ name: "fake", isLive: true, isConfigured: () => true, ...over }) as never;
  const okSummary = () => ({ total: 1, mock: true }) as never;
  const reset = () => { pulls.length = 0; backlinks.length = 0; aggSum = 0; cap = 25; findManyCalls = 0; };

  // monthlyBacklinkSpendUsd: null sum → 0; rounds to 4dp.
  reset();
  aggSum = null;
  eq(M, "spend: null sum → 0", await monthlyBacklinkSpendUsd("w1"), 0);
  aggSum = 1.23456;
  eq(M, "spend: rounds to 4dp", await monthlyBacklinkSpendUsd("w1"), 1.2346);

  // preview: target normalization + row flooring (mock provider → free, never blocked).
  reset();
  const pv = await previewBacklinkPull("w1", "p1", "https://WWW.Example.COM/some/path?q=1", 2.9);
  eq(M, "preview: target cleaned", pv.target, "example.com");
  eq(M, "preview: rows floored", pv.rowsRequested, 2);
  eq(M, "preview: mock provider is free", [pv.estimatedCostUsd, pv.withinCap, pv.blockedReason], [0, true, null]);
  eq(M, "preview: writes a preview pull row", pulls[0]?.status, "preview");
  const pv1 = await previewBacklinkPull("w1", "p1", "example.com", 0);
  eq(M, "preview: 0 rows → max(1, 0) = 1", pv1.rowsRequested, 1);

  // run: hard row cap — rejected BEFORE any provider call.
  reset();
  let providerCalled = false;
  const neverProvider = fakeProvider({
    backlinks: async () => { providerCalled = true; throw new Error("must not be called"); },
    backlinksSummary: async () => { providerCalled = true; throw new Error("must not be called"); },
  });
  const over = await runBacklinkPull({ workspaceId: "w1", projectId: "p1", target: "example.com", limit: 10001, actor: "user", provider: neverProvider });
  eq(M, "run: 10001 rows → blocked_limit", over.status, "blocked_limit");
  check(M, "run: provider never called on blocked_limit", !providerCalled);
  check(M, "run: blocked_limit note names the 10,000 cap", (over.note ?? "").includes("10,000"));
  eq(M, "run: blocked_limit estimate computed at cap",
    over.estimatedCostUsd, estimateListPullCost(10000) + estimateSummaryPullCost());
  eq(M, "run: blocked pull row recorded", [pulls[0]?.status, pulls[0]?.rowsReturned], ["blocked_limit", 0]);

  // run: $0 spend cap blocks before any provider call.
  reset();
  cap = 0;
  const capped = await runBacklinkPull({ workspaceId: "w1", projectId: "p1", target: "example.com", limit: 10, actor: "user", provider: neverProvider });
  eq(M, "run: $0 cap → blocked_cap", capped.status, "blocked_cap");
  check(M, "run: provider never called on blocked_cap", !providerCalled);
  // null/negative workspace caps fall back to the default $25 → pull proceeds.
  for (const c of [null, -5]) {
    reset();
    cap = c;
    let called = false;
    const p = fakeProvider({
      backlinks: async () => { called = true; return { items: [], rowsReturned: 0, totalCount: 0, mock: true }; },
      backlinksSummary: async () => ({ total: 0, mock: true }),
    });
    const r = await runBacklinkPull({ workspaceId: "w1", projectId: "p1", target: "example.com", limit: 10, actor: "user", provider: p });
    check(M, `run: workspace cap ${c} → default $25, pull proceeds`, r.status === "completed" && called);
  }

  // run: provider failure → status failed, estimate preserved, pull row written.
  reset();
  const boomProvider = fakeProvider({
    backlinks: async () => { throw new Error("boom-500 provider exploded"); },
    backlinksSummary: async () => okSummary(),
  });
  const failed = await runBacklinkPull({ workspaceId: "w1", projectId: "p1", target: "example.com", limit: 10, actor: "cron", provider: boomProvider });
  eq(M, "run: provider throw → failed", failed.status, "failed");
  eq(M, "run: failed note carries the error", failed.note, "boom-500 provider exploded");
  eq(M, "run: failed keeps the estimate",
    failed.estimatedCostUsd, estimateListPullCost(10) + estimateSummaryPullCost());
  eq(M, "run: failed pull row recorded", pulls[0]?.status, "failed");

  // run: malformed items (missing source/target URL) are skipped, not stored.
  reset();
  const mixedProvider = fakeProvider({
    backlinks: async () => ({
      items: [
        { sourceDomain: "a.com", sourceUrl: "https://a.com/p", targetUrl: "https://example.com/", anchorText: "x", dofollow: true, firstSeen: "not-a-date", lastSeen: null, sourceRank: 10, spamScore: 1 },
        { sourceDomain: "b.com", sourceUrl: "", targetUrl: "https://example.com/", anchorText: null, dofollow: false, firstSeen: null, lastSeen: null, sourceRank: null, spamScore: null },
        { sourceDomain: "c.com", sourceUrl: "https://c.com/p", targetUrl: null, anchorText: null, dofollow: false, firstSeen: null, lastSeen: null, sourceRank: null, spamScore: null },
      ],
      rowsReturned: 3,
      totalCount: 3,
      mock: true,
    }),
    backlinksSummary: async () => ({ total: 3, mock: true }),
  });
  const mixed = await runBacklinkPull({ workspaceId: "w1", projectId: "p1", target: "example.com", limit: 100, actor: "user", provider: mixedProvider });
  eq(M, "run: malformed items skipped", [mixed.status, mixed.newLinks, mixed.rowsReturned], ["completed", 1, 3]);
  eq(M, "run: only the valid link stored", backlinks.length, 1);
  check(M, "run: invalid firstSeen falls back to now (Date)",
    backlinks[0]?.firstSeen instanceof Date && !isNaN(backlinks[0].firstSeen.getTime()));
  eq(M, "run: mock pull actual cost $0", mixed.actualCostUsd, 0);
  eq(M, "run: full coverage → lostMarked, note null", [mixed.lostMarked, mixed.note], [true, null]);

  // run: lost-link detection on a complete pull; low-rank lost link → no alert.
  reset();
  backlinks.push({ id: "bl-old", projectId: "p1", sourceDomain: "old.com", sourceUrl: "https://old.com/x", targetUrl: "https://example.com/", status: "active", sourceRank: 100 });
  const lostProvider = fakeProvider({
    backlinks: async () => ({
      items: [
        { sourceDomain: "new.com", sourceUrl: "https://new.com/y", targetUrl: "https://example.com/", anchorText: null, dofollow: true, firstSeen: null, lastSeen: null, sourceRank: 5, spamScore: 0 },
      ],
      rowsReturned: 1,
      totalCount: 1,
      mock: true,
    }),
    backlinksSummary: async () => ({ total: 1, mock: true }),
  });
  const lost = await runBacklinkPull({ workspaceId: "w1", projectId: "p1", target: "example.com", limit: 100, actor: "user", provider: lostProvider });
  eq(M, "run: absent-on-complete-pull link marked lost", [lost.lostLinks, backlinks.find((b) => b.id === "bl-old")?.status], [1, "lost"]);
  eq(M, "run: rank < 500 → no alert", lost.alertsEmitted, 0);
  eq(M, "run: new link counted", lost.newLinks, 1);

  // run: partial pull → lost marking skipped even with a candidate; findMany untouched.
  reset();
  backlinks.push({ id: "bl-old", projectId: "p1", sourceDomain: "old.com", sourceUrl: "https://old.com/x", targetUrl: "https://example.com/", status: "active", sourceRank: 100 });
  const partialProvider = fakeProvider({
    backlinks: async () => ({
      items: [
        { sourceDomain: "new.com", sourceUrl: "https://new.com/y", targetUrl: "https://example.com/", anchorText: null, dofollow: true, firstSeen: null, lastSeen: null, sourceRank: 5, spamScore: 0 },
      ],
      rowsReturned: 2,
      totalCount: 100,
      mock: true,
    }),
    backlinksSummary: async () => ({ total: 100, mock: true }),
  });
  const partial = await runBacklinkPull({ workspaceId: "w1", projectId: "p1", target: "example.com", limit: 2, actor: "user", provider: partialProvider });
  eq(M, "run: partial pull → no lost marking", [partial.lostLinks, partial.lostMarked], [0, false]);
  eq(M, "run: partial pull → candidate lookup skipped", findManyCalls, 0);
  eq(M, "run: partial pull → still active", backlinks.find((b) => b.id === "bl-old")?.status, "active");
  eq(M, "run: partial pull note", partial.note, "Partial pull — lost-link marking skipped.");
}

// ===========================================================================
// Summary
// ===========================================================================
{
  const order = [
    "programmatic",
    "programmatic-publish",
    "autopilot",
    "autopilot-service",
    "backlinks-cost",
    "backlink-pull",
    "internal-links",
    "decay",
    "ai-visibility",
    "radar",
    "visibility-score",
    "grid",
    "sentiment",
  ];
  let tRun = 0, tPass = 0, tFail = 0;
  console.log("\n=== edge-seo-growth: per-module results ===");
  console.log("module                |  run | passed | failed");
  console.log("----------------------+------|--------|-------");
  for (const m of order) {
    const s = mod(m);
    tRun += s.run; tPass += s.passed; tFail += s.failed;
    console.log(`${m.padEnd(21)} | ${String(s.run).padStart(4)} | ${String(s.passed).padStart(6)} | ${String(s.failed).padStart(6)}`);
  }
  console.log("----------------------+------|--------|-------");
  console.log(`${"TOTAL".padEnd(21)} | ${String(tRun).padStart(4)} | ${String(tPass).padStart(6)} | ${String(tFail).padStart(6)}`);
  if (failures.length > 0) {
    console.log("\nFailures (each is a filed bug — see report):");
    for (const f of failures) console.log(`- ${f}\n`);
    process.exit(1);
  }
}
