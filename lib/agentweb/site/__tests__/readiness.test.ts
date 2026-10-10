// Phase 21A (WS=agentweb): the agent-readiness audit. Extends the Phase 10/11 SEO
// checks (structured-data validity, robots/sitemap) with what agents need: llms.txt,
// an AI-usage policy, schema.org actions, WebMCP forms, NLWeb/MCP, an API
// description, labelled controls, machine-readable contact. Plus the question the
// owner actually cares about: can an agent complete this site's top tasks, and
// through which channel? Run here on fixtures, never on the live web.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assessReadiness, type ReadinessInput } from "../readiness";
import { addPotentialActions, annotateForms, findForms, potentialActions } from "../actions";
import { buildLlmsTxt } from "../llmstxt";
import { applyAiPolicy } from "../robots-ai";
import { askSite } from "../nlweb";
import { docsFromHtml } from "../corpus";
import { generateJsonLd } from "@/lib/seo/jsonld";

const ORIGIN = "https://riverside.test";

const HOME = `<!doctype html><html lang="en"><head><title>Riverside Dental</title></head><body>
<h1>Riverside Dental</h1><p>A family practice. Call <a href="tel:01234567890">01234 567890</a>.</p></body></html>`;
const CONTACT = `<!doctype html><html lang="en"><head><title>Contact</title></head><body><h1>Contact</h1>
<form action="/contact" method="post">
  <label for="n">Name</label><input id="n" name="name" required>
  <label for="e">Email</label><input id="e" name="email" type="email" required>
  <label for="m">Message</label><textarea id="m" name="message"></textarea>
  <button type="submit">Send</button>
</form></body></html>`;
const BOOK = `<!doctype html><html lang="en"><head><title>Book</title></head><body><h1>Book</h1>
<form action="/book" method="post"><label for="d">Date</label><input id="d" name="date" type="date" required><button>Book an appointment</button></form></body></html>`;

const bare = (): ReadinessInput => ({
  origin: ORIGIN,
  endpoints: true,
  pages: [
    { path: "/index.html", html: HOME },
    { path: "/contact.html", html: CONTACT },
    { path: "/book.html", html: BOOK },
  ],
  files: {},
});

/** The bare site after every emitter has run (what the Agent readiness draft produces). */
function enriched(opts: { endpoints?: boolean } = {}): ReadinessInput {
  const endpoints = opts.endpoints ?? true;
  const base = bare();
  const site = "Riverside Dental";
  const tasks = base.pages.flatMap((p) =>
    findForms(p.html)
      .filter((f) => f.kind)
      .map((f) => ({ kind: f.kind!, target: new URL(f.action, ORIGIN).toString(), method: f.method })),
  );
  const org = addPotentialActions(
    generateJsonLd("Organization", { name: site, url: `${ORIGIN}/`, email: "hello@riverside.test", telephone: "01234 567890" }),
    potentialActions(tasks, site),
  );
  const links = endpoints ? `<link rel="nlweb" href="/ask"><link rel="mcp" href="/mcp">` : "";
  const pages = base.pages.map((p) => {
    let html = annotateForms(p.html, { siteName: site }).html;
    if (p.path === "/index.html") html = html.replace("</head>", `${links}<script type="application/ld+json">${JSON.stringify(org)}</script></head>`);
    return { path: p.path, html };
  });
  const files: ReadinessInput["files"] = {
    "/llms.txt": { status: 200, body: buildLlmsTxt({ name: site, summary: "A family dental practice.", sections: [{ title: "Pages", links: [{ title: "Contact", url: `${ORIGIN}/contact` }] }] }) },
    "/robots.txt": { status: 200, body: applyAiPolicy(null, { search: true, input: true, train: false }, { sitemapUrl: `${ORIGIN}/sitemap.xml` }) },
    "/sitemap.xml": { status: 200, body: `<urlset><url><loc>${ORIGIN}/</loc></url></urlset>` },
  };
  if (endpoints) files["/ask?query=ping"] = { status: 200, body: JSON.stringify(askSite(docsFromHtml(pages, ORIGIN), { name: site, origin: ORIGIN }, { query: "ping" })) };
  return { origin: ORIGIN, endpoints, pages, files };
}

describe("assessReadiness: a bare site", () => {
  const r = assessReadiness(bare());

  it("scores low and lists every fix, biggest first", () => {
    assert.ok(r.score < 25, `score ${r.score}`);
    assert.ok(r.fixes.length >= 7);
    assert.ok(r.fixes.every((f, i) => i === 0 || r.fixes[i - 1].points >= f.points));
    assert.ok(r.fixes.every((f) => f.points > 0 && f.text.length > 10));
  });

  it("can still complete its tasks, but only by driving the page", () => {
    const by = Object.fromEntries(r.tasks.map((t) => [t.kind, t]));
    assert.equal(by.contact.channel, "a11y-tree");
    assert.equal(by.booking.channel, "a11y-tree");
    assert.ok(by.contact.can && by.booking.can);
    assert.match(by.contact.note, /browser/i);
  });

  it("weights add up to 100 when every check applies", () => {
    assert.equal(r.checks.reduce((s, c) => s + c.weight, 0), 100);
  });
});

describe("assessReadiness: after the emitters", () => {
  const r = assessReadiness(enriched());

  it("scores 90 or more (the OpenAPI point is the one a service site rarely has)", () => {
    assert.ok(r.score >= 90, `score ${r.score}: ${r.fixes.map((f) => f.id).join(",")}`);
    assert.deepEqual(r.fixes.map((f) => f.id), ["openapi"]);
  });

  it("completes the tasks through declared tools, with the ask endpoint for questions", () => {
    const by = Object.fromEntries(r.tasks.map((t) => [t.kind, t]));
    assert.equal(by.contact.channel, "declared-tools");
    assert.equal(by.booking.channel, "declared-tools");
    assert.equal(by.ask.channel, "declared-tools");
    assert.match(by.ask.via, /nlweb/i);
  });

  it("never rewards auto-submit: it is called out as a risk", () => {
    const input = enriched();
    input.pages = input.pages.map((p) => ({ ...p, html: p.html.replace('toolname="contact_us"', 'toolname="contact_us" toolautosubmit') }));
    const risky = assessReadiness(input);
    const c = risky.checks.find((x) => x.id === "webmcp-forms")!;
    assert.ok(c.earned! < c.weight);
    assert.match(c.detail, /auto-?submit/i);
    assert.ok(risky.score < r.score);
  });
});

describe("assessReadiness: sites that cannot run endpoints", () => {
  it("marks NLWeb/MCP not applicable and rescales instead of failing a static site for it", () => {
    const r = assessReadiness(enriched({ endpoints: false }));
    const c = r.checks.find((x) => x.id === "nlweb-mcp")!;
    assert.equal(c.status, "na");
    assert.equal(c.earned, null);
    assert.ok(r.score >= 90, `score ${r.score}`);
  });
});

describe("assessReadiness: individual checks", () => {
  const check = (input: ReadinessInput, id: string) => assessReadiness(input).checks.find((c) => c.id === id)!;

  it("flags a robots.txt that blocks every crawler", () => {
    const input = enriched();
    input.files["/robots.txt"] = { status: 200, body: "User-agent: *\nDisallow: /\n" };
    const c = check(input, "robots-ai");
    assert.equal(c.status, "fail");
    assert.match(c.detail, /every crawler|all crawlers/i);
  });

  it("gives partial credit for a robots.txt that says nothing about AI use", () => {
    const input = enriched();
    input.files["/robots.txt"] = { status: 200, body: "User-agent: *\nAllow: /\n" };
    const c = check(input, "robots-ai");
    assert.equal(c.status, "partial");
    assert.equal(c.earned, 5);
  });

  it("invalid JSON-LD is partial, with the page named", () => {
    const input = enriched();
    input.pages[1] = { path: "/contact.html", html: `${input.pages[1].html}<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product"}</script>` };
    const c = check(input, "jsonld");
    assert.equal(c.status, "partial");
    assert.match(c.detail, /contact\.html/);
  });

  it("unlabelled form fields reduce the labels check", () => {
    const input = enriched();
    input.pages[1] = { path: "/contact.html", html: input.pages[1].html.replace(/<label for="e">Email<\/label>/, "") };
    const c = check(input, "form-labels");
    assert.equal(c.status, "partial");
    assert.match(c.detail, /1 of 4 fields/i);
  });

  it("an llms.txt that does not parse earns half and says why", () => {
    const input = enriched();
    input.files["/llms.txt"] = { status: 200, body: "hello" };
    const c = check(input, "llms-txt");
    assert.equal(c.earned, 5);
    assert.match(c.detail, /title/i);
  });

  it("a site with no forms has nothing for the labels check to judge", () => {
    const input = bare();
    input.pages = [input.pages[0]];
    assert.equal(check(input, "form-labels").status, "na");
  });
});
