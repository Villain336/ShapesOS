// Marketr — Physical attribution kit: vanity-URL redirect.
// GET /r/<slug> → logs a scan (deduped per IP+day), logs a qr_code
// attribution touch when the scanner is identified (?lead=<id> matching a
// workspace lead), then 302s to the campaign destination with the bundle's
// UTM defaults merged in (existing query params win).
//
// Capability model: the slug is an unlisted random identifier and IS the
// capability — possession authorizes exactly the redirect. No session, no
// workspace lookup from the caller; the bundle resolves its own workspace
// (slugs are globally unique, so resolution is deterministic). Defenses:
//   - unknown slug → 404 (no oracle beyond existence, inherent to the model),
//   - disabled bundle → 410, nothing logged,
//   - scans are anonymous events (IP is sha256-hashed; no PII stored),
//   - scan insert is unique-per-(bundle,ip,day): double-scans collapse.

import { handleVanityRedirect } from "@/lib/physical/bundles";

function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const url = new URL(req.url);
  const res = await handleVanityRedirect({
    slug: slug.trim().slice(0, 80),
    ip: clientIp(req),
    query: url.searchParams,
    userAgent: req.headers.get("user-agent"),
    referer: req.headers.get("referer"),
  });
  if (res.status === 302 && res.location) {
    return Response.redirect(res.location, 302);
  }
  return new Response(res.status === 410 ? "Gone" : "Not found", { status: res.status });
}
