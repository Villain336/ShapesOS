// ShapesOS — Phase 11 (bizsync): resolve a workspace's live connection (for
// the Settings → Connectors → Business sync routes; provider clients come
// from ./accounting/providers.ts). No mocks here: without an active
// connection + credential the callers answer "not connected".

import type { ConnectorConnection } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { loadLiveCredential } from "@/lib/connectors/m21/live/credentials";
import type { DecryptedCredential } from "@/lib/connectors/m21/types";
import type { BizProvider } from "./links";

export interface LiveConnection {
  connection: ConnectorConnection;
  credential: DecryptedCredential | null;
  refreshCredential: () => Promise<DecryptedCredential | null>;
}

/** The caller's own active connection for this provider, else the workspace's most recent one. */
export async function liveConnection(workspaceId: string, provider: BizProvider, userId: string): Promise<LiveConnection | null> {
  const rows = await prisma.connectorConnection.findMany({
    where: { workspaceId, connectorKey: provider, status: "active" },
    orderBy: { connectedAt: "desc" },
  });
  const connection = rows.find((r) => r.userId === userId) ?? rows[0];
  if (!connection) return null;
  const live = await loadLiveCredential(connection.id);
  return { connection, credential: live.credential, refreshCredential: live.refreshCredential };
}
