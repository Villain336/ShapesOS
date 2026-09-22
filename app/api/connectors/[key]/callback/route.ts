// Marketr — connector OAuth callback (milestone 21, spec §5 flow 3).
// GET /api/connectors/[key]/callback?code=&state= → 302 redirect.
// The signed state carries userId/workspaceId/connectorKey, so no session
// is needed here. Audits connector_connected on success.

import type { NextRequest } from "next/server";
import { auditEvent } from "@/lib/auditlog";
import { handleOAuthCallback } from "@/lib/vault/callback";
import { recordSuccessfulSync } from "@/lib/connectors/health";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const origin = req.nextUrl.origin;
  const done = `${origin}/dashboard/settings/connectors?connected=${encodeURIComponent(key)}`;
  const failed = `${origin}/dashboard/settings/connectors?error=oauth_failed`;
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  if (!code || !state) return Response.redirect(failed, 302);
  try {
    const redirectUri = `${origin}/api/connectors/${encodeURIComponent(key)}/callback`;
    const connection = await handleOAuthCallback(state, code, redirectUri);
    // A completed token exchange is a real provider interaction — honest
    // evidence for the health checker (Phase B, track B3).
    await recordSuccessfulSync(connection.id);
    await auditEvent({
      projectId: null,
      workspaceId: connection.workspaceId,
      action: "connector_connected",
      summary: `Connected ${key} (OAuth)`,
      actorUserId: connection.userId,
    });
    return Response.redirect(done, 302);
  } catch {
    return Response.redirect(failed, 302);
  }
}
