// ShapesOS — Phase 4b live liveness check for one connection.
//
// Used ONLY by the manual "Check now" route (POST /api/connections/[id]/check),
// never by the scheduled checker. It calls the adapter's healthCheck(),
// which hits one cheap, fixed provider endpoint (e.g. GSC sites list, GA4
// account summaries, Drive about, Notion users/me) — never a user-supplied
// URL. Returns a closed error code only; provider text stays here.

import { prisma } from "@/lib/prisma";
import { resolveAdapter, isBuiltinKey } from "../registry";
import { loadLiveCredential } from "./credentials";
import type { ConnectorErrorCode } from "./http";

export interface ProbeOutcome {
  ok: boolean;
  errorCode?: ConnectorErrorCode;
}

/** null when the connector has no live health check (custom MCP, api-key adapters). */
export async function probeConnection(connectionId: string): Promise<ProbeOutcome | null> {
  const connection = await prisma.connectorConnection.findUnique({
    where: { id: connectionId },
    select: { connectorKey: true, workspaceId: true, userId: true },
  });
  if (!connection || !isBuiltinKey(connection.connectorKey)) return null;
  const adapter = resolveAdapter(connection.connectorKey);
  if (typeof adapter.healthCheck !== "function") return null;
  const { credential, refreshCredential } = await loadLiveCredential(connectionId);
  if (!credential) return { ok: false, errorCode: "not_connected" };
  const res = await adapter.healthCheck(credential, {
    workspaceId: connection.workspaceId,
    userId: connection.userId,
    refreshCredential,
  });
  if (res.ok) return { ok: true };
  return { ok: false, errorCode: (res.errorCode as ConnectorErrorCode | undefined) ?? "provider_error" };
}
