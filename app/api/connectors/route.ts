// Marketr — connector catalog + workspace connections (milestone 21).
// GET /api/connectors?workspaceId= → { connectors: [{
//   key, displayName, kind: "native"|"mcp", authType, description, custom,
//   connections: [{ id, userId, status, scopes, meta, connectedAt }]
// }] } (viewer+). Credential blobs are never returned.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { workspaceIdFrom, requireWorkspaceAccess } from "@/lib/route-utils";
import { listBuiltinConnectors } from "@/lib/connectors/m21/registry";

export const dynamic = "force-dynamic";

function publicConnection(c: {
  id: string;
  userId: string;
  status: string;
  scopes: string[];
  meta: unknown;
  connectedAt: Date;
}) {
  return {
    id: c.id,
    userId: c.userId,
    status: c.status,
    scopes: c.scopes,
    meta: c.meta,
    connectedAt: c.connectedAt.toISOString(),
  };
}

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "viewer");
  if ("error" in access) return access.error;

  const [connections, customs] = await Promise.all([
    prisma.connectorConnection.findMany({
      where: { workspaceId: access.workspaceId },
      orderBy: { connectedAt: "desc" },
    }),
    prisma.connector.findMany({
      where: { workspaceId: access.workspaceId },
      orderBy: { displayName: "asc" },
    }),
  ]);
  const byKey = new Map<string, typeof connections>();
  for (const c of connections) {
    const list = byKey.get(c.connectorKey) ?? [];
    list.push(c);
    byKey.set(c.connectorKey, list);
  }

  const natives = listBuiltinConnectors().map((m) => ({
    key: m.key,
    displayName: m.displayName,
    kind: "native" as const,
    authType: m.authType,
    description: m.description,
    custom: false,
    connections: (byKey.get(m.key) ?? []).map(publicConnection),
  }));
  const customList = customs.map((c) => {
    const config = (c.config ?? {}) as Record<string, unknown>;
    return {
      key: c.key,
      id: c.id, // DB id: used by DELETE /api/connectors/mcp/[id].
      displayName: c.displayName,
      kind: c.kind,
      authType: c.authType,
      description: typeof config.description === "string" ? config.description : null,
      custom: true,
      connections: (byKey.get(c.key) ?? []).map(publicConnection),
    };
  });

  return Response.json({ connectors: [...natives, ...customList] });
}
