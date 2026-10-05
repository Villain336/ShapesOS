// ShapesOS — Phase 10 (portal): request plumbing for /api/portal/* and the
// /portal pages.
//
//   portalGuard(req, need)   every authenticated /api/portal route: the
//                            portal session cookie (never the workspace
//                            session), CSRF on writes (JSON + same Origin +
//                            Sec-Fetch-Site), then the client's viewerRole
//                            gate for the section / action.
//   portalPagePrincipal()    the /portal pages (server components) — reads
//                            the same cookie through next/headers.
//   portalError(err)         OpsError / HttpError → JSON response.
//
// Rate limits: the proxy's tiers apply to /api/portal like every API route
// (portal users carry no Auth.js session, so they are IP-keyed); sign-in
// (/api/portal/login, /api/portal/link) is on the auth tier (10/min per IP,
// lib/api/rate-limit.ts).

import { errorResponse } from "@/lib/api/errors";
import { OpsError } from "@/lib/ops/doctype";
import { appBaseUrl } from "@/lib/workspace/invite-mail";
import {
  PORTAL_COOKIE,
  checkPortalCsrf,
  portalCan,
  portalCookieHeaders,
  portalCookieSecure,
  portalSees,
  readPortalCookie,
  type PortalAction,
  type PortalSection,
} from "./core";
import { resolvePortalSession, type PortalPrincipal } from "./store";

export interface PortalNeed {
  section?: PortalSection;
  action?: PortalAction;
}

const json = (status: number, error: string, code?: string) => Response.json({ error, ...(code ? { code } : {}) }, { status });

/** Authenticate a portal API request. Returns the principal or a ready error response. */
export async function portalGuard(req: Request, need: PortalNeed = {}): Promise<PortalPrincipal | Response> {
  const csrf = checkPortalCsrf(req, [appBaseUrl(process.env, null)]);
  if (!csrf.ok) return json(403, csrf.reason, "csrf");
  const principal = await resolvePortalSession(readPortalCookie(req.headers.get("cookie")));
  if (!principal) return json(401, "Sign in to the client portal.", "portal_signed_out");
  if (need.section && !portalSees(principal.role, need.section)) return json(403, "Your access doesn't include this.", "portal_forbidden");
  if (need.action && !portalCan(principal.role, need.action)) return json(403, "Your access doesn't allow this. Ask us to change it.", "portal_forbidden");
  return principal;
}

/** The signed-in client on a /portal page, or null. */
export async function portalPagePrincipal(): Promise<PortalPrincipal | null> {
  const { cookies } = await import("next/headers");
  const store = await cookies();
  return resolvePortalSession(store.get(PORTAL_COOKIE)?.value ?? null);
}

export function portalError(err: unknown): Response {
  if (err instanceof OpsError) return json(err.status, err.message);
  return errorResponse(err);
}

/** Attach (or clear, value null) the portal session cookies to a response. */
export function withPortalCookie(res: Response, req: Request, value: string | null, maxAgeSec?: number): Response {
  for (const c of portalCookieHeaders(value, { secure: portalCookieSecure(req.url), maxAgeSec })) res.headers.append("Set-Cookie", c);
  return res;
}

/** Base URL for links the portal hands out (Stripe return URLs). */
export function portalBaseUrl(req: Request): string {
  const origin = new URL(req.url).origin;
  return appBaseUrl(process.env, origin) ?? origin;
}

/** A PDF download response (never cached; attachment). */
export function pdfResponse(pdf: Buffer, filename: string): Response {
  const safe = filename.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120) || "document.pdf";
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${safe}"`,
      "Content-Length": String(pdf.length),
      "Cache-Control": "private, no-store",
    },
  });
}

/** Read a small JSON body (portal writes are ≤ 64 KiB). */
export async function readPortalJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > 64 * 1024) throw new OpsError(400, "Request body too large.");
  try {
    const v = text.trim() ? (JSON.parse(text) as unknown) : {};
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch {
    throw new OpsError(400, "Invalid JSON body.");
  }
}
