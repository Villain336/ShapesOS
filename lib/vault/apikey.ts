// Marketr — M21 API-key vault (spec §7).
//
// Stores API-key credentials with the same encrypted storage and the same
// ConnectorConnection model as OAuth — the agent-facing layer never knows
// which auth type a connection used. Tokens are never logged.

import { prisma } from "@/lib/prisma";
import { secrets } from "@/lib/secrets";
import type { ConnectorConnection } from "@prisma/client";

export interface StoreApiKeyOpts {
  /** Extra non-secret-ish config merged into the credential payload (e.g. baseUrl, username). */
  extra?: Record<string, unknown>;
  /** Scopes for the connection row (informational). */
  scopes?: string[];
  expiresAt?: Date | null;
}

/**
 * Store an API key for a connector. Upserts the connection (status active,
 * meta.label) and its encrypted credential. Returns the connection.
 */
export async function storeApiKey(
  userId: string,
  workspaceId: string,
  connectorKey: string,
  label: string,
  apiKey: string,
  opts: StoreApiKeyOpts = {},
): Promise<ConnectorConnection> {
  if (!apiKey.trim()) throw new Error("API key must not be empty");
  return storeCredentialPayload(userId, workspaceId, connectorKey, label, { apiKey, ...(opts.extra ?? {}) }, opts);
}

/**
 * Phase 11 (devtools): store an arbitrary non-OAuth credential payload (e.g.
 * the Netlify connector's { hostingConnectionId } reference to an existing
 * hosting connection — the token itself stays in that connection). Same
 * upsert + encryption as storeApiKey, which delegates here.
 */
export async function storeCredentialPayload(
  userId: string,
  workspaceId: string,
  connectorKey: string,
  label: string,
  payload: Record<string, unknown>,
  opts: Omit<StoreApiKeyOpts, "extra"> = {},
): Promise<ConnectorConnection> {
  const encryptedBlob = secrets().encrypt(JSON.stringify(payload));

  let connection = await prisma.connectorConnection.findFirst({
    where: { workspaceId, userId, connectorKey },
  });
  if (connection) {
    connection = await prisma.connectorConnection.update({
      where: { id: connection.id },
      data: {
        status: "active",
        scopes: opts.scopes ?? [],
        meta: { label },
        connectedAt: new Date(),
        lastRefreshAt: null,
      },
    });
  } else {
    connection = await prisma.connectorConnection.create({
      data: {
        connectorKey,
        workspaceId,
        userId,
        status: "active",
        scopes: opts.scopes ?? [],
        meta: { label },
      },
    });
  }

  await prisma.connectorCredential.upsert({
    where: { connectionId: connection.id },
    update: {
      encryptedBlob,
      keyVersion: "env-v1",
      expiresAt: opts.expiresAt ?? null,
    },
    create: {
      connectionId: connection.id,
      encryptedBlob,
      keyVersion: "env-v1",
      expiresAt: opts.expiresAt ?? null,
    },
  });

  return connection;
}

/**
 * Delete a connection and its credential. Credential row first (the FK
 * also cascades, but explicit-first avoids leaving an orphaned row if the
 * second write ever races). Scoped to the workspace — fail closed on a
 * cross-workspace id.
 */
export async function deleteConnection(
  connectionId: string,
  workspaceId: string,
): Promise<void> {
  const connection = await prisma.connectorConnection.findFirst({
    where: { id: connectionId, workspaceId },
    select: { id: true },
  });
  if (!connection) {
    throw new Error(`Connection "${connectionId}" not found in this workspace`);
  }
  await prisma.connectorCredential.deleteMany({ where: { connectionId } });
  await prisma.connectorConnection.delete({ where: { id: connectionId } });
}
