// Marketr milestone 17 (push addendum) — fixture tests for pushing
// programmatic pages through the existing connectors.
// Pure functions + mock connectors only: no database, no network.
//
// Run: npx tsx scripts/verify-m17-push.mts

import {
  buildHeadMeta,
  buildSiteHtml,
  classifyPush,
  isPublishTarget,
  resolveDestination,
  siteFilePathForUrl,
  webflowFieldDataForPage,
  PUBLISH_TARGETS,
  type ResolvedDestination,
} from "@/lib/seo/programmatic-publish";
import { evaluateGates, QUALITY_FLAGS } from "@/lib/seo/programmatic";
import { MockWordPressConnector } from "@/lib/connectors/mock-wordpress";
import { MockWebflowConnector } from "@/lib/connectors/mock-webflow";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function eq(actual: unknown, expected: unknown, name: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

function ok(cond: boolean, name: string) {
  if (cond) passed++;
  else {
    failed++;
    failures.push(`${name}\n  condition was false`);
  }
}

// ---------------------------------------------------------------------------
// 1. Target validation
// ---------------------------------------------------------------------------
ok(isPublishTarget("wordpress"), "isPublishTarget accepts wordpress");
ok(isPublishTarget("webflow"), "isPublishTarget accepts webflow");
ok(isPublishTarget("marketr-site"), "isPublishTarget accepts marketr-site");
ok(isPublishTarget("csv"), "isPublishTarget accepts csv");
ok(isPublishTarget("none"), "isPublishTarget accepts none");
ok(!isPublishTarget("ftp"), "isPublishTarget rejects ftp");
ok(!isPublishTarget(""), "isPublishTarget rejects empty string");
ok(!isPublishTarget(null), "isPublishTarget rejects null");
eq([...PUBLISH_TARGETS], ["none", "csv", "wordpress", "webflow", "marketr-site"], "PUBLISH_TARGETS lists all five");

// ---------------------------------------------------------------------------
// 2. Destination resolution precedence: explicit > page > template
// ---------------------------------------------------------------------------
const page = { publishTarget: "wordpress", targetSiteId: "site-wp", webflowCollectionId: null };
const tpl = { defaultPublishTarget: "webflow", defaultTargetSiteId: "site-wf", defaultWebflowCollectionId: "col-x" };

eq(
  resolveDestination({ explicit: { target: "marketr-site", siteId: "site-ms" }, page, template: tpl }),
  { kind: "marketr-site", siteId: "site-ms", collectionId: "col-x" },
  "explicit target beats page and template",
);
eq(
  resolveDestination({ page, template: tpl }),
  { kind: "wordpress", siteId: "site-wp", collectionId: "col-x" },
  "page override beats template default; missing page value inherits template",
);
eq(
  resolveDestination({ page: { publishTarget: "none", targetSiteId: null, webflowCollectionId: null }, template: tpl }),
  { kind: "webflow", siteId: "site-wf", collectionId: "col-x" },
  "page 'none' inherits the template default",
);
eq(
  resolveDestination({
    page: { publishTarget: "none", targetSiteId: null, webflowCollectionId: null },
    template: { defaultPublishTarget: "none", defaultTargetSiteId: null, defaultWebflowCollectionId: null },
  }),
  { kind: "none", siteId: null, collectionId: null },
  "unset everywhere resolves to 'none'",
);
eq(
  resolveDestination({ page: { publishTarget: "wordpress", targetSiteId: null, webflowCollectionId: null }, template: tpl }),
  { kind: "wordpress", siteId: "site-wf", collectionId: "col-x" },
  "page target inherits the template site when the page has none",
);
eq(
  resolveDestination({ explicit: { target: "webflow" }, page, template: tpl }),
  { kind: "webflow", siteId: "site-wp", collectionId: "col-x" },
  "partial explicit override keeps page/template site and collection",
);

// ---------------------------------------------------------------------------
// 3. Payload mapping
// ---------------------------------------------------------------------------
const head = buildHeadMeta({
  description: 'Plumbers in "Austin" & <Dallas>',
  canonical: "https://example.com/services/austin/plumbing",
  noindex: true,
});
ok(head.includes('<meta name="description" content="Plumbers in &quot;Austin&quot; &amp; &lt;Dallas&gt;">'), "head meta: description escaped");
ok(head.includes('<link rel="canonical" href="https://example.com/services/austin/plumbing">'), "head meta: canonical");
ok(head.includes('<meta name="robots" content="noindex, follow">'), "head meta: noindex robots");

const headIndexable = buildHeadMeta({ description: "d", canonical: null, noindex: false });
ok(!headIndexable.includes("robots"), "head meta: no robots tag when indexable");
ok(!headIndexable.includes("canonical"), "head meta: no canonical tag when canonical is null");

const doc = buildSiteHtml({
  title: "Plumbing in Austin <script>",
  description: "d",
  canonical: "https://example.com/x",
  noindex: false,
  bodyHtml: "<h1>Hi</h1>",
});
ok(doc.startsWith("<!DOCTYPE html>"), "site html: doctype");
ok(doc.includes("<title>Plumbing in Austin &lt;script&gt;</title>"), "site html: title escaped");
ok(doc.includes('<meta name="description" content="d">'), "site html: meta included");
ok(doc.includes('<link rel="canonical" href="https://example.com/x">'), "site html: canonical included");
ok(doc.includes("<h1>Hi</h1>"), "site html: body included");

eq(siteFilePathForUrl("/services/austin/plumbing"), "/services/austin/plumbing.html", "site path mapping");
eq(siteFilePathForUrl("/services/austin/plumbing/"), "/services/austin/plumbing.html", "site path mapping strips trailing slash");

const wfJson = webflowFieldDataForPage({ title: "Plumbing in Austin", slug: "plumbing", metaHtml: head, bodyHtml: "<h1>Hi</h1>" });
const wf = JSON.parse(wfJson) as Record<string, string>;
eq(wf.name, "Plumbing in Austin", "webflow: name field");
eq(wf.slug, "plumbing", "webflow: slug field");
ok(wf["page-html"].startsWith(head), "webflow: meta prepended to page-html");
ok(wf["page-html"].includes("<h1>Hi</h1>"), "webflow: body in page-html");
ok(Object.keys(wf).sort().join(",") === "name,page-html,slug", "webflow: only the existing convention fields");

// ---------------------------------------------------------------------------
// 4. Idempotency (classifyPush)
// ---------------------------------------------------------------------------
const wpDest: ResolvedDestination = { kind: "wordpress", siteId: "site-wp", collectionId: null };
const wfDest: ResolvedDestination = { kind: "webflow", siteId: "site-wf", collectionId: "col-x" };

eq(
  classifyPush({ status: "ready", publishTarget: "none", targetSiteId: null, externalId: null, dest: wpDest }),
  { mode: "create", blockedReason: null },
  "ready page → create",
);
eq(
  classifyPush({ status: "draft", publishTarget: "none", targetSiteId: null, externalId: null, dest: wpDest }),
  { mode: "create", blockedReason: null },
  "draft page → create",
);
eq(
  classifyPush({ status: "published", publishTarget: "wordpress", targetSiteId: "site-wp", externalId: "wp-123", dest: wpDest }),
  { mode: "update", blockedReason: null },
  "re-push to the same target+site+externalId updates in place",
);
{
  const c = classifyPush({ status: "published", publishTarget: "wordpress", targetSiteId: "site-wp", externalId: "wp-123", dest: wfDest });
  eq(c.mode, "create", "re-push to a different target is not an update");
  ok(c.blockedReason !== null && c.blockedReason.includes("wordpress"), "different-target republish is blocked with the original target named");
}
{
  const c = classifyPush({ status: "published", publishTarget: "wordpress", targetSiteId: "site-wp", externalId: null, dest: wpDest });
  ok(c.blockedReason !== null, "published without a stored externalId cannot update in place");
}
{
  const c = classifyPush({ status: "published", publishTarget: "wordpress", targetSiteId: "site-old", externalId: "wp-123", dest: wpDest });
  ok(c.blockedReason !== null && c.blockedReason.includes("wordpress"), "same target kind but a different site is blocked (no silent cross-site duplicates)");
}
{
  const c = classifyPush({ status: "discarded", publishTarget: "none", targetSiteId: null, externalId: null, dest: wpDest });
  ok(c.blockedReason !== null && c.blockedReason.includes("discarded"), "discarded pages cannot be pushed");
}
{
  const c = classifyPush({ status: "published", publishTarget: "none", targetSiteId: null, externalId: null, dest: wpDest });
  ok(c.blockedReason !== null, "page published internally (csv/none) then pushed to a connector is blocked");
}

// ---------------------------------------------------------------------------
// 5. Quality-gate enforcement (the exact gate fn the push path calls)
// ---------------------------------------------------------------------------
const clean = {
  flags: [] as string[],
  missingVariables: [] as string[],
  wordCount: 500,
  minWordCount: 300,
  templateDuplicateRate: 0.01,
  duplicateRateCap: 0.05,
  checkDuplicateRate: true,
};
eq(evaluateGates(clean).pass, true, "gates pass on a clean page");

eq(
  evaluateGates({ ...clean, flags: [QUALITY_FLAGS.missingVariable], missingVariables: ["city"] }).pass,
  false,
  "gates block missing variables",
);
eq(
  evaluateGates({ ...clean, flags: [QUALITY_FLAGS.thinContent], wordCount: 120 }).pass,
  false,
  "gates block thin content",
);
eq(
  evaluateGates({ ...clean, flags: [QUALITY_FLAGS.duplicateContent] }).pass,
  false,
  "gates block duplicate content",
);
eq(
  evaluateGates({ ...clean, flags: [QUALITY_FLAGS.slugCollision] }).pass,
  false,
  "gates block slug collision",
);
eq(
  evaluateGates({ ...clean, templateDuplicateRate: 0.12 }).pass,
  false,
  "gates block duplicate rate over the cap",
);
ok(
  evaluateGates({ ...clean, templateDuplicateRate: 0.12 }).reasons.join(" ").includes("12.0%"),
  "duplicate-rate gate names the offending rate",
);

// ---------------------------------------------------------------------------
// 6. Mock connector create/update semantics (mock-only, no network)
// ---------------------------------------------------------------------------
{
  const wp = new MockWordPressConnector({ baseUrl: "https://demo-wp.local", username: "x", password: "y" } as never);
  const created = await wp.saveContent("page", { title: "Plumbing in Austin", slug: "plumbing", content: "<h1>Hi</h1>", status: "publish" });
  ok(created.mock === true, "wordpress mock: created page flagged mock");
  ok(typeof created.id === "string" && created.id.length > 0, "wordpress mock: created page has an id");
  ok(created.link !== undefined && created.link !== null && created.link.length > 0, "wordpress mock: created page has a link");
  const updated = await wp.saveContent("page", { id: created.id, title: "Plumbing in Austin (v2)", slug: "plumbing", content: "<h1>Hi v2</h1>", status: "publish" });
  eq(updated.id, created.id, "wordpress mock: update with the same id updates in place (no duplicate)");
  ok(updated.title.includes("v2"), "wordpress mock: update replaces the content");
}

{
  const wf = new MockWebflowConnector({ token: "mock", siteId: "site-wf" } as never);
  const created = await wf.saveContent(
    "item",
    { title: "Plumbing in Austin", slug: "plumbing", content: webflowFieldDataForPage({ title: "Plumbing in Austin", slug: "plumbing", metaHtml: head, bodyHtml: "<h1>Hi</h1>" }), status: "publish", collectionId: "col-landing" },
    { collectionId: "col-landing" },
  );
  ok(created.mock === true, "webflow mock: created item flagged mock");
  ok(typeof created.id === "string" && created.id.length > 0, "webflow mock: created item has an id");
  const updated = await wf.saveContent(
    "item",
    { id: created.id, title: "Plumbing in Austin", slug: "plumbing", content: webflowFieldDataForPage({ title: "Plumbing in Austin", slug: "plumbing", metaHtml: head, bodyHtml: "<h1>Hi v2</h1>" }), status: "publish", collectionId: "col-landing" },
    { collectionId: "col-landing" },
  );
  eq(updated.id, created.id, "webflow mock: update with the same id updates in place (no duplicate)");
}

// ---------------------------------------------------------------------------
console.log(`\nverify-m17-push: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`- ${f}\n`);
  process.exit(1);
}
