// ShapesOS — Phase 21A (WS=agentweb): what a ShapesOS storefront publishes for agents
// (PURE; the public routes under app/shop/[storeSlug] load the listings and call this).
//
// Read-only and honest: the documents are what the public catalogue already shows
// (title, description, price, stock). The JSON-LD declares search and a contact point;
// there is deliberately NO BuyAction / OrderAction / PayAction: checkout for agents is
// a later phase and money moves only through the existing signed, human-confirmed flow.

import type { JsonLd } from "@/lib/seo/jsonld";
import { docsFromListings, type ListingLike } from "./corpus";
import { buildLlmsTxt } from "./llmstxt";
import type { SiteDoc } from "./nlweb";

export interface StorefrontInfo {
  name: string;
  description: string | null;
  contactEmail: string | null;
  currency: string;
}
export interface StorefrontUrls {
  origin: string;
  /** "/shop/<slug>" */
  base: string;
}

const root = (o: StorefrontUrls) => `${o.origin.replace(/\/+$/, "")}${o.base}`;
const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

export function storefrontDocs(store: StorefrontInfo, listings: ListingLike[], urls: StorefrontUrls): SiteDoc[] {
  const home = [sentence(store.name), store.description?.trim() ? sentence(store.description.replace(/\s+/g, " ").trim()) : null, store.contactEmail ? `Contact: ${store.contactEmail}.` : null].filter(Boolean).join(" ");
  return [{ url: root(urls), name: store.name, text: home }, ...docsFromListings(listings, { ...urls, currency: store.currency })];
}

export function storefrontLlmsTxt(store: StorefrontInfo, listings: ListingLike[], urls: StorefrontUrls): string {
  const base = root(urls);
  return buildLlmsTxt({
    name: store.name,
    summary: store.description?.replace(/\s+/g, " ").trim() || `${store.name}, an online shop.`,
    details: "The ask and MCP endpoints below answer from this shop's published products only. They are read-only: they cannot buy, order or change anything.",
    sections: [
      { title: "Products", links: listings.slice(0, 50).map((l) => ({ title: l.title, url: `${base}/p/${l.slug}`, notes: `from ${(l.fromPriceCents / 100).toFixed(2)} ${store.currency}` })) },
      {
        title: "For agents",
        links: [
          { title: "Ask a question", url: `${base}/ask?query=${encodeURIComponent("what do you sell")}`, notes: "NLWeb-style, read-only: ?query=…&mode=list|summarize" },
          { title: "MCP server", url: `${base}/mcp`, notes: "JSON-RPC over POST, one read-only tool: ask" },
        ],
      },
    ],
  });
}

export function storefrontJsonLd(store: StorefrontInfo, urls: StorefrontUrls): JsonLd[] {
  const base = root(urls);
  const site: JsonLd = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: store.name,
    url: base,
    potentialAction: {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: `${base}/ask?query={search_term_string}` },
      "query-input": "required name=search_term_string",
    },
  };
  const org: JsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: store.name,
    url: base,
    ...(store.contactEmail ? { contactPoint: { "@type": "ContactPoint", contactType: "customer service", email: store.contactEmail } } : {}),
  };
  return [site, org];
}
