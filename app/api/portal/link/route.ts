// ShapesOS — Phase 10 (portal): POST /api/portal/link { token }.
// Public by design (second half of a client-portal sign-in): the single-use
// link token is the capability. One guarded UPDATE consumes it (used_at IS
// NULL AND expires_at > now) under the token's workspace RLS scope; the
// client must still exist, have the portal on and sign in with the address
// the link went to. Success sets the portal session cookie (httpOnly,
// SameSite=Lax, Path=/portal and Path=/api/portal) — a portal session, never
// a workspace session. Failures count toward a per-IP lockout. JSON only,
// same-Origin only (login-CSRF), proxy auth tier (10/min per IP).

import { errorResponse } from "@/lib/api/errors";
import { clientIpFromHeaders } from "@/lib/api/client-ip";
import { readEmailAuthBody } from "@/lib/auth/email/http";
import { appBaseUrl } from "@/lib/workspace/invite-mail";
import { checkPortalCsrf } from "@/lib/portal/core";
import { consumePortalLink } from "@/lib/portal/store";
import { withPortalCookie } from "@/lib/portal/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const csrf = checkPortalCsrf(req, [appBaseUrl(process.env, null)]);
    if (!csrf.ok) return Response.json({ error: csrf.reason, code: "csrf" }, { status: 403 });
    const body = await readEmailAuthBody(req);
    const r = await consumePortalLink(body.token, { ip: clientIpFromHeaders(req.headers), userAgent: req.headers.get("user-agent") });
    if (r.status !== "ok") {
      return Response.json({ error: "This link has already been used or has expired. Ask for a new one.", code: "link_invalid" }, { status: 400 });
    }
    const maxAge = Math.floor((r.expiresAt.getTime() - Date.now()) / 1000);
    return withPortalCookie(Response.json({ ok: true }), req, r.sessionToken, maxAge);
  } catch (err) {
    return errorResponse(err, "POST /api/portal/link", req);
  }
}
