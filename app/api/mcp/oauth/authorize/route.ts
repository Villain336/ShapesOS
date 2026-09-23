// Marketr — OAuth 2.1 authorization endpoint (Phase C, W5).
//
// GET /api/mcp/oauth/authorize?client_id&redirect_uri&scope&state&code_challenge
//   → signed-in user required; validates everything via beginAuthorize, seals
//     the pending authorization with AES-256-GCM (secrets()), and redirects
//     to the consent screen /mcp/authorize?grant=<opaque>.
//
// The grant token is opaque to the client: it carries the exact scope set the
// consent screen will display, so the minted code can never carry scopes the
// user didn't see (T7).

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { beginAuthorize } from "@/lib/mcp/oauth";
import { secrets } from "@/lib/secrets";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) {
    const login = new URL("/login", req.url);
    login.searchParams.set("next", "/api/mcp/oauth/authorize" + req.nextUrl.search);
    return Response.redirect(login, 302);
  }
  const q = req.nextUrl.searchParams;
  const begun = await beginAuthorize({
    clientId: q.get("client_id") ?? "",
    redirectUri: q.get("redirect_uri") ?? "",
    scope: q.get("scope") ?? undefined,
    state: q.get("state") ?? undefined,
    codeChallenge: q.get("code_challenge") ?? undefined,
    codeChallengeMethod: q.get("code_challenge_method") ?? undefined,
    responseType: q.get("response_type") ?? undefined,
  });
  if (!begun.ok) {
    // Never redirect on validation failure — render the error inline so a
    // forged redirect_uri can't turn us into an open redirector (T5).
    return new Response(
      `<!doctype html><html><body style="font-family:sans-serif;padding:2rem"><h1>Authorization failed</h1><p>${escapeHtml(begun.error)}</p></body></html>`,
      { status: 400, headers: { "Content-Type": "text/html" } },
    );
  }
  const grant = secrets().encrypt(JSON.stringify(begun.pending));
  const consent = new URL("/mcp/authorize", req.url);
  consent.searchParams.set("grant", grant);
  return Response.redirect(consent, 302);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
