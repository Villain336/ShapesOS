// ShapesOS — Phase 11 (conncore): OAuth 2.1 for remote MCP servers.
//
// The MCP authorization spec (2025-06-18+): a protected MCP server answers
// 401 and publishes RFC 9728 protected-resource metadata naming its
// authorization server; the client discovers RFC 8414 / OIDC metadata,
// registers itself with RFC 7591 dynamic client registration when the server
// offers it (else an admin enters a client id/secret), and runs the
// authorization-code flow with PKCE (S256) and the RFC 8707 `resource`
// parameter. The SDK's spec-tracking helpers do the protocol work
// (@modelcontextprotocol/sdk/client/auth.js: discoverOAuthServerInfo,
// registerClient, startAuthorization, exchangeAuthorization,
// refreshAuthorization); this module owns storage and our rules:
//
//   - The PKCE verifier, connector id and redirect URI travel in the vault's
//     signed + AES-GCM-encrypted OAuth state envelope (lib/vault/oauth.ts) —
//     stateless, tamper-evident, 10-minute expiry; nothing secret in the URL.
//   - The registered client (client_id, and client_secret when issued) is
//     stored on Connector.config.oauth with the secret encrypted
//     (lib/secrets); tokens are stored like every other connection: an
//     encrypted ConnectorCredential (with the token endpoint + client needed
//     to refresh), expiry in expires_at.
//   - Refresh (lib/vault/refresh.ts) calls refreshMcpPayload(); a failed
//     refresh flips the connection to needs_reauth like any provider.
//   - Every discovery / registration / token call goes through safeFetch
//     (SSRF guard: no private or metadata addresses, redirects re-checked);
//     tests inject their own fetch for a local fake authorization server.

import { randomBytes } from "node:crypto";
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { AuthorizationServerMetadata, OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { secrets } from "@/lib/secrets";
import { safeFetch } from "@/lib/connectors/safe-fetch";
import { parseOAuthState, signOAuthState, type OAuthState } from "@/lib/vault/oauth";

export type FetchFn = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** SSRF-guarded fetch for user-supplied MCP / authorization server URLs. */
export const guardedFetch: FetchFn = (url, init) => safeFetch(String(url), init ?? {});

const STATE_TTL_MS = 10 * 60 * 1000;

/** Non-secret OAuth settings kept on Connector.config.oauth. */
export interface McpOAuthConfig {
  required: true;
  authorizationServerUrl?: string;
  /** RFC 8707 resource indicator for this MCP server. */
  resource?: string;
  scope?: string;
  clientId?: string;
  /** lib/secrets envelope of the client secret (confidential clients only). */
  clientSecretEnc?: string;
  tokenEndpointAuthMethod?: string;
  /** "dcr" = registered dynamically; "manual" = entered by an admin. */
  clientSource?: "dcr" | "manual";
}

export function mcpOAuthConfig(config: unknown): McpOAuthConfig | null {
  if (!config || typeof config !== "object") return null;
  const o = (config as Record<string, unknown>).oauth;
  if (!o || typeof o !== "object" || (o as { required?: unknown }).required !== true) return null;
  return o as McpOAuthConfig;
}

/** The decrypted-credential payload shape for an MCP OAuth connection. */
export interface McpCredentialPayload {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  mcp_oauth: {
    authorizationServerUrl: string;
    tokenEndpoint: string;
    resource?: string;
    clientId: string;
    clientSecret?: string;
    tokenEndpointAuthMethod?: string;
  };
}

export interface McpAuthStart {
  url: string;
  /** Updated non-secret config (client registered now, discovery results). */
  oauth: McpOAuthConfig;
}

export interface McpOAuthStateExtra {
  kind: "mcp";
  connectorId: string;
  codeVerifier: string;
  redirectUri: string;
}

function clientFrom(oauth: McpOAuthConfig): { client_id: string; client_secret?: string; token_endpoint_auth_method?: string } {
  if (!oauth.clientId) throw new Error("This MCP server has no OAuth client yet.");
  return {
    client_id: oauth.clientId,
    ...(oauth.clientSecretEnc ? { client_secret: secrets().decrypt(oauth.clientSecretEnc) } : {}),
    ...(oauth.tokenEndpointAuthMethod ? { token_endpoint_auth_method: oauth.tokenEndpointAuthMethod } : {}),
  };
}

/**
 * Discover the server's authorization server, register a client when needed
 * (DCR), and build the authorization URL with PKCE + a signed state.
 */
export async function startMcpAuthorization(input: {
  endpoint: string;
  connectorId: string;
  connectorKey: string;
  workspaceId: string;
  userId: string;
  redirectUri: string;
  existing: McpOAuthConfig | null;
  /** Admin-entered client (servers without dynamic registration). */
  manualClient?: { clientId: string; clientSecret?: string } | null;
  fetchFn?: FetchFn;
}): Promise<McpAuthStart> {
  const fetchFn = input.fetchFn ?? guardedFetch;
  const info = await discoverOAuthServerInfo(input.endpoint, { fetchFn });
  const metadata = info.authorizationServerMetadata;
  if (!metadata) throw new Error("The MCP server's authorization server publishes no OAuth metadata.");
  const resource = info.resourceMetadata?.resource ? String(info.resourceMetadata.resource) : undefined;
  const scope = info.resourceMetadata?.scopes_supported?.join(" ") || input.existing?.scope || undefined;

  let oauth: McpOAuthConfig = {
    ...(input.existing ?? {}),
    required: true,
    authorizationServerUrl: info.authorizationServerUrl,
    resource,
    scope,
  };
  const sameServer = input.existing?.authorizationServerUrl === info.authorizationServerUrl;
  if (input.manualClient?.clientId) {
    oauth = {
      ...oauth,
      clientId: input.manualClient.clientId,
      clientSecretEnc: input.manualClient.clientSecret ? secrets().encrypt(input.manualClient.clientSecret) : undefined,
      tokenEndpointAuthMethod: input.manualClient.clientSecret ? "client_secret_post" : "none",
      clientSource: "manual",
    };
  } else if (!oauth.clientId || !sameServer) {
    if (!metadata.registration_endpoint) {
      throw new Error("This MCP server does not offer dynamic client registration — enter a client id (and secret) from its developer settings.");
    }
    const registered: OAuthClientInformationFull = await registerClient(info.authorizationServerUrl, {
      metadata,
      clientMetadata: {
        client_name: "ShapesOS",
        redirect_uris: [input.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...(scope ? { scope } : {}),
      },
      fetchFn,
    });
    oauth = {
      ...oauth,
      clientId: registered.client_id,
      clientSecretEnc: registered.client_secret ? secrets().encrypt(registered.client_secret) : undefined,
      tokenEndpointAuthMethod: registered.token_endpoint_auth_method ?? (registered.client_secret ? "client_secret_post" : "none"),
      clientSource: "dcr",
    };
  }

  const { authorizationUrl, codeVerifier } = await startAuthorization(info.authorizationServerUrl, {
    metadata,
    clientInformation: clientFrom(oauth),
    redirectUrl: input.redirectUri,
    scope,
    resource: resource ? new URL(resource) : undefined,
    state: "pending",
  });
  const extra: McpOAuthStateExtra = { kind: "mcp", connectorId: input.connectorId, codeVerifier, redirectUri: input.redirectUri };
  const state = signOAuthState({
    userId: input.userId,
    workspaceId: input.workspaceId,
    connectorKey: input.connectorKey,
    exp: Date.now() + STATE_TTL_MS,
    nonce: randomBytes(16).toString("hex"),
    ...extra,
  } as OAuthState);
  authorizationUrl.searchParams.set("state", state);
  return { url: authorizationUrl.toString(), oauth };
}

/** Verify an MCP OAuth state (signature, expiry, shape). */
export function parseMcpState(state: string): OAuthState & McpOAuthStateExtra {
  const parsed = parseOAuthState(state) as OAuthState & Partial<McpOAuthStateExtra>;
  if (parsed.kind !== "mcp" || typeof parsed.connectorId !== "string" || typeof parsed.codeVerifier !== "string" || typeof parsed.redirectUri !== "string") {
    throw new Error("Invalid OAuth state: not an MCP authorization");
  }
  return parsed as OAuthState & McpOAuthStateExtra;
}

/** Exchange the code (PKCE verifier from the state) → the credential payload to encrypt. */
export async function finishMcpAuthorization(input: {
  oauth: McpOAuthConfig;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  fetchFn?: FetchFn;
}): Promise<{ payload: McpCredentialPayload; expiresIn: number | null }> {
  const fetchFn = input.fetchFn ?? guardedFetch;
  const asUrl = input.oauth.authorizationServerUrl;
  if (!asUrl) throw new Error("MCP OAuth is not started for this server.");
  const metadata = await discoverMetadata(asUrl, fetchFn);
  const tokens = await exchangeAuthorization(asUrl, {
    metadata,
    clientInformation: clientFrom(input.oauth),
    authorizationCode: input.code,
    codeVerifier: input.codeVerifier,
    redirectUri: input.redirectUri,
    resource: input.oauth.resource ? new URL(input.oauth.resource) : undefined,
    fetchFn,
  });
  return { payload: payloadFrom(tokens, input.oauth, metadata, asUrl), expiresIn: numberOrNull(tokens.expires_in) };
}

async function discoverMetadata(asUrl: string, fetchFn: FetchFn): Promise<AuthorizationServerMetadata> {
  const { discoverAuthorizationServerMetadata } = await import("@modelcontextprotocol/sdk/client/auth.js");
  const metadata = await discoverAuthorizationServerMetadata(asUrl, { fetchFn });
  if (!metadata) throw new Error("The authorization server publishes no OAuth metadata.");
  return metadata;
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function payloadFrom(tokens: OAuthTokens, oauth: McpOAuthConfig, metadata: AuthorizationServerMetadata, asUrl: string): McpCredentialPayload {
  const client = clientFrom(oauth);
  return {
    access_token: tokens.access_token,
    ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
    ...(tokens.token_type ? { token_type: tokens.token_type } : {}),
    ...(tokens.scope ? { scope: tokens.scope } : {}),
    mcp_oauth: {
      authorizationServerUrl: asUrl,
      tokenEndpoint: String(metadata.token_endpoint),
      ...(oauth.resource ? { resource: oauth.resource } : {}),
      clientId: client.client_id,
      ...(client.client_secret ? { clientSecret: client.client_secret } : {}),
      ...(client.token_endpoint_auth_method ? { tokenEndpointAuthMethod: client.token_endpoint_auth_method } : {}),
    },
  };
}

export function isMcpPayload(p: unknown): p is McpCredentialPayload {
  return !!p && typeof p === "object" && typeof (p as { mcp_oauth?: unknown }).mcp_oauth === "object" && (p as { mcp_oauth?: unknown }).mcp_oauth !== null;
}

/** refresh_token grant for a stored MCP credential (lib/vault/refresh.ts). */
export async function refreshMcpPayload(
  payload: McpCredentialPayload,
  fetchFn: FetchFn = guardedFetch,
): Promise<{ payload: McpCredentialPayload; expiresIn: number | null }> {
  if (!payload.refresh_token) throw new Error("No refresh token");
  const m = payload.mcp_oauth;
  const tokens = await refreshAuthorization(m.authorizationServerUrl, {
    // Only the token endpoint is needed to refresh; no rediscovery.
    metadata: {
      issuer: m.authorizationServerUrl,
      authorization_endpoint: m.authorizationServerUrl,
      token_endpoint: m.tokenEndpoint,
      response_types_supported: ["code"],
      ...(m.tokenEndpointAuthMethod ? { token_endpoint_auth_methods_supported: [m.tokenEndpointAuthMethod] } : {}),
    } as AuthorizationServerMetadata,
    clientInformation: {
      client_id: m.clientId,
      ...(m.clientSecret ? { client_secret: m.clientSecret } : {}),
      ...(m.tokenEndpointAuthMethod ? { token_endpoint_auth_method: m.tokenEndpointAuthMethod } : {}),
    },
    refreshToken: payload.refresh_token,
    resource: m.resource ? new URL(m.resource) : undefined,
    fetchFn,
  });
  return {
    payload: {
      ...payload,
      access_token: tokens.access_token,
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      ...(tokens.token_type ? { token_type: tokens.token_type } : {}),
    },
    expiresIn: numberOrNull(tokens.expires_in),
  };
}

/** True when an MCP transport error is an HTTP 401 (token missing/expired). */
export function isUnauthorized(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; name?: unknown; message?: unknown };
  return e.code === 401 || e.name === "UnauthorizedError" || /\b401\b|unauthori[sz]ed/i.test(String(e.message ?? ""));
}
