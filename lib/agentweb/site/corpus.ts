// ShapesOS — Phase 21A (WS=agentweb): the documents the site's NLWeb endpoints may
// answer from (PURE). Only what a visitor sees on a published page: hidden text,
// scripts, styles, noindex pages and empty pages are left out, and listings expose
// what the public catalogue already shows. Nothing here reads a database or the
// network; callers pass the pages and listings in.

import { urlPathForFile } from "@/lib/seo/jsonld";
import { attr, findAll, parseHtml, textOf, visibleText } from "../html";
import type { SiteDoc } from "./nlweb";

const MAX_DOC_CHARS = 4000;
const MAX_DOCS = 500;

const toSentences = (text: string): string =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/[.!?]$/.test(l) ? l : `${l}.`))
    .join(" ");

export function docsFromHtml(pages: { path: string; html: string }[], origin: string): SiteDoc[] {
  const base = origin.replace(/\/+$/, "");
  const out: SiteDoc[] = [];
  for (const p of pages) {
    if (!/\.html?$/i.test(p.path)) continue;
    const root = parseHtml(p.html);
    const robots = findAll(root, (n) => n.tag === "meta" && (attr(n, "name") ?? "").toLowerCase() === "robots");
    if (robots.some((m) => /noindex/i.test(attr(m, "content") ?? ""))) continue;
    const body = findAll(root, (n) => n.tag === "body")[0] ?? root;
    const text = toSentences(visibleText(body)).slice(0, MAX_DOC_CHARS);
    if (!text) continue;
    const h1 = findAll(root, (n) => n.tag === "h1")[0];
    const title = findAll(root, (n) => n.tag === "title")[0];
    const name = (h1 ? textOf(h1) : title ? textOf(title) : "").replace(/\s+/g, " ").trim() || urlPathForFile(p.path);
    out.push({ url: `${base}${urlPathForFile(p.path)}`, name, text });
    if (out.length >= MAX_DOCS) break;
  }
  return out;
}

export interface ListingLike {
  slug: string;
  title: string;
  description: string | null;
  fromPriceCents: number;
  /** null = not stock-tracked (treated as in stock). */
  available: number | null;
}

const price = (cents: number) => (cents / 100).toFixed(2);

export function docsFromListings(listings: ListingLike[], opts: { origin: string; base: string; currency: string }): SiteDoc[] {
  const root = `${opts.origin.replace(/\/+$/, "")}${opts.base}`;
  return listings.slice(0, MAX_DOCS).map((l) => {
    const url = `${root}/p/${l.slug}`;
    const inStock = l.available === null || l.available > 0;
    const description = l.description?.replace(/\s+/g, " ").trim() || undefined;
    const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);
    const text = [sentence(l.title), description ? sentence(description) : null, `From ${price(l.fromPriceCents)} ${opts.currency}.`, inStock ? "In stock." : "Out of stock."].filter(Boolean).join(" ");
    return {
      url,
      name: l.title,
      text,
      schema: {
        "@type": "Product",
        name: l.title,
        ...(description ? { description } : {}),
        url,
        offers: { "@type": "Offer", price: price(l.fromPriceCents), priceCurrency: opts.currency, availability: inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock" },
      },
    };
  });
}
