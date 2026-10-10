// ShapesOS — Phase 21A (WS=agentweb): GET /shop/[storeSlug]/ask — an NLWeb-style
// question endpoint over this store's PUBLISHED catalogue.
//   GET /shop/acme/ask?query=is the blue mug in stock&mode=summarize
//   → { query_id, query, mode, results[{url,name,site,score,description,schema_object}], summary? }
//
// PUBLIC BY DESIGN, READ-ONLY, UNAUTHENTICATED (agents have no account): only a
// PUBLISHED store resolves (unknown/unpublished 404); the content is the public
// catalogue and nothing else; there is no model behind it (summaries are extractive,
// `generate` is refused), nothing is fetched or written, so there is no SSRF or
// injection surface; a per-store+IP window and the query/result caps bound the cost.
// See lib/agentweb/site/nlweb.ts for the shapes and what they honestly are not.

import { AskError, askSite } from "@/lib/agentweb/site/nlweb";
import { json, preflight, storefrontContext } from "@/lib/agentweb/site/storefront-http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ storeSlug: string }> };

export async function GET(req: Request, { params }: Params) {
  const { storeSlug } = await params;
  const ctx = await storefrontContext(req, storeSlug, "ask");
  if (ctx instanceof Response) return ctx;
  const q = new URL(req.url).searchParams;
  try {
    const res = askSite(ctx.docs, { name: ctx.store.name, origin: ctx.urls.origin }, {
      query: q.get("query") ?? "",
      mode: q.get("mode") ?? undefined,
      prev: q.get("prev") ?? undefined,
      decontextualized_query: q.get("decontextualized_query") ?? undefined,
      site: q.get("site") ?? undefined,
    });
    return json(res, 200, { "Cache-Control": "public, max-age=30" });
  } catch (err) {
    if (err instanceof AskError) return json({ error: err.message }, 400);
    throw err;
  }
}

export function OPTIONS() {
  return preflight();
}
