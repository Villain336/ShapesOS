// ShapesOS — Phase 18.2 (WS=content): public file share links — the bytes and
// the password unlock. PUBLIC BY DESIGN (scripts/verify-m11-security.mjs
// PUBLIC_BY_DESIGN): the unguessable token (fsh_ + 128 random bits, SHA-256 at
// rest) is the capability, scoped to ONE file of ONE workspace.
//
// GET  /r/file/<token>/raw           the file, inline (the viewer page's
//                                    preview loads it). A "view" link serves
//                                    only formats a browser shows (image,
//                                    video, audio, PDF, text) — never a
//                                    download of anything else.
// GET  /r/file/<token>/raw?save=1    as an attachment — "download" links only
//                                    (403 on a view-only link).
// POST /r/file/<token>/raw           form: password → sets the unlock cookie
//                                    (HttpOnly, SameSite=Lax, path-scoped to
//                                    this link, HMAC-signed, 12 h) and 303s
//                                    back to the viewer page.
// Fail-closed: unknown, revoked, expired, a trashed file — all one 404.
// Bytes: the sniffed mime recorded at upload, nosniff, the sandboxed
// USER_FILE_VIEW_CSP (also set by proxy.ts for this path). Rate limits: the
// read tier per IP+link for bytes; the auth tier (10/min) per IP+link for
// password attempts.

import type { NextRequest } from "next/server";
import { getStorageAdapter } from "@/lib/filesystem/storage";
import { buildDownloadHeaders } from "@/lib/filesystem/download";
import { USER_FILE_VIEW_CSP } from "@/lib/security/headers";
import { checkRateLimitAsync, clientIp, tooManyRequests } from "@/lib/api/rate-limit";
import {
  hashShareToken,
  resolveShareToken,
  shareSecret,
  signUnlock,
  unlockCookieName,
  verifySharePassword,
  verifyUnlock,
} from "@/lib/files/shares";
import { isPreviewableMime } from "@/lib/files/preview";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

const gone = () => Response.json({ error: "This link is unavailable." }, { status: 404, headers: { "cache-control": "no-store" } });

function limiterKey(token: string, req: Request, what: string): string {
  return `fileshare:${what}:${hashShareToken(token).slice(0, 16)}:${clientIp(req.headers) ?? "no-ip"}`;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { token } = await ctx.params;
  const rl = await checkRateLimitAsync(limiterKey(token, req, "get"), "read");
  if (!rl.allowed) return tooManyRequests(rl.retryAfterMs);
  const share = await resolveShareToken(token);
  if (!share) return gone();
  if (share.link.passwordHash) {
    const secret = shareSecret();
    if (!secret || !verifyUnlock(share.link.id, req.cookies.get(unlockCookieName(share.link.id))?.value, secret)) {
      return Response.json({ error: "This link needs its password." }, { status: 401, headers: { "cache-control": "no-store" } });
    }
  }
  const save = req.nextUrl.searchParams.get("save") === "1";
  if (save && share.link.access !== "download") return Response.json({ error: "This link is view-only." }, { status: 403 });
  if (!save && share.link.access === "view" && !isPreviewableMime(share.file.mimeType)) {
    return Response.json({ error: "This file can't be shown in a browser, and the link is view-only." }, { status: 403 });
  }
  const bytes = await getStorageAdapter().get(share.file.storageKey);
  if (!bytes) return gone();
  const headers = buildDownloadHeaders(share.file.mimeType, share.file.filename, { forceAttachment: save });
  if (!save) headers["content-disposition"] = headers["content-disposition"]!.replace(/^attachment/, "inline");
  return new Response(new Uint8Array(bytes), {
    headers: { ...headers, "content-security-policy": USER_FILE_VIEW_CSP, "cache-control": "private, no-store", "referrer-policy": "no-referrer" },
  });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { token } = await ctx.params;
  const back = (q = "") => new Response(null, { status: 303, headers: { location: `/r/file/${encodeURIComponent(token)}${q}`, "cache-control": "no-store" } });
  const rl = await checkRateLimitAsync(limiterKey(token, req, "unlock"), "auth");
  if (!rl.allowed) return tooManyRequests(rl.retryAfterMs);
  const share = await resolveShareToken(token);
  if (!share) return gone();
  if (!share.link.passwordHash) return back();
  const secret = shareSecret();
  if (!secret) return Response.json({ error: "Password links aren't available on this server (AUTH_SECRET is not set)." }, { status: 503 });
  const form = await req.formData().catch(() => null);
  const password = form?.get("password");
  if (typeof password !== "string" || password.length > 256 || !(await verifySharePassword(password, share.link.passwordHash))) {
    return back("?e=1");
  }
  const res = back();
  const secure = (req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "")) === "https";
  res.headers.append(
    "set-cookie",
    `${unlockCookieName(share.link.id)}=${signUnlock(share.link.id, secret)}; Path=/r/file/${encodeURIComponent(token)}; Max-Age=${12 * 3600}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
  );
  return res;
}
