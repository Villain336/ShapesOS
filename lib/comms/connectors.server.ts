// ShapesOS — Phase 18.2 (WS=comms): the member's OWN connector connections
// (Gmail, Outlook, Google Calendar, Outlook Calendar) as the Mail and
// Calendar apps read them.
//
// A mailbox or a calendar is personal: ConnectorConnection.userId is the
// member who connected it (per-user OAuth), and the Mail / Calendar apps
// show a connection only to that member. Reads go through the connector's
// own adapter (lib/connectors/m21 — the production no-fakes guard included,
// so production never shows mock rows) with the vault credential and its
// refresh-on-401, exactly like the agent loop's connector tools.
// Writes are NOT here: lib/comms/send.server.ts (mail) and
// lib/comms/calendar/write.server.ts (events) add the tier gate.

import { prisma } from "@/lib/prisma";
import type { InvokeResult } from "@/lib/connectors/m21/types";

export type PersonalConnectorKey = "gmail" | "outlook" | "google-calendar" | "outlook-calendar";

export interface PersonalConnection {
  id: string;
  connectorKey: PersonalConnectorKey;
  userId: string;
  /** The account's address when the connector stored it (meta.email / meta.account), else null. */
  account: string | null;
  connectedAt: Date;
}

function accountOf(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  for (const k of ["email", "account", "emailAddress", "userPrincipalName", "label"]) {
    const v = m[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 200);
  }
  return null;
}

/** The member's active connections of these kinds (newest first). */
export async function personalConnections(workspaceId: string, userId: string, keys: readonly PersonalConnectorKey[]): Promise<PersonalConnection[]> {
  const rows = await prisma.connectorConnection.findMany({
    where: { workspaceId, userId, status: "active", connectorKey: { in: [...keys] } },
    orderBy: { connectedAt: "desc" },
    select: { id: true, connectorKey: true, userId: true, meta: true, connectedAt: true },
  });
  return rows.map((r) => ({ id: r.id, connectorKey: r.connectorKey as PersonalConnectorKey, userId: r.userId, account: accountOf(r.meta), connectedAt: r.connectedAt }));
}

/** One of the member's own connections (null when it is not theirs, not active, or another kind). */
export async function ownConnection(workspaceId: string, userId: string, connectionId: string, keys: readonly PersonalConnectorKey[]): Promise<PersonalConnection | null> {
  const r = await prisma.connectorConnection.findFirst({
    where: { id: connectionId, workspaceId, userId, status: "active", connectorKey: { in: [...keys] } },
    select: { id: true, connectorKey: true, userId: true, meta: true, connectedAt: true },
  });
  return r ? { id: r.id, connectorKey: r.connectorKey as PersonalConnectorKey, userId: r.userId, account: accountOf(r.meta), connectedAt: r.connectedAt } : null;
}

/**
 * Call one of the connection's adapter tools with its vault credential
 * (refreshed once on a 401). A successful LIVE call is recorded as connector
 * health evidence. Never throws: failures come back as { ok: false }.
 */
export async function invokeConnection(
  conn: Pick<PersonalConnection, "id" | "connectorKey">,
  tool: string,
  args: Record<string, unknown>,
  ctx: { workspaceId: string; userId: string },
): Promise<InvokeResult> {
  try {
    const { getAdapterForConnection } = await import("@/lib/connectors/m21");
    const { loadLiveCredential } = await import("@/lib/connectors/m21/live/credentials");
    const adapter = await getAdapterForConnection({ connectorKey: conn.connectorKey, connectionId: conn.id });
    const { credential, refreshCredential } = await loadLiveCredential(conn.id);
    const res = await adapter.invoke(tool, args, credential, { workspaceId: ctx.workspaceId, userId: ctx.userId, refreshCredential });
    if (res.ok && res.mock === false) {
      const { recordSuccessfulSync } = await import("@/lib/connectors/health");
      await recordSuccessfulSync(conn.id).catch(() => undefined);
    }
    return res;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : "The connector call failed." };
  }
}
