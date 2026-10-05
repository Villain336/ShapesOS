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
import { parseOAuthState, getOAuthConfig, buildTokenRequest, shopUrl, type OAuthProviderConfig } from "./oauth";

export interface CallbackDeps {
  fetchImpl?: typeof fetch;
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

/**
 * Exchange an authorization code for tokens at the provider's token
 * endpoint. Shared by the M21 callback and the Phase 18 ads callbacks.
 * Never logs the code or the tokens — only the status.
 */
export async function exchangeCodeForTokens(
  config: OAuthProviderConfig,
  connectorKey: string,
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
  /** Phase 11 (devtools): PKCE code verifier from the signed state. */
  codeVerifier?: string,
): Promise<OAuthTokenResponse> {
  const clientId = (process.env[config.clientIdEnv] ?? "").trim();
  const clientSecret = (process.env[config.clientSecretEnv] ?? "").trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      `OAuth is not configured for "${connectorKey}": ${config.clientIdEnv}/${config.clientSecretEnv}`,
    );
  }
  const res = await fetchImpl(
    config.tokenUrl,
    buildTokenRequest(
      config,
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
      },
      clientId,
      clientSecret,
    ),
  );
  if (!res.ok) {
    throw new Error(`Token exchange failed for "${connectorKey}" (HTTP ${res.status})`);
  }
  const token = (await res.json()) as OAuthTokenResponse;
  if (!token.access_token) {
    throw new Error(`Token exchange returned no access_token for "${connectorKey}"`);
  }
  return token;
}

/**
 * Persist an OAuth token payload in the vault: upsert ConnectorConnection
 * (status active) + ConnectorCredential with the AES-256-GCM encrypted blob.
 * Shared by the M21 callback and the Phase 18 ads callbacks.
 */
export async function storeOAuthTokens(input: {
  userId: string;
  workspaceId: string;
  connectorKey: string;
  token: OAuthTokenResponse;
  scopes: string[];
  /** Phase 11 (bizsync): non-secret routing ids (shop, realmId) for meta + payload. */
  routing?: Record<string, string>;
}): Promise<ConnectorConnection> {
  const { userId, workspaceId, connectorKey, token, scopes } = input;
  const routing = input.routing ?? {};
  const config = getOAuthConfig(connectorKey);
  const clientId = (process.env[config?.clientIdEnv ?? ""] ?? "").trim();
  const clientSecret = (process.env[config?.clientSecretEnv ?? ""] ?? "").trim();

  // Non-sensitive metadata the UI may display.
  const meta: Record<string, string> = {};
  if (typeof token.scope === "string") meta.grantedScopes = token.scope;
  // Phase 11 (conncore): provider routing metadata (e.g. Slack team id).
  Object.assign(meta, config?.tokenMeta?.(token as unknown as Record<string, unknown>) ?? {});
  Object.assign(meta, routing);

  const credentialPayload: Record<string, unknown> = {
    access_token: token.access_token,
    ...(token.refresh_token ? { refresh_token: token.refresh_token } : {}),
    ...(token.token_type ? { token_type: token.token_type } : {}),
    client_id: clientId,
    client_secret: clientSecret,
    // Phase 11 (bizsync): adapters address the store / company with these.
    ...routing,
  };
  const encryptedBlob = secrets().encrypt(JSON.stringify(credentialPayload));
  const expiresAt =
    typeof token.expires_in === "number" && Number.isFinite(token.expires_in)
      ? new Date(Date.now() + token.expires_in * 1000)
      : null;

  let connection = await prisma.connectorConnection.findFirst({
    where: { workspaceId, userId, connectorKey },
  });
  if (connection) {
    connection = await prisma.connectorConnection.update({
      where: { id: connection.id },
      data: {
        status: "active",
        scopes,
        meta,
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
        scopes,
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

/**
 * Handle an OAuth provider callback. Returns the upserted connection.
 * Throws on invalid state, token exchange failure, or missing env config.
 */
export async function handleOAuthCallback(
  state: string,
  code: string,
  redirectUri: string,
  deps: CallbackDeps = {},
  /** Phase 11 (bizsync): the full callback query (Shopify hmac/shop, QuickBooks realmId). */
  query: Record<string, string> = {},
): Promise<ConnectorConnection> {
  const parsed = parseOAuthState(state);
  let config = getOAuthConfig(parsed.connectorKey);
  if (!config) {
    throw new Error(`Connector "${parsed.connectorKey}" does not support OAuth2`);
  }
  // Phase 11 (devtools): a PKCE provider needs the verifier minted at start.
  if (config.pkce && !parsed.cv) {
    throw new Error(`Invalid OAuth state: missing PKCE verifier for "${parsed.connectorKey}"`);
  }
  // Phase 11 (bizsync): a per-shop provider (Shopify) — the callback must be
  // for the store the signed state names, signed by Shopify with our app
  // secret; the token exchange goes to that store's host.
  if (config.perShop) {
    const { verifyShopifyOAuthHmac, normalizeShopDomain } = await import("@/lib/bizsync/shopify/shop");
    const secret = (process.env[config.clientSecretEnv] ?? "").trim();
    if (!parsed.shop || normalizeShopDomain(query.shop) !== parsed.shop) throw new Error("OAuth callback shop does not match the flow");
    if (!verifyShopifyOAuthHmac(query, secret)) throw new Error("OAuth callback signature is invalid");
    config = { ...config, tokenUrl: shopUrl(config.tokenUrl, parsed.shop) };
  }
  const token = await exchangeCodeForTokens(
    config,
    parsed.connectorKey,
    code,
    redirectUri,
    deps.fetchImpl ?? fetch,
    config.pkce ? parsed.cv : undefined,
  );
  const connection = await storeOAuthTokens({
    userId: parsed.userId,
    workspaceId: parsed.workspaceId,
    connectorKey: parsed.connectorKey,
    token,
    scopes: config.scopes,
    routing: { ...(config.callbackMeta?.(query, parsed) ?? {}), ...(config.refreshWithRedirectUri ? { redirect_uri: redirectUri } : {}) },
  });
  // Phase 11 (bizsync): Shopify webhook route / Xero tenant discovery.
  if (parsed.connectorKey === "shopify" || parsed.connectorKey === "xero" || parsed.connectorKey === "gusto") {
    const { onBizsyncConnected } = await import("@/lib/bizsync/install");
    await onBizsyncConnected({ connectorKey: parsed.connectorKey, connection, fetchImpl: deps.fetchImpl });
  }
  // Phase 11 (conncore): a Slack install also records the team → workspace
  // route the Events API receiver needs (lib/slack/install.ts).
  if (parsed.connectorKey === "slack") {
    const { recordSlackInstall } = await import("@/lib/slack/install");
    await recordSlackInstall({ workspaceId: parsed.workspaceId, userId: parsed.userId, connectionId: connection.id, meta: connection.meta });
  }
  return connection;
}
