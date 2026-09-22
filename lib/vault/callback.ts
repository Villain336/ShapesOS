// Marketr — M21 OAuth callback handler (spec §7 flow 3).
//
// Exchanges the authorization code for tokens server-side, encrypts the
// token payload with lib/secrets (AES-256-GCM — the ONLY approved scheme),
// and upserts ConnectorConnection (status active) + ConnectorCredential.
// No Next.js imports — the route handler stays thin. Tokens are never
// logged.
//
// Test seams: fetchImpl is injectable so verify scripts can hit a fake
// token endpoint without network.

import { prisma } from "@/lib/prisma";
import { secrets } from "@/lib/secrets";
import type { ConnectorConnection } from "@prisma/client";
import { parseOAuthState, getOAuthConfig } from "./oauth";

export interface CallbackDeps {
  fetchImpl?: typeof fetch;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

/**
 * Handle an OAuth provider callback. Returns the upserted connection.
 * Throws on invalid state, token exchange failure, or missing env config.
 */
export async function handleOAuthCallback(
  state: string,
  code: string,
  redirectUri: string,
  deps: CallbackDeps = {},
): Promise<ConnectorConnection> {
  const parsed = parseOAuthState(state);
  const config = getOAuthConfig(parsed.connectorKey);
  if (!config) {
    throw new Error(`Connector "${parsed.connectorKey}" does not support OAuth2`);
  }
  const clientId = (process.env[config.clientIdEnv] ?? "").trim();
  const clientSecret = (process.env[config.clientSecretEnv] ?? "").trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      `OAuth is not configured for "${parsed.connectorKey}": ${config.clientIdEnv}/${config.clientSecretEnv}`,
    );
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetchImpl(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  if (!res.ok) {
    // Never log the code or tokens — only the status.
    throw new Error(`Token exchange failed for "${parsed.connectorKey}" (HTTP ${res.status})`);
  }
  const token = (await res.json()) as TokenResponse;
  if (!token.access_token) {
    throw new Error(`Token exchange returned no access_token for "${parsed.connectorKey}"`);
  }

  // Non-sensitive metadata the UI may display.
  const meta: { grantedScopes?: string } = {};
  if (typeof token.scope === "string") meta.grantedScopes = token.scope;

  const credentialPayload: Record<string, unknown> = {
    access_token: token.access_token,
    ...(token.refresh_token ? { refresh_token: token.refresh_token } : {}),
    ...(token.token_type ? { token_type: token.token_type } : {}),
    client_id: clientId,
    client_secret: clientSecret,
  };
  const encryptedBlob = secrets().encrypt(JSON.stringify(credentialPayload));
  const expiresAt =
    typeof token.expires_in === "number" && Number.isFinite(token.expires_in)
      ? new Date(Date.now() + token.expires_in * 1000)
      : null;

  let connection = await prisma.connectorConnection.findFirst({
    where: {
      workspaceId: parsed.workspaceId,
      userId: parsed.userId,
      connectorKey: parsed.connectorKey,
    },
  });
  if (connection) {
    connection = await prisma.connectorConnection.update({
      where: { id: connection.id },
      data: {
        status: "active",
        scopes: config.scopes,
        meta,
        connectedAt: new Date(),
        lastRefreshAt: null,
      },
    });
  } else {
    connection = await prisma.connectorConnection.create({
      data: {
        connectorKey: parsed.connectorKey,
        workspaceId: parsed.workspaceId,
        userId: parsed.userId,
        status: "active",
        scopes: config.scopes,
        meta,
      },
    });
  }

  await prisma.connectorCredential.upsert({
    where: { connectionId: connection.id },
    update: { encryptedBlob, keyVersion: "env-v1", expiresAt },
    create: { connectionId: connection.id, encryptedBlob, keyVersion: "env-v1", expiresAt },
  });

  return connection;
}
