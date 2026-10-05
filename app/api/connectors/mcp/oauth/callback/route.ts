// ShapesOS — Phase 11 (conncore): OAuth 2.1 callback for custom MCP servers.
// GET /api/connectors/mcp/oauth/callback?code=&state= → 302 to Settings → Connectors.
//
// The state is the vault's signed + encrypted envelope (lib/vault/oauth.ts):
// it names the user, workspace and connector and carries the PKCE verifier,
// so no session is needed (like /api/connectors/[key]/callback) and a forged
// or expired state is rejected before anything else. The code is exchanged
// at the authorization server recorded on the connector (safeFetch); the
// tokens are stored encrypted on the user's connection for that connector.
// Never logs the code or the tokens. Audited (connector_connected).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { secrets } from "@/lib/secrets";
import { auditEvent } from "@/lib/auditlog";
import { recordSuccessfulSync } from "@/lib/connectors/health";
import { finishMcpAuthorization, mcpOAuthConfig, parseMcpState } from "@/lib/connectors/m21/mcp-oauth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const failed = `${origin}/dashboard/settings/connectors?error=oauth_failed`;
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  if (!code || !state) return Response.redirect(failed, 302);
  try {
    const parsed = parseMcpState(state);
    const connector = await prisma.connector.findFirst({ where: { id: parsed.connectorId, workspaceId: parsed.workspaceId, kind: "mcp" } });
    const oauth = mcpOAuthConfig(connector?.config);
    if (!connector || !oauth || connector.key !== parsed.connectorKey) return Response.redirect(failed, 302);
    const { payload, expiresIn } = await finishMcpAuthorization({
      oauth,
      code,
      codeVerifier: parsed.codeVerifier,
      redirectUri: parsed.redirectUri,
    });
    const encryptedBlob = secrets().encrypt(JSON.stringify(payload));
    const expiresAt = expiresIn !== null ? new Date(Date.now() + expiresIn * 1000) : null;
    const existing = await prisma.connectorConnection.findFirst({
      where: { workspaceId: parsed.workspaceId, userId: parsed.userId, connectorKey: connector.key },
    });
    const connection = existing
      ? await prisma.connectorConnection.update({
          where: { id: existing.id },
          data: { status: "active", connectorId: connector.id, scopes: payload.scope ? payload.scope.split(" ") : [], connectedAt: new Date(), lastRefreshAt: null },
        })
      : await prisma.connectorConnection.create({
          data: {
            connectorKey: connector.key,
            connectorId: connector.id,
            workspaceId: parsed.workspaceId,
            userId: parsed.userId,
            status: "active",
            scopes: payload.scope ? payload.scope.split(" ") : [],
          },
        });
    await prisma.connectorCredential.upsert({
      where: { connectionId: connection.id },
      update: { encryptedBlob, keyVersion: "env-v1", expiresAt },
      create: { connectionId: connection.id, encryptedBlob, keyVersion: "env-v1", expiresAt },
    });
    await recordSuccessfulSync(connection.id).catch(() => undefined);
    await auditEvent({
      projectId: null,
      workspaceId: parsed.workspaceId,
      action: "connector_connected",
      summary: `Signed in to MCP server "${connector.displayName}" (OAuth)`,
      actorUserId: parsed.userId,
    });
    return Response.redirect(`${origin}/dashboard/settings/connectors?connected=${encodeURIComponent(connector.key)}`, 302);
  } catch {
    return Response.redirect(failed, 302);
  }
}
