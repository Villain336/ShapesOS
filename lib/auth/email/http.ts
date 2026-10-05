// ShapesOS — request plumbing shared by the public email sign-in routes
// (app/api/auth/email/*, Phase 6).
//
// The routes are public by design: they are the first half of a sign-in,
// like the Auth.js endpoints beside them, and they sit under /api/auth so the
// proxy's auth tier (10 requests/min per IP) applies. They accept JSON only —
// a cross-site HTML form can't send application/json without a CORS
// preflight, which these routes never grant — and bodies past 8 KiB are
// refused before parsing.

import { BadRequestError, HttpError } from "@/lib/api/errors";
import { clientIpFromHeaders } from "@/lib/api/client-ip";
import type { FlowDeps } from "./store";

export const MAX_EMAIL_AUTH_BODY = 8 * 1024;

export async function readEmailAuthBody(req: Request): Promise<Record<string, unknown>> {
  const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "Send the request as application/json.");
  const text = await req.text();
  if (text.length > MAX_EMAIL_AUTH_BODY) throw new BadRequestError("Request body too large.");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BadRequestError("Invalid JSON body.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequestError("Invalid request.");
  return body as Record<string, unknown>;
}

export function emailAuthRequestContext(req: Request): { ip: string | null; deps: FlowDeps } {
  let origin: string | null = null;
  try {
    origin = new URL(req.url).origin;
  } catch {
    origin = null;
  }
  return { ip: clientIpFromHeaders(req.headers), deps: { requestOrigin: origin } };
}
