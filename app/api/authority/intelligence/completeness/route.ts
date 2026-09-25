// Marketr — GET /api/authority/intelligence/completeness
// Per-connector status + completeness labels for the whole stack.

import type { NextRequest } from "next/server";
import { authorityGuard, safetyError } from "@/app/api/authority/_lib";
import { buildAuditContext } from "@/lib/authority/intelligence/connectors";
import { CONNECTOR_DEFS } from "@/lib/authority/intelligence/connectors";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  const gate = await authorityGuard("viewer");
  if (gate instanceof Response) return gate;
  try {
    const ctx = await buildAuditContext(gate.workspaceId, gate.userId);
    const connectors = CONNECTOR_DEFS.map((def) => ({
      ...ctx.connectors[def.key],
      contributesTo: def.contributesTo,
      description: def.description,
    }));
    const connected = connectors.filter((c) => c.status === "connected").length;
    const fixtures = connectors.filter((c) => c.status === "fixture").length;
    return Response.json({
      connectors,
      summary: { total: connectors.length, connected, fixtures, disconnected: connectors.length - connected - fixtures },
      projectDomain: ctx.projectDomain,
    });
  } catch (err) {
    return safetyError(err);
  }
}
