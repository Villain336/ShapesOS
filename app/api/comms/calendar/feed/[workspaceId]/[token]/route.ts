// ShapesOS — Phase 18.2 (WS=comms): a member's private calendar feed (ICS).
//   GET /api/comms/calendar/feed/<workspaceId>/<token>.ics → text/calendar
//
// PUBLIC BY DESIGN (scripts/verify-m11-security.mjs PUBLIC_BY_DESIGN): a
// calendar app (Apple Calendar, Google Calendar, Outlook) subscribes to the
// URL without a session, so the 32-byte random token IS the capability:
// stored as sha256 only (calendar_feed_tokens, FORCE RLS under the URL's
// workspace), revocable (revoked → 404 at once), void when its member left
// the workspace. Read-only (GET only); unknown / revoked / malformed → the
// same 404 (no oracle). Rate-limited per IP by proxy.ts like every /api route.
// The feed carries only what ShapesOS holds for that member
// (lib/comms/calendar/feed.server.ts) — never connector credentials, and it
// never calls Google / Outlook.

import type { NextRequest } from "next/server";
import { feedIcs, resolveFeed } from "@/lib/comms/calendar/feed.server";

export const dynamic = "force-dynamic";

const NOT_FOUND = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(_req: NextRequest, { params }: { params: Promise<{ workspaceId: string; token: string }> }) {
  const { workspaceId, token } = await params;
  const raw = String(token ?? "").replace(/\.ics$/i, "");
  try {
    const who = await resolveFeed(String(workspaceId ?? ""), raw);
    if (!who) return NOT_FOUND();
    let tz = "UTC";
    try {
      const { getUserPreferences } = await import("@/lib/preferences");
      tz = (await getUserPreferences(who.userId)).timeZone || "UTC";
    } catch {
      /* UTC */
    }
    const body = await feedIcs(String(workspaceId), who.userId, tz);
    return new Response(body, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="shapesos.ics"',
        "Cache-Control": "private, max-age=300",
        "X-Robots-Tag": "noindex",
      },
    });
  } catch {
    return NOT_FOUND();
  }
}
