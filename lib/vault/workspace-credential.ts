// ShapesOS — Phase 15.1: workspace-level credentials in the EXISTING vault.
//
// Some keys belong to the workspace, not to the admin who typed them: the
// workspace's own model keys (BYOK), its own sidecar instances (Postiz,
// Listmonk, … on hosted) and its outreach sending accounts (Smartlead /
// Instantly). They use the same storage as every connector credential
// (connector_connections + connector_credentials, encrypted with secrets(),
// lib/vault/apikey.ts) with one rule on top: exactly ONE connection per
// (workspace, connectorKey) — storing replaces any earlier one, whoever
// stored it. Payloads are decrypted server-side only; meta() is the
// client-safe view (who and when, never a secret).

import { prisma } from "@/lib/prisma";
import { deleteConnection, storeCredentialPayload } from "./apikey";
import { getDecryptedCredential } from "./refresh";

/** Store (replace) the workspace's credential for a connector key. */
export async function storeWorkspaceCredential(
  userId: string,
  workspaceId: string,
  connectorKey: string,
  label: string,
  payload: Record<string, unknown>,
): Promise<{ connectionId: string }> {
  const prior = await prisma.connectorConnection.findMany({
    where: { workspaceId, connectorKey, NOT: { userId } },
    select: { id: true },
  });
  for (const p of prior) await deleteConnection(p.id, workspaceId);
  const conn = await storeCredentialPayload(userId, workspaceId, connectorKey, label, payload);
  return { connectionId: conn.id };
}

/** Remove the workspace's credential(s) for a connector key. Returns the count. */
export async function removeWorkspaceCredential(workspaceId: string, connectorKey: string): Promise<number> {
  const rows = await prisma.connectorConnection.findMany({
    where: { workspaceId, connectorKey },
    select: { id: true },
  });
  for (const r of rows) await deleteConnection(r.id, workspaceId);
  return rows.length;
}

/** SERVER ONLY: the decrypted payloads of the workspace's active credentials for these keys. */
export async function loadWorkspaceCredentials(
  workspaceId: string,
  connectorKeys: readonly string[],
): Promise<Record<string, Record<string, unknown>>> {
  if (connectorKeys.length === 0) return {};
  const rows = await prisma.connectorConnection.findMany({
    where: { workspaceId, connectorKey: { in: [...connectorKeys] }, status: "active" },
    select: { id: true, connectorKey: true },
    orderBy: { connectedAt: "desc" },
  });
  const out: Record<string, Record<string, unknown>> = {};
  for (const r of rows) {
    if (out[r.connectorKey]) continue; // newest wins
    const cred = await getDecryptedCredential(r.id).catch(() => null);
    if (cred?.payload) out[r.connectorKey] = cred.payload;
  }
  return out;
}

export interface WorkspaceCredentialMeta {
  connectorKey: string;
  connectedAt: string;
  connectedBy: string;
}

/** Client-safe: which of these keys the workspace has, who stored them and when. */
export async function workspaceCredentialMeta(
  workspaceId: string,
  connectorKeys: readonly string[],
): Promise<Record<string, WorkspaceCredentialMeta>> {
  const rows = await prisma.connectorConnection.findMany({
    where: { workspaceId, connectorKey: { in: [...connectorKeys] }, status: "active" },
    select: { connectorKey: true, connectedAt: true, userId: true },
    orderBy: { connectedAt: "desc" },
  });
  const out: Record<string, WorkspaceCredentialMeta> = {};
  for (const r of rows) {
    if (out[r.connectorKey]) continue;
    out[r.connectorKey] = { connectorKey: r.connectorKey, connectedAt: r.connectedAt.toISOString(), connectedBy: r.userId };
  }
  return out;
}
