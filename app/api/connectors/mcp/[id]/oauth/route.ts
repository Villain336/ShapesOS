// ShapesOS — Phase 11 (conncore): start OAuth 2.1 sign-in for a custom MCP server.
// POST /api/connectors/mcp/[id]/oauth { workspaceId, clientId?, clientSecret? } → { url }
//
// connectors.connect permission (admin+ or grant). Discovers the server's
// authorization server (RFC 9728 → RFC 8414/OIDC), registers ShapesOS with
// dynamic client registration when offered — or uses the client id/secret
// an admin entered for servers without it — and returns the authorization
// URL (PKCE S256 + RFC 8707 resource; the verifier rides in the encrypted,
// signed state). The browser goes there; the server redirects back to
// GET /api/connectors/mcp/oauth/callback. Every call to the user-supplied
// hosts goes through safeFetch (SSRF guard). Audited.

import type { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { requirePermission, forbidden } from "@/lib/authz";
import { workspaceIdFrom, badRequest, notFound } from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";
import { readJsonBody } from "@/lib/sitefiles/api";
import { validateBody, z } from "@/lib/api/validate";
import { mcpOAuthConfig, startMcpAuthorization } from "@/lib/connectors/m21/mcp-oauth";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  workspaceId: z.string().trim().max(120).optional(),
  clientId: z.string().trim().min(1).max(300).optional(),
  clientSecret: z.string().trim().min(1).max(500).optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const v = validateBody(BodySchema, (await readJsonBody(req)) ?? {});
  if (!v.ok) return v.error;
  const workspaceId = workspaceIdFrom(req, v.data);
  if (!workspaceId) return badRequest("workspaceId is required");
  if (!(await requirePermission(user.id, workspaceId, "connectors.connect"))) {
    return forbidden("connectors.connect permission required.");
  }
  const connector = await prisma.connector.findFirst({ where: { id, workspaceId } });
  if (!connector || connector.kind !== "mcp") return notFound("MCP connector not found");
  if (!connector.mcpEndpoint || connector.mcpEndpoint.startsWith("stdio:")) {
    return badRequest("Only remote (HTTP) MCP servers use OAuth.");
  }
  const config = connector.config && typeof connector.config === "object" && !Array.isArray(connector.config)
    ? (connector.config as Record<string, unknown>)
    : {};
  try {
    const started = await startMcpAuthorization({
      endpoint: connector.mcpEndpoint,
      connectorId: connector.id,
      connectorKey: connector.key,
      workspaceId,
      userId: user.id,
      redirectUri: `${req.nextUrl.origin}/api/connectors/mcp/oauth/callback`,
      existing: mcpOAuthConfig(config),
      manualClient: v.data.clientId ? { clientId: v.data.clientId, clientSecret: v.data.clientSecret } : null,
    });
    await prisma.connector.update({
      where: { id: connector.id },
      data: { authType: "oauth2", config: { ...config, oauth: started.oauth } as unknown as Prisma.InputJsonValue },
    });
    await auditEvent({
      projectId: null,
      workspaceId,
      action: "settings_workspace_updated",
      summary: `MCP connector "${connector.displayName}": OAuth sign-in started (${started.oauth.clientSource === "manual" ? "admin-entered client" : "dynamic client registration"})`,
      actorUserId: user.id,
    });
    return Response.json({ url: started.url });
  } catch (err) {
    return badRequest(`Could not start sign-in: ${err instanceof Error ? err.message.slice(0, 300) : "unknown error"}`);
  }
}
