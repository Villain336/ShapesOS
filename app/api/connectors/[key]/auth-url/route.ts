// Marketr — connector OAuth (milestone 21, spec §5 flow 3).
// GET /api/connectors/[key]/auth-url?workspaceId= → { url }
//   Admin+ or connectors.connect grant. Builds the provider authorize URL
//   via startOAuthFlow; the registered redirect_uri is the per-connector
//   callback route below (lib/vault/oauth appends a fixed "/api/oauth/callback"
//   suffix to its redirectBase, so we override the param to match).
// GET /api/connectors/[key]/callback?code=&state= → 302
//   Exchanges the code (state is signed — no session needed), audits
//   connector_connected, redirects to the connectors settings page.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { requirePermission, forbidden } from "@/lib/authz";
import { workspaceIdFrom, badRequest } from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";
import { startOAuthFlow } from "@/lib/vault/oauth";
import { handleOAuthCallback } from "@/lib/vault/callback";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ key: string }> };

function callbackUrl(req: NextRequest, key: string): string {
  return `${req.nextUrl.origin}/api/connectors/${encodeURIComponent(key)}/callback`;
}

export async function GET(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { key } = await params;
  const workspaceId = workspaceIdFrom(req);
  if (!workspaceId) return badRequest("workspaceId is required");
  if (!(await requirePermission(user.id, workspaceId, "connectors.connect"))) {
    return forbidden("connectors.connect permission required.");
  }
  try {
    const { url } = startOAuthFlow(user.id, workspaceId, key, req.nextUrl.origin);
    const u = new URL(url);
    u.searchParams.set("redirect_uri", callbackUrl(req, key));
    return Response.json({ url: u.toString() });
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : "OAuth flow could not be started");
  }
}
