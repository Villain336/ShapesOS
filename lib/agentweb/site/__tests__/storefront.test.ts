// Phase 21A (WS=agentweb): what a ShapesOS storefront publishes for agents (PURE):
// documents for /ask and /mcp, llms.txt, and JSON-LD (search + contact, never a buy action).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { storefrontDocs, storefrontJsonLd, storefrontLlmsTxt } from "../storefront";
import { parseLlmsTxt } from "../llmstxt";
import { askSite } from "../nlweb";

const STORE = { name: "Acme shop", description: "Mugs and tees, shipped from Leeds.", contactEmail: "hello@acme.test", currency: "GBP" };
const OPTS = { origin: "https://acme.test", base: "/shop/acme" };
const LISTINGS = [
  { slug: "blue-mug", title: "Blue mug", description: "A glazed mug.", fromPriceCents: 1250, available: 4 },
  { slug: "tee", title: "Tee", description: null, fromPriceCents: 1800, available: 0 },
];

describe("storefrontDocs", () => {
  const docs = storefrontDocs(STORE, LISTINGS, OPTS);
  it("starts with the store itself, then one doc per listing", () => {
    assert.deepEqual(docs.map((d) => d.url), ["https://acme.test/shop/acme", "https://acme.test/shop/acme/p/blue-mug", "https://acme.test/shop/acme/p/tee"]);
    assert.equal(docs[0].text, "Acme shop. Mugs and tees, shipped from Leeds. Contact: hello@acme.test.");
  });
  it("answers stock and price questions from those docs only", () => {
    const r = askSite(docs, { name: STORE.name, origin: OPTS.origin }, { query: "is the tee in stock", mode: "summarize" });
    assert.equal(r.results[0].url, "https://acme.test/shop/acme/p/tee");
    assert.match(r.summary?.text ?? "", /Out of stock/);
  });
});

describe("storefrontLlmsTxt", () => {
  const text = storefrontLlmsTxt(STORE, LISTINGS, OPTS);
  const parsed = parseLlmsTxt(text);
  it("is a valid llms.txt listing products and the agent endpoints", () => {
    assert.ok(parsed.valid, parsed.problems.join(";"));
    assert.equal(parsed.title, "Acme shop");
    assert.equal(parsed.summary, "Mugs and tees, shipped from Leeds.");
    const urls = parsed.sections.flatMap((s) => s.links.map((l) => l.url));
    assert.ok(urls.includes("https://acme.test/shop/acme/p/blue-mug"));
    assert.ok(urls.includes("https://acme.test/shop/acme/ask?query=what%20do%20you%20sell"));
    assert.ok(urls.includes("https://acme.test/shop/acme/mcp"));
  });
  it("says the endpoints are read-only", () => {
    assert.match(text, /read-only/i);
  });
});

describe("storefrontJsonLd", () => {
  const blocks = storefrontJsonLd(STORE, OPTS);
  it("declares a search action on the ask endpoint and a contact point", () => {
    const site = blocks.find((b) => b["@type"] === "WebSite")!;
    assert.deepEqual(site.potentialAction, {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: "https://acme.test/shop/acme/ask?query={search_term_string}" },
      "query-input": "required name=search_term_string",
    });
    const org = blocks.find((b) => b["@type"] === "Organization")!;
    assert.deepEqual(org.contactPoint, { "@type": "ContactPoint", contactType: "customer service", email: "hello@acme.test" });
  });
  it("never offers a buy, order or pay action", () => {
    const json = JSON.stringify(blocks);
    for (const banned of ["BuyAction", "OrderAction", "PayAction", "TradeAction"]) assert.ok(!json.includes(banned));
  });
  it("has no contact point when the store has no email", () => {
    assert.ok(!storefrontJsonLd({ ...STORE, contactEmail: null }, OPTS).some((b) => "contactPoint" in b));
  });
});
