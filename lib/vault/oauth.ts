// Marketr — M21 OAuth vault (spec §7 flow 3).
//
// Starts OAuth consent flows and validates the signed state envelope.
// Stateless: the state is an AES-256-GCM envelope (via lib/secrets — the
// ONLY approved crypto scheme) carrying { userId, workspaceId, connectorKey,
// exp, nonce }, base64url-encoded so it survives the round-trip as a query
// param. No DB write happens until the callback exchanges the code.
//
// All functions take explicit params — no Next.js imports — so route
// handlers stay thin. Tokens are never logged.

import { randomBytes } from "crypto";
import { secrets } from "@/lib/secrets";
import { getBuiltinMeta } from "@/lib/connectors/m21/registry";

export interface OAuthProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  /** Default scopes for this connector (registry oauth.scopes take precedence when present). */
  scopes: string[];
  clientIdEnv: string;
  clientSecretEnv: string;
  /** Extra static params merged into the authorize URL (e.g. response_type). */
  extra?: Record<string, string>;
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_ID_ENV = "GOOGLE_OAUTH_CLIENT_ID";
const GOOGLE_SECRET_ENV = "GOOGLE_OAUTH_CLIENT_SECRET";

/** OAuth config per built-in connector that uses OAuth2. Non-OAuth keys are absent. */
export const OAUTH_CONFIGS: Record<string, OAuthProviderConfig> = {
  "google-search-console": {
    authorizeUrl: GOOGLE_AUTH_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    clientIdEnv: GOOGLE_ID_ENV,
    clientSecretEnv: GOOGLE_SECRET_ENV,
    extra: { access_type: "offline", prompt: "consent" },
  },
  ga4: {
    authorizeUrl: GOOGLE_AUTH_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
    clientIdEnv: GOOGLE_ID_ENV,
    clientSecretEnv: GOOGLE_SECRET_ENV,
    extra: { access_type: "offline", prompt: "consent" },
  },
  "google-drive": {
    authorizeUrl: GOOGLE_AUTH_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    scopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.file",
    ],
    clientIdEnv: GOOGLE_ID_ENV,
    clientSecretEnv: GOOGLE_SECRET_ENV,
    extra: { access_type: "offline", prompt: "consent" },
  },
  notion: {
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    scopes: [],
    clientIdEnv: "NOTION_OAUTH_CLIENT_ID",
    clientSecretEnv: "NOTION_OAUTH_CLIENT_SECRET",
  },
  webflow: {
    authorizeUrl: "https://webflow.com/oauth/authorize",
    tokenUrl: "https://api.webflow.com/oauth/access_token",
    scopes: ["cms:read", "cms:write", "sites:read", "sites:write"],
    clientIdEnv: "WEBFLOW_OAUTH_CLIENT_ID",
    clientSecretEnv: "WEBFLOW_OAUTH_CLIENT_SECRET",
  },
  buffer: {
    authorizeUrl: "https://bufferapp.com/oauth2/authorize",
    tokenUrl: "https://api.bufferapp.com/1/oauth/token.json",
    scopes: [],
    clientIdEnv: "BUFFER_OAUTH_CLIENT_ID",
    clientSecretEnv: "BUFFER_OAUTH_CLIENT_SECRET",
  },
  "meta-ads": {
    authorizeUrl: "https://www.facebook.com/v21.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
    scopes: ["ads_read", "ads_management"],
    clientIdEnv: "META_OAUTH_CLIENT_ID",
    clientSecretEnv: "META_OAUTH_CLIENT_SECRET",
  },
  canva: {
    authorizeUrl: "https://www.canva.com/api/oauth/authorize",
    tokenUrl: "https://api.canva.com/rest/v1/oauth/token",
    scopes: ["design:content:read", "asset:read"],
    clientIdEnv: "CANVA_OAUTH_CLIENT_ID",
    clientSecretEnv: "CANVA_OAUTH_CLIENT_SECRET",
  },
};

export interface OAuthState {
  userId: string;
  workspaceId: string;
  connectorKey: string;
  exp: number;
  nonce: string;
}

const STATE_TTL_MS = 10 * 60 * 1000;

function b64urlEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function b64urlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

const B64_STD_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Strict structural validation of a lib/secrets envelope ("v1:iv:ct:tag")
 * BEFORE decrypting.
 *
 * Why: Node's base64 decoder is lenient — bytes outside the base64 alphabet
 * are silently dropped. A corruption that lands in the tag's trailing
 * padding (e.g. "…==" → "…<0xa6><0x9a>") would otherwise decode to the
 * original 16-byte tag and GCM would still verify, so the tamper would go
 * undetected. This cannot forge a different payload (the ciphertext is
 * authenticated), but we want tamper rejection to be total. This check is
 * vault-local so the shared M6 crypto stays untouched.
 */
function assertValidEnvelope(envelope: string): void {
  const fail = (): never => {
    throw new Error("Invalid OAuth state: malformed envelope");
  };
  const parts = envelope.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") fail();
  const [, ivB64, ctB64, tagB64] = parts;
  for (const p of [ivB64, ctB64, tagB64]) {
    if (!p || p.length % 4 !== 0 || !B64_STD_RE.test(p)) fail();
  }
  if (Buffer.from(ivB64, "base64").length !== 12) fail();
  if (Buffer.from(tagB64, "base64").length !== 16) fail();
  if (Buffer.from(ctB64, "base64").length === 0) fail();
}

/** Sign a stateless OAuth state envelope (AES-256-GCM via lib/secrets). */
export function signOAuthState(state: OAuthState): string {
  const envelope = secrets().encrypt(JSON.stringify(state));
  return b64urlEncode(envelope);
}

/** Verify a state envelope. Throws on tamper or expiry. */
export function parseOAuthState(state: string): OAuthState {
  let raw: string;
  try {
    raw = b64urlDecode(state);
  } catch {
    throw new Error("Invalid OAuth state: not base64url");
  }
  assertValidEnvelope(raw);
  let parsed: OAuthState;
  try {
    parsed = JSON.parse(secrets().decrypt(raw)) as OAuthState;
  } catch {
    throw new Error("Invalid OAuth state: signature mismatch or malformed");
  }
  if (
    typeof parsed.userId !== "string" ||
    typeof parsed.workspaceId !== "string" ||
    typeof parsed.connectorKey !== "string" ||
    typeof parsed.exp !== "number"
  ) {
    throw new Error("Invalid OAuth state: missing fields");
  }
  if (Date.now() > parsed.exp) {
    throw new Error("OAuth state expired");
  }
  return parsed;
}

/**
 * Build the authorize URL + signed state for a built-in OAuth connector.
 * Throws when the connector has no OAuth config or client env vars are missing.
 */
export function startOAuthFlow(
  userId: string,
  workspaceId: string,
  connectorKey: string,
  redirectBase: string,
): { url: string; state: string } {
  const config = OAUTH_CONFIGS[connectorKey];
  if (!config) {
    throw new Error(`Connector "${connectorKey}" does not support OAuth2`);
  }
  // Validate the key is a real built-in connector (fail closed on typos).
  getBuiltinMeta(connectorKey);

  const clientId = (process.env[config.clientIdEnv] ?? "").trim();
  if (!clientId) {
    throw new Error(
      `OAuth is not configured for "${connectorKey}": ${config.clientIdEnv} is not set`,
    );
  }

  const state = signOAuthState({
    userId,
    workspaceId,
    connectorKey,
    exp: Date.now() + STATE_TTL_MS,
    nonce: randomBytes(16).toString("hex"),
  });

  const redirectUri = `${redirectBase.replace(/\/+$/, "")}/api/oauth/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    ...(config.scopes.length ? { scope: config.scopes.join(" ") } : {}),
    ...(config.extra ?? {}),
  });
  return { url: `${config.authorizeUrl}?${params.toString()}`, state };
}

/** Look up the OAuth config for a connector key (undefined for non-OAuth connectors). */
export function getOAuthConfig(connectorKey: string): OAuthProviderConfig | undefined {
  return OAUTH_CONFIGS[connectorKey];
}
