// ShapesOS Phase 11 (seotools): JSON-LD generator, validator, injector and
// per-page suggestions; the structured-data audit check that uses them.
// Run: npx tsx --test lib/seo/__tests__/jsonld.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractFaqPairs,
  generateJsonLd,
  injectJsonLd,
  injectedJsonLd,
  JSONLD_TYPES,
  serializeJsonLd,
  suggestJsonLdForPage,
  urlPathForFile,
  validateJsonLd,
  validateJsonLdText,
  type JsonLdType,
} from "../jsonld";
import { checkStructuredData } from "@/lib/audit/structured-data";
import { parseBlockArgs } from "../tools";

const errors = (v: unknown) => validateJsonLd(v).filter((i) => i.severity === "error");

describe("generateJsonLd", () => {
  const samples: Record<JsonLdType, Parameters<typeof generateJsonLd>[1]> = {
    Organization: { name: "Acme", url: "https://acme.example/", logo: "https://acme.example/logo.png", sameAs: ["https://x.com/acme"] },
    WebSite: { name: "Acme", url: "https://acme.example/", searchUrlTemplate: "https://acme.example/search?q={search_term_string}" },
    LocalBusiness: {
      name: "Acme Plumbing",
      businessType: "Plumber",
      telephone: "+1-512-555-0100",
      address: { streetAddress: "1 Main St", addressLocality: "Austin", addressRegion: "TX", postalCode: "78701", addressCountry: "US" },
      geo: { latitude: 30.27, longitude: -97.74 },
      openingHours: ["Mo-Fr 08:00-18:00"],
    },
    Product: { name: "Widget", image: "https://acme.example/w.png", sku: "W-1", brand: "Acme", offers: { price: 19.99, priceCurrency: "usd", availability: "InStock" } },
    Article: { headline: "How to fix a tap", authorName: "Sam", datePublished: "2026-10-01", image: "https://acme.example/a.png", publisherName: "Acme", url: "https://acme.example/blog/tap" },
    FAQPage: { questions: [{ question: "Do you work weekends?", answer: "Yes." }, { question: " ", answer: "dropped" }] },
    BreadcrumbList: { items: [{ name: "Home", url: "https://acme.example/" }, { name: "Blog", url: "https://acme.example/blog" }] },
  };

  for (const type of JSONLD_TYPES) {
    it(`builds a valid ${type}`, () => {
      const block = generateJsonLd(type, samples[type]);
      assert.equal(block["@context"], "https://schema.org");
      assert.deepEqual(errors(block), [], JSON.stringify(validateJsonLd(block)));
    });
  }

  it("normalizes details: subtype, currency, availability URL, FAQ filtering, positions", () => {
    assert.equal(generateJsonLd("LocalBusiness", samples.LocalBusiness)["@type"], "Plumber");
    assert.equal(generateJsonLd("LocalBusiness", { ...samples.LocalBusiness, businessType: "not a type!" })["@type"], "LocalBusiness");
    const offer = generateJsonLd("Product", samples.Product).offers as Record<string, unknown>;
    assert.deepEqual(offer, { "@type": "Offer", price: "19.99", priceCurrency: "USD", availability: "https://schema.org/InStock" });
    assert.equal((generateJsonLd("FAQPage", samples.FAQPage).mainEntity as unknown[]).length, 1);
    const crumbs = generateJsonLd("BreadcrumbList", samples.BreadcrumbList).itemListElement as Array<Record<string, unknown>>;
    assert.deepEqual(crumbs.map((c) => c.position), [1, 2]);
    assert.ok(!("logo" in generateJsonLd("Organization", { name: "A", url: "https://a.example" })), "empty fields are dropped");
  });
});

describe("validateJsonLd", () => {
  it("requires schema.org context and @type", () => {
    assert.match(errors({ "@type": "Organization", name: "A" })[0].message, /@context/);
    assert.match(errors({ "@context": "https://schema.org" })[0].message, /@type/);
    assert.deepEqual(errors({ "@context": "http://schema.org/", "@type": "Thing" }), [], "unknown types only need context + type");
  });

  it("enforces required properties per type", () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ "@context": "https://schema.org", "@type": "WebSite", name: "A" }, /absolute url/],
      [{ "@context": "https://schema.org", "@type": "Product", name: "W" }, /offers, review or aggregateRating/],
      [{ "@context": "https://schema.org", "@type": "Product", name: "W", offers: { "@type": "Offer", price: "abc", priceCurrency: "usd" } }, /numeric price/],
      [{ "@context": "https://schema.org", "@type": "Product", name: "W", aggregateRating: { ratingValue: 4.5 } }, /reviewCount or ratingCount/],
      [{ "@context": "https://schema.org", "@type": "Plumber", name: "P" }, /needs an address/],
      [{ "@context": "https://schema.org", "@type": "Article", datePublished: "yesterday" }, /headline/],
      [{ "@context": "https://schema.org", "@type": "BlogPosting", headline: "x", datePublished: "1st Oct" }, /ISO 8601/],
      [{ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "Q?" }] }, /acceptedAnswer/],
      [{ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Home" }, { "@type": "ListItem", position: 2, name: "x" }] }, /absolute item URL/],
      [{ "@context": "https://schema.org", "@type": "WebSite", name: "A", url: "https://a.example", potentialAction: { "@type": "SearchAction", target: "https://a.example/s?q=x" } }, /search_term_string/],
    ];
    for (const [value, re] of cases) {
      const e = errors(value);
      assert.ok(e.some((i) => re.test(i.message)), `${JSON.stringify(value)} → ${JSON.stringify(e)}`);
    }
  });

  it("separates recommended (warnings) from required (errors)", () => {
    const issues = validateJsonLd({ "@context": "https://schema.org", "@type": "Article", headline: "x".repeat(120) });
    assert.deepEqual(issues.filter((i) => i.severity === "error"), []);
    assert.ok(issues.some((i) => i.severity === "warning" && /110/.test(i.message)));
    assert.ok(issues.some((i) => i.severity === "warning" && /author/.test(i.message)));
  });

  it("validates @graph and arrays with paths", () => {
    const graph = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Organization", name: "A", url: "https://a.example" },
        { "@type": "WebSite", name: "A" },
      ],
    };
    const e = errors(graph);
    assert.equal(e.length, 1);
    assert.equal(e[0].path, "@graph[1].url");
    assert.equal(errors([graph, "nope"]).length, 2);
  });

  it("validateJsonLdText reports bad JSON", () => {
    assert.match(validateJsonLdText("{")[0].message, /Not valid JSON/);
  });
});

describe("injectJsonLd", () => {
  const html = `<!doctype html><html><head><title>x</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Thing","name":"hand-written"}</script>
</head><body></body></html>`;
  const org = generateJsonLd("Organization", { name: "Acme", url: "https://acme.example/" });

  it("inserts into head, is idempotent and leaves hand-written blocks alone", () => {
    const once = injectJsonLd(html, [org]);
    assert.match(once, /data-shapes="jsonld">\n\{\n {2}"@context": "https:\/\/schema.org"/);
    assert.ok(once.indexOf('data-shapes="jsonld"') < once.indexOf("</head>"));
    assert.equal(injectJsonLd(once, [org]), once);
    assert.match(once, /hand-written/);
    assert.deepEqual(injectedJsonLd(once), [org]);
  });

  it("replaces and removes only its own blocks", () => {
    const once = injectJsonLd(html, [org]);
    const swapped = injectJsonLd(once, [generateJsonLd("WebSite", { name: "Acme", url: "https://acme.example/" })]);
    assert.equal(injectedJsonLd(swapped).length, 1);
    assert.equal(injectedJsonLd(swapped)[0]["@type"], "WebSite");
    assert.equal(injectJsonLd(once, []), html);
  });

  it("handles pages without a head and escapes script-breaking content", () => {
    assert.match(injectJsonLd("<html><body>x</body></html>", [org]), /^<html>\n<head>\n<script/);
    assert.match(injectJsonLd("<p>x</p>", [org]), /^<head>/);
    const evil = serializeJsonLd({ name: "</script><script>alert(1)</script> " });
    assert.doesNotMatch(evil, /<\/script/);
    assert.match(evil, /\\u2028/);
  });
});

describe("suggestJsonLdForPage", () => {
  const site = { name: "Acme", origin: "https://acme.example/", logo: "https://acme.example/logo.png" };

  it("maps files to URL paths", () => {
    assert.equal(urlPathForFile("/index.html"), "/");
    assert.equal(urlPathForFile("/blog/index.html"), "/blog/");
    assert.equal(urlPathForFile("/about.html"), "/about");
  });

  it("home gets Organization + WebSite; inner pages get breadcrumbs; FAQs from <details>", () => {
    const home = suggestJsonLdForPage("/index.html", "<h1>Welcome</h1>", site);
    assert.deepEqual(home.map((b) => b["@type"]), ["Organization", "WebSite"]);
    assert.equal(home[0].logo, "https://acme.example/logo.png");

    const inner = suggestJsonLdForPage(
      "/services/drain-cleaning.html",
      "<h1>Drain &amp; sewer cleaning</h1><details><summary>Is it messy?</summary><p>No — we <b>clean up</b>.</p></details>",
      site,
    );
    assert.deepEqual(inner.map((b) => b["@type"]), ["BreadcrumbList", "FAQPage"]);
    const items = inner[0].itemListElement as Array<{ name: string; item: string }>;
    assert.deepEqual(items.map((i) => [i.name, i.item]), [
      ["Acme", "https://acme.example/"],
      ["Services", "https://acme.example/services"],
      ["Drain & sewer cleaning", "https://acme.example/services/drain-cleaning"],
    ]);
    for (const b of [...home, ...inner]) assert.deepEqual(errors(b), []);
  });

  it("extracts FAQ pairs", () => {
    assert.deepEqual(extractFaqPairs("<details><summary> Q1 </summary> A1 </details><details><summary></summary>x</details>"), [{ question: "Q1", answer: "A1" }]);
  });
});

describe("structured-data audit check uses the validator", () => {
  it("flags missing required properties, not just bad JSON", () => {
    const f = checkStructuredData("/p.html", `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"W"}</script>`);
    assert.equal(f[0].category, "invalid-structured-data");
    assert.match(f[0].detail, /offers — Product needs offers/);
    const ok = checkStructuredData("/p.html", `<script type="application/ld+json">${JSON.stringify(generateJsonLd("Organization", { name: "A", url: "https://a.example" }))}</script>`);
    assert.deepEqual(ok, []);
  });
});

describe("add_structured_data block args", () => {
  it("parses [{ path, type, data }] into generated blocks", () => {
    const out = parseBlockArgs(JSON.stringify([{ path: "products/w.html", type: "Product", data: { name: "W", offers: { price: 5, priceCurrency: "EUR" } } }]));
    assert.deepEqual(Object.keys(out), ["/products/w.html"]);
    assert.equal(out["/products/w.html"][0]["@type"], "Product");
    assert.deepEqual(parseBlockArgs(undefined), {});
    assert.throws(() => parseBlockArgs("{"), /must be JSON/);
    assert.throws(() => parseBlockArgs([{ path: "/x", type: "Recipe", data: {} }]), /type must be one of/);
    assert.throws(() => parseBlockArgs([{ type: "Product", data: {} }]), /path/);
  });
});
