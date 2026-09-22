// Marketr — M21 token refresh (spec §7 flow 3).
//
// Silent refresh: decrypt the stored credential, use the refresh_token
// grant at the provider's token endpoint, and on success update the
// credential blob + lastRefreshAt. Any failure (no refresh token, provider
// rejects) flips the connection to needs_reauth so the next use prompts a
// one-click re-auth. Tokens are never logged.
//
// Test seam: fetchImpl is injectable so verify scripts can use a fake token
// endpoint without network.

import { prisma } from "@/lib/prisma";
import { secrets } from "@/lib/secrets";
import type { DecryptedCredential } from "@/lib/connectors/m21/types";
import { getOAuthConfig } from "./oauth";

export interface RefreshDeps {
  fetchImpl?: typeof fetch;
}

/** Fetch the connector's authType from the registry (built-in) or fall back to "none". */
export async function getConnectionAuthType(
  connectorKey: string,
): Promise<"oauth2" | "api_key" | "none"> {
  const { getBuiltinMeta } = await import("@/lib/connectors/m21/registry");
  try {
    return getBuiltinMeta(connectorKey).authType === "oauth2" ? "oauth2" : "api_key";
  } catch {
    return "none";
  }
}

/**
 * Decrypt a connection's stored credential. Returns null when there is no
 * connection or no credential row. Never throws on missing rows.
 */
export async function getDecryptedCredential(
  connectionId: string,
): Promise<DecryptedCredential | null> {
  const connection = await prisma.connectorConnection.findUnique({
    where: { id: connectionId },
    include: { credential: true },
  });
  if (!connection?.credential) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(secrets().decrypt(connection.credential.encryptedBlob)) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
  const kind: DecryptedCredential["kind"] =
    typeof payload.access_token === "string" ? "oauth2" : "api_key";
  return { kind, payload };
}

interface RefreshTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
}

/**
 * Attempt a silent token refresh. Returns "refreshed" on success;
 * "needs_reauth" when the connection has no refresh token or the provider
 * rejects the grant (the status is flipped in the DB in that case).
 */
export async function refreshConnection(
  connectionId: string,
  deps: RefreshDeps = {},
): Promise<"refreshed" | "needs_reauth"> {
  const connection = await prisma.connectorConnection.findUnique({
    where: { id: connectionId },
  });
  if (!connection) return "needs_reauth";

  const credential = await getDecryptedCredential(connectionId);
  const payload = credential?.payload;
  const refreshToken =
    payload && typeof payload.refresh_token === "string" ? payload.refresh_token : null;
  const config = getOAuthConfig(connection.connectorKey);
  const clientId = typeof payload?.client_id === "string" ? payload.client_id : "";
  const clientSecret = typeof payload?.client_secret === "string" ? payload.client_secret : "";

  if (!refreshToken || !config || !clientId || !clientSecret) {
    await markNeedsReauth(connectionId);
    return "needs_reauth";
  }

  try {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });
    const res = await fetchImpl(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
    if (!res.ok) {
      await markNeedsReauth(connectionId);
      return "needs_reauth";
    }
    const token = (await res.json()) as RefreshTokenResponse;
    if (!token.access_token || token.error) {
      await markNeedsReauth(connectionId);
      return "needs_reauth";
    }

    const next: Record<string, unknown> = {
      ...payload,
      access_token: token.access_token,
      // Some providers rotate the refresh token; keep the old one if no new one is issued.
      ...(token.refresh_token ? { refresh_token: token.refresh_token } : {}),
      ...(token.token_type ? { token_type: token.token_type } : {}),
    };
    const expiresAt =
      typeof token.expires_in === "number" && Number.isFinite(token.expires_in)
        ? new Date(Date.now() + token.expires_in * 1000)
        : null;

    await prisma.connectorCredential.update({
      where: { connectionId },
      data: { encryptedBlob: secrets().encrypt(JSON.stringify(next)), keyVersion: "env-v1", expiresAt },
    });
    await prisma.connectorConnection.update({
      where: { id: connectionId },
      data: { status: "active", lastRefreshAt: new Date() },
    });
    return "refreshed";
  } catch {
    // Network failure during refresh: keep the status transition to
    // needs_reauth so the operator sees it; the next cron run will retry
    // after a fresh connect.
    await markNeedsReauth(connectionId);
    return "needs_reauth";
  }
}

async function markNeedsReauth(connectionId: string): Promise<void> {
  await prisma.connectorConnection.update({
    where: { id: connectionId },
    data: { status: "needs_reauth" },
  });
}
