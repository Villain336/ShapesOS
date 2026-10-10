// ShapesOS — Phase 21A (WS=agentweb): GET /shop/[storeSlug]/llms.txt — the storefront's
// llms.txt (llmstxt.org): name, summary, its products and the read-only ask/MCP
// endpoints. PUBLIC BY DESIGN and READ-ONLY like ../ask: only a PUBLISHED store resolves,
// the content is the public catalogue, nothing is written or fetched; per-store+IP window.

import { storefrontLlmsTxt } from "@/lib/agentweb/site/storefront";
import { CORS, storefrontContext } from "@/lib/agentweb/site/storefront-http";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ storeSlug: string }> }) {
  const { storeSlug } = await params;
  const ctx = await storefrontContext(req, storeSlug, "llms");
  if (ctx instanceof Response) return ctx;
  return new Response(storefrontLlmsTxt(ctx.store, ctx.listings, ctx.urls), {
    headers: { ...CORS, "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
