// ShapesOS — Phase 18.1 (WS=find): the signed-in person's own preferences.
//   GET   /api/preferences                → { preferences }
//   PATCH /api/preferences { key: value } → { preferences }   (all-or-nothing;
//         unknown keys and invalid values → 400, nothing written)
// Self-service: no user id is read from the request — every read and write
// is keyed to the session's own subject (requireSelfService). The response
// also refreshes the `shapes_shell` cookie (theme, contrast, density,
// motion, font size, language — no PII) so signed-out pages on this device
// paint the same way.

import { NextResponse } from "next/server";
import { requireSelfService } from "@/lib/auth/require-self-service";
import { errorResponse } from "@/lib/api/errors";
import { MAX_JSON_DEPTH } from "@/lib/api/validate";
import { getUserPreferences, PreferenceError, setUserPreferences } from "@/lib/preferences";
import { encodeShellCookie, shellFrom, SHELL_COOKIE, SHELL_COOKIE_MAX_AGE } from "@/lib/preferences/shell";
import type { UserPreferences } from "@/lib/preferences/schema";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 32_768;

function withShellCookie(prefs: UserPreferences): NextResponse {
  const res = NextResponse.json({ preferences: prefs }, { headers: { "Cache-Control": "no-store" } });
  res.cookies.set(SHELL_COOKIE, encodeShellCookie(shellFrom(prefs)), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SHELL_COOKIE_MAX_AGE,
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}

function depth(v: unknown, d = 0): number {
  if (d > MAX_JSON_DEPTH || v === null || typeof v !== "object") return d;
  return Math.max(d, ...Object.values(v as Record<string, unknown>).map((x) => depth(x, d + 1)));
}

export async function GET(req: Request) {
  try {
    const me = await requireSelfService();
    if (me instanceof Response) return me;
    return withShellCookie(await getUserPreferences(me.id));
  } catch (err) {
    return errorResponse(err, "GET /api/preferences", req);
  }
}

export async function PATCH(req: Request) {
  try {
    const me = await requireSelfService();
    if (me instanceof Response) return me;
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return Response.json({ error: "Body too large" }, { status: 413 });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
    if (depth(body) > MAX_JSON_DEPTH) return Response.json({ error: "Body nested too deeply" }, { status: 400 });
    try {
      return withShellCookie(await setUserPreferences(me.id, body));
    } catch (err) {
      if (err instanceof PreferenceError) return Response.json({ error: err.message }, { status: 400 });
      throw err;
    }
  } catch (err) {
    return errorResponse(err, "PATCH /api/preferences", req);
  }
}
