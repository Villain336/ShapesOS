// ShapesOS — Phase 21A (WS=agentweb): plumbing shared by the three PUBLIC storefront
// agent routes (app/shop/[storeSlug]/{ask,mcp,llms.txt}). All three are PUBLIC BY
// DESIGN and READ-ONLY — see scripts/verify-m11-security.mjs PUBLIC_BY_DESIGN.
//
// What makes that safe:
//   - only a PUBLISHED store resolves (the SELECT-only routing policy); unknown or
//     unpublished is a 404 and nothing else is revealed;
//   - the only content is the public catalogue, loaded under that store's tenant scope;
//   - nothing is fetched from the network (so no SSRF surface) and nothing is written;
//   - a per-store+IP fixed window (shared counter store when configured), a 500-char
//     query cap, a 10-result cap and an 8 KiB request-body cap bound the cost.

import { NextResponse } from "next/server";
import { clientIpFromHeaders } from "@/lib/api/client-ip";
import { loadPublicListings, resolvePublishedStore, type PublicStore } from "@/lib/ops/store/catalog";
import { publicEndpointHit } from "@/lib/ops/store/limits";
import { siteOrigin } from "@/lib/ops/store/page-data";
import { storefrontDocs, type StorefrontUrls } from "./storefront";
import type { ListingLike } from "./corpus";
import type { SiteDoc } from "./nlweb";

export const AGENT_LIMIT = { limit: 30, windowMs: 60_000 } as const;
export const MCP_BODY_LIMIT = 8192;

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, mcp-protocol-version, accept",
  "Access-Control-Max-Age": "86400",
} as const;

export const json = (body: unknown, status = 200, extra: Record<string, string> = {}): Response =>
  NextResponse.json(body, { status, headers: { ...CORS, "Cache-Control": "no-store", ...extra } });

export const preflight = (): Response => new Response(null, { status: 204, headers: CORS });

export interface StorefrontContext {
  store: PublicStore;
  urls: StorefrontUrls;
  listings: ListingLike[];
  docs: SiteDoc[];
}

const TTL_MS = 30_000;
const MAX_CACHED = 200;
const cache = new Map<string, { at: number; listings: ListingLike[] }>();

/** Test seam: forget cached catalogues. */
export function __resetStorefrontCache(): void {
  cache.clear();
}

async function listingsFor(store: PublicStore, now: number): Promise<ListingLike[]> {
  const hit = cache.get(store.id);
  if (hit && now - hit.at < TTL_MS) return hit.listings;
  const listings = (await loadPublicListings(store)).map((l) => ({ slug: l.slug, title: l.title, description: l.description, fromPriceCents: l.fromPriceCents, available: l.available }));
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
  cache.set(store.id, { at: now, listings });
  return listings;
}

/** Resolve the published store, rate-limit this store+IP, load the catalogue; or a ready Response. */
export async function storefrontContext(req: Request, storeSlug: string, kind: "ask" | "mcp" | "llms", now: number = Date.now()): Promise<StorefrontContext | Response> {
  const store = await resolvePublishedStore(storeSlug);
  if (!store) return json({ error: "Not found" }, 404);
  const hit = await publicEndpointHit(`agentweb:${kind}`, AGENT_LIMIT, store.id, clientIpFromHeaders(req.headers), now);
  if (!hit.allowed) return json({ error: "Too many requests. Try again shortly." }, 429, { "Retry-After": String(Math.max(1, Math.ceil(hit.retryAfterMs / 1000))) });
  const urls: StorefrontUrls = { origin: siteOrigin() ?? new URL(req.url).origin, base: `/shop/${store.slug}` };
  const listings = await listingsFor(store, now);
  return { store, urls, listings, docs: storefrontDocs(store, listings, urls) };
}
