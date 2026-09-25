// Marketr — GET /api/media/links/go/[slug] (scan ingress → 302 redirect).
//
// This is the URL encoded into printed QR codes. It records the scan to the
// local ledger (which NEVER leaves Marketr's database) and 302s to the
// link's current destination with UTM auto-tagging. Unknown/paused slugs →
// 404. Bot/crawler user-agents are still counted as scans (honest note:
// the dashboard's uniqueIpHashes column is the deduped read).

import type { NextRequest } from "next/server";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { getMediaStore } from "@/lib/media/store";
import { resolveLinkEngine } from "@/lib/media/links";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  // The scan URL is printed on physical creative — it must work for anonymous
  // scanners. Slugs are globally unique, so no workspace hint is needed on
  // the printed URL; a signed-in scanner's workspace scopes the match first.
  let workspaceId = "anonymous";
  try {
    const user = await requireUser();
    if (user) workspaceId = (await getOrCreateWorkspace(user.id, user.email)).id;
  } catch {
    workspaceId = "anonymous";
  }

  const engine = resolveLinkEngine(getMediaStore());
  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded ? forwarded.split(",")[0].trim() : null;
  const result = await engine.recordScan({
    workspaceId,
    slug: decodeURIComponent(slug),
    userAgent: req.headers.get("user-agent"),
    ip,
    referer: req.headers.get("referer"),
  });
  if (!result) return Response.json({ error: "Link not found or paused" }, { status: 404 });
  return Response.redirect(result.destination, 302);
}
