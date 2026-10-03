// Marketr — attach a workspace-custom MCP server (milestone 21, spec §5 flow 5).
// POST   /api/connectors/mcp { workspaceId, name, endpoint, transport? }
//   → { connector: { id, key, displayName }, tools: [{ name, description, mutating }] }
//   Handshakes via McpConnectorClient to validate + capture tools before the
//   row is created. Stdio rejected unless MARKETR_SELF_HOSTED=true.
//   Admin+ or connectors.connect grant. Audited (mcp_connector_added).
// DELETE /api/connectors/mcp/[id]?workspaceId= → { ok }
//   Removes the connector, its connections, and their credentials. Audited.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { requirePermission, forbidden } from "@/lib/authz";
import { workspaceIdFrom, badRequest } from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";
import { readJsonBody } from "@/lib/sitefiles/api";
import { validateBody, z, boundedString } from "@/lib/api/validate";
import { McpConnectorClient, isStdioAllowed } from "@/lib/connectors/m21/mcp";
import { slugify } from "@/lib/skills/importer";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  workspaceId: z.string().trim().max(120).optional(),
  name: boundedString(120, "name"),
  endpoint: boundedString(2000, "endpoint"),
  transport: z.string().trim().max(40).optional(),
  // H5: tools are mutating (confirmation-gated) unless the server annotates
  // them readOnlyHint or an admin allow-lists them here.
  readOnlyTools: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
});

async function guard(req: NextRequest, body: { workspaceId?: unknown } | null, userId: string) {
  const workspaceId = workspaceIdFrom(req, body);
  if (!workspaceId) return { error: badRequest("workspaceId is required") } as const;
  if (!(await requirePermission(userId, workspaceId, "connectors.connect"))) {
    return { error: forbidden("connectors.connect permission required.") } as const;
  }
  return { workspaceId };
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const rawBody = await readJsonBody(req);
  const v = validateBody(BodySchema, rawBody);
  if (!v.ok) return v.error;
  const body = v.data;
  const g = await guard(req, body, user.id);
  if ("error" in g) return g.error;

  const name = body.name;
  const endpoint = body.endpoint;
  const isStdio = endpoint.startsWith("stdio:");
  if (!isStdio) {
    try {
      const u = new URL(endpoint);
      if (u.protocol !== "https:" && u.protocol !== "http:") {
        return badRequest("endpoint must be an http(s) URL or a stdio: command");
      }
    } catch {
      return badRequest("endpoint must be an http(s) URL or a stdio: command");
    }
  }
  if (isStdio && !isStdioAllowed()) {
    return badRequest("Stdio MCP transports are only allowed on self-hosted deployments (MARKETR_SELF_HOSTED=true).");
  }

  // Handshake first: validate the server and capture its tool list.
  const client = new McpConnectorClient();
  let tools: Array<{ name: string; description: string; mutating: boolean }>;
  try {
    const info = await client.connect(endpoint, { readOnlyTools: body.readOnlyTools ?? [] });
    tools = info.tools.map((t) => ({ name: t.name, description: t.description, mutating: t.mutating }));
  } catch (err) {
    return badRequest(`MCP handshake failed: ${err instanceof Error ? err.message : "unknown error"}`);
  } finally {
    await client.close().catch(() => {});
  }

  // Unique key within the workspace.
  let key = slugify(name) || "mcp";
  let n = 2;
  while (await prisma.connector.findFirst({ where: { workspaceId: g.workspaceId, key } })) {
    key = `${slugify(name) || "mcp"}-${n}`;
    n += 1;
  }

  const connector = await prisma.connector.create({
    data: {
      workspaceId: g.workspaceId,
      key,
      kind: "mcp",
      displayName: name.slice(0, 120),
      authType: "none",
      config: {
        endpoint,
        transport: body.transport ? body.transport : isStdio ? "stdio" : "http",
        toolCount: tools.length,
        readOnlyTools: body.readOnlyTools ?? [],
      },
      mcpEndpoint: endpoint,
      createdBy: user.id,
    },
  });

  await auditEvent({
    projectId: null,
    workspaceId: g.workspaceId,
    action: "mcp_connector_added",
    summary: `Added MCP connector "${name}" (${tools.length} tools)`,
    actorUserId: user.id,
  });
  return Response.json(
    { connector: { id: connector.id, key: connector.key, displayName: connector.displayName }, tools },
    { status: 201 },
  );
}
