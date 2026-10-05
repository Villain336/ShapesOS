// ShapesOS — Phase 11 (conncore): a custom MCP server's tools with their
// group + tier mapping, for Settings → Connectors.
// GET /api/connectors/mcp/[id]/tools?workspaceId= →
//   { tools: [{ name, description, mutating, group, action, tier }], groups, actions, needsAuth }
// connectors.connect permission. Lists live from the server (OAuth servers
// with the caller's own signed-in connection); unmapped tools show the
// defaults (Connected apps; connector_write = Tier 2, always asks).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { requirePermission, forbidden } from "@/lib/authz";
import { workspaceIdFrom, badRequest, notFound } from "@/lib/route-utils";
import { getAdapterForConnection, McpBackedAdapter } from "@/lib/connectors/m21";
import { mcpOAuthConfig } from "@/lib/connectors/m21/mcp-oauth";
import { MCP_ASSIGNABLE_ACTIONS, MCP_ASSIGNABLE_GROUPS, mcpToolPolicies, DEFAULT_MCP_ACTION, DEFAULT_MCP_GROUP } from "@/lib/connectors/m21/mcp-policy";
import { KNOWN_ACTIONS } from "@/lib/automation/policy";
import { TOOL_GROUP_LABELS } from "@/lib/agents/grants";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const workspaceId = workspaceIdFrom(req);
  if (!workspaceId) return badRequest("workspaceId is required");
  if (!(await requirePermission(user.id, workspaceId, "connectors.connect"))) {
    return forbidden("connectors.connect permission required.");
  }
  const connector = await prisma.connector.findFirst({ where: { id, workspaceId, kind: "mcp" } });
  if (!connector) return notFound("MCP connector not found");

  const tiers = new Map(KNOWN_ACTIONS.map((a) => [a.action, a]));
  const actions = MCP_ASSIGNABLE_ACTIONS.map((action) =>
    action === DEFAULT_MCP_ACTION
      ? { action, label: "Unknown write (always asks)", tier: 2 }
      : { action, label: tiers.get(action)?.label ?? action, tier: tiers.get(action)?.tier ?? 2 },
  );
  const groups = MCP_ASSIGNABLE_GROUPS.map((g) => ({ group: g, label: TOOL_GROUP_LABELS[g] }));
  const policies = mcpToolPolicies(connector.config);

  const needsAuth = mcpOAuthConfig(connector.config) !== null;
  const connection = needsAuth
    ? await prisma.connectorConnection.findFirst({
        where: { workspaceId, userId: user.id, connectorKey: connector.key, status: "active" },
        select: { id: true },
      })
    : null;
  if (needsAuth && !connection) {
    return Response.json({ tools: [], groups, actions, needsAuth: true, signedIn: false });
  }
  try {
    const adapter = await getAdapterForConnection({
      connectorKey: connector.key,
      connector: { mcpEndpoint: connector.mcpEndpoint, config: connector.config },
      connectionId: connection?.id ?? null,
    });
    const listed = adapter instanceof McpBackedAdapter ? await adapter.listToolsAsync() : adapter.listTools();
    const tools = listed.map((t) => {
      const p = policies[t.name];
      const action = p?.action ?? DEFAULT_MCP_ACTION;
      return {
        name: t.name,
        description: t.description.slice(0, 300),
        mutating: t.mutating,
        group: p?.group ?? DEFAULT_MCP_GROUP,
        action,
        tier: actions.find((a) => a.action === action)?.tier ?? 2,
        mapped: Boolean(p),
      };
    });
    return Response.json({ tools, groups, actions, needsAuth, signedIn: true });
  } catch (err) {
    return badRequest(`Could not list the server's tools: ${err instanceof Error ? err.message.slice(0, 300) : "unknown error"}`);
  }
}
