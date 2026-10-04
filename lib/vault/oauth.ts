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

import { createHash, randomBytes } from "crypto";
import { secrets } from "@/lib/secrets";
import { getBuiltinMeta, HUBSPOT_SCOPES, MICROSOFT_CALENDAR_SCOPES, MICROSOFT_MAIL_SCOPES, SLACK_BOT_SCOPES } from "@/lib/connectors/m21/registry";
// Phase 11 (devtools): work-tool connector scopes.
import { AIRTABLE_SCOPES, JIRA_SCOPES, LINEAR_SCOPES } from "@/lib/connectors/m21/registry";

export interface OAuthProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  /** Default scopes for this connector (registry oauth.scopes take precedence when present). */
  scopes: string[];
  clientIdEnv: string;
  clientSecretEnv: string;
  /** Extra static params merged into the authorize URL (e.g. response_type). */
  extra?: Record<string, string>;
  /**
   * How the token endpoint wants the client credentials. "form" (default):
   * x-www-form-urlencoded body carrying client_id/client_secret (Google,
   * Meta, Webflow…). "json_basic": JSON body + HTTP Basic client auth
   * (Notion, verified against developers.notion.com/reference/create-a-token).
   * Phase 11 (devtools): "json": JSON body carrying client_id/client_secret
   * (Atlassian). "form_basic": x-www-form-urlencoded body + HTTP Basic client
   * auth, no secret in the body (Airtable).
   */
  tokenRequest?: "form" | "json_basic" | "json" | "form_basic";
  /**
   * Phase 11 (devtools): RFC 7636 PKCE (S256). The code verifier rides inside
   * the AES-GCM state envelope (never readable by the browser or provider)
   * and is sent as code_verifier on the code exchange. Airtable requires it.
   */
  pkce?: boolean;
  /** Phase 11 (conncore): scope separator on the authorize URL (Slack: ","). Default " ". */
  scopeSeparator?: string;
  /**
   * Phase 11 (conncore): non-secret display/routing metadata pulled from the
   * token response into ConnectorConnection.meta (e.g. Slack team id). Never
   * returns token material.
   */
  tokenMeta?: (token: Record<string, unknown>) => Record<string, string>;
}

/**
 * Build the token-endpoint request for an authorization_code or
 * refresh_token grant, honouring the provider's client-auth style.
 */
export function buildTokenRequest(
  config: Pick<OAuthProviderConfig, "tokenRequest">,
  params: Record<string, string>,
  clientId: string,
  clientSecret: string,
): RequestInit {
  // Phase 11 (devtools): JSON body with the client credentials (Atlassian).
  if (config.tokenRequest === "json") {
    return {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ ...params, client_id: clientId, client_secret: clientSecret }),
    };
  }
  // Phase 11 (devtools): form body + Basic client auth (Airtable).
  if (config.tokenRequest === "form_basic") {
    const basic = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
    return {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", Authorization: `Basic ${basic}` },
      body: new URLSearchParams(params),
    };
  }
  if (config.tokenRequest === "json_basic") {
    const basic = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
    return {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Basic ${basic}` },
      body: JSON.stringify(params),
    };
  }
  return {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ ...params, client_id: clientId, client_secret: clientSecret }),
  };
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_ID_ENV = "GOOGLE_OAUTH_CLIENT_ID";
const GOOGLE_SECRET_ENV = "GOOGLE_OAUTH_CLIENT_SECRET";

// Phase 11 (conncore): Microsoft identity platform v2.0 (multi-tenant "common").
const MICROSOFT_AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MICROSOFT_ID_ENV = "MICROSOFT_OAUTH_CLIENT_ID";
const MICROSOFT_SECRET_ENV = "MICROSOFT_OAUTH_CLIENT_SECRET";

/** OAuth config per built-in connector that uses OAuth2. Non-OAuth keys are absent. */
export const OAUTH_CONFIGS: Record<string, OAuthProviderConfig> = {
  "google-search-console": {
    authorizeUrl: GOOGLE_AUTH_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    // Phase 11: full "webmasters" (includes read) so sitemaps can be submitted;
    // connections made with the old read-only grant keep reading and are asked
    // to reconnect before a submit (lib/seo/sitemap-submit.ts).
    scopes: ["https://www.googleapis.com/auth/webmasters"],
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
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    clientIdEnv: GOOGLE_ID_ENV,
    clientSecretEnv: GOOGLE_SECRET_ENV,
    extra: { access_type: "offline", prompt: "consent" },
  },
  // Connector Agent slice 2: Gmail contact import (network bootstrapping).
  // Read-only: message metadata (From/To/Cc/Date) only — bodies are never
  // fetched. OAuth goes through the same signed-state vault flow; tokens
  // stay vault-encrypted, only an opaque connection id leaves the vault.
  gmail: {
    authorizeUrl: GOOGLE_AUTH_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    // Phase 11 (conncore): + gmail.send for the gated send / reply tools.
    scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"],
    clientIdEnv: GOOGLE_ID_ENV,
    clientSecretEnv: GOOGLE_SECRET_ENV,
    extra: { access_type: "offline", prompt: "consent" },
  },
  // Connector Agent slice 2: Google Calendar contact import (attendees).
  // Read-only: event attendees + organizer only — no event bodies.
  "google-calendar": {
    authorizeUrl: GOOGLE_AUTH_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    // Phase 11 (conncore): + calendar.events for list/create/update events.
    scopes: ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar.events"],
    clientIdEnv: GOOGLE_ID_ENV,
    clientSecretEnv: GOOGLE_SECRET_ENV,
    extra: { access_type: "offline", prompt: "consent" },
  },
  // Phase 4b: Google Ads (GAQL reporting). adwords is the only Ads scope;
  // the developer token is an app-level header, not an OAuth grant.
  "google-ads": {
    authorizeUrl: GOOGLE_AUTH_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    scopes: ["https://www.googleapis.com/auth/adwords"],
    clientIdEnv: GOOGLE_ID_ENV,
    clientSecretEnv: GOOGLE_SECRET_ENV,
    extra: { access_type: "offline", prompt: "consent" },
  },
  // Phase 4b: Google Business Profile (locations, reviews, local posts).
  "google-business-profile": {
    authorizeUrl: GOOGLE_AUTH_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    scopes: ["https://www.googleapis.com/auth/business.manage"],
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
    // Phase 4b: Notion requires owner=user on authorize and Basic client
    // auth + JSON on the token endpoint (both grants).
    extra: { owner: "user" },
    tokenRequest: "json_basic",
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
  // Phase 4b: same Graph version as the live adapter (v26.0, 2026-07); read-only grant.
  "meta-ads": {
    authorizeUrl: "https://www.facebook.com/v26.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v26.0/oauth/access_token",
    scopes: ["ads_read"],
    clientIdEnv: "META_OAUTH_CLIENT_ID",
    clientSecretEnv: "META_OAUTH_CLIENT_SECRET",
  },
  // Phase 18 slice 1: Amazon Ads (Login with Amazon). Verified 2026-09-30
  // against the Amazon Ads API docs: NA authorize https://www.amazon.com/ap/oa,
  // token https://api.amazon.com/auth/o2/token, scope
  // advertising::campaign_management. Refresh token is stored vault-encrypted;
  // only the opaque vault ref lands on AdAccount.tokenRef.
  "amazon-ads": {
    authorizeUrl: "https://www.amazon.com/ap/oa",
    tokenUrl: "https://api.amazon.com/auth/o2/token",
    scopes: ["advertising::campaign_management"],
    clientIdEnv: "AMAZON_ADS_CLIENT_ID",
    clientSecretEnv: "AMAZON_ADS_CLIENT_SECRET",
  },
  // Phase 11 (conncore): Outlook mail through Microsoft Graph. The "common"
  // tenant accepts work/school and personal accounts; client credentials go
  // in the form body (both grants). Verified against
  // learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow.
  outlook: {
    authorizeUrl: MICROSOFT_AUTH_URL,
    tokenUrl: MICROSOFT_TOKEN_URL,
    scopes: MICROSOFT_MAIL_SCOPES,
    clientIdEnv: MICROSOFT_ID_ENV,
    clientSecretEnv: MICROSOFT_SECRET_ENV,
    extra: { response_mode: "query" },
  },
  "outlook-calendar": {
    authorizeUrl: MICROSOFT_AUTH_URL,
    tokenUrl: MICROSOFT_TOKEN_URL,
    scopes: MICROSOFT_CALENDAR_SCOPES,
    clientIdEnv: MICROSOFT_ID_ENV,
    clientSecretEnv: MICROSOFT_SECRET_ENV,
    extra: { response_mode: "query" },
  },
  // Phase 11 (conncore): the ShapesOS Slack app (OAuth v2, bot token).
  // Scopes are comma-separated on the authorize URL; oauth.v2.access answers
  // HTTP 200 { ok, access_token: "xoxb-…", team: { id, name }, bot_user_id }
  // (ok:false has no access_token → the exchange fails closed). Bot tokens
  // don't expire unless token rotation is turned on for the app.
  // Verified against docs.slack.dev/authentication/installing-with-oauth.
  slack: {
    authorizeUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    scopes: SLACK_BOT_SCOPES,
    clientIdEnv: "SLACK_CLIENT_ID",
    clientSecretEnv: "SLACK_CLIENT_SECRET",
    scopeSeparator: ",",
    tokenMeta: (t) => {
      const team = (t.team ?? {}) as { id?: unknown; name?: unknown };
      const out: Record<string, string> = {};
      if (typeof team.id === "string") out.slackTeamId = team.id;
      if (typeof team.name === "string") out.slackTeamName = team.name.slice(0, 200);
      if (typeof t.bot_user_id === "string") out.slackBotUserId = t.bot_user_id;
      return out;
    },
  },
  // Phase 11 (conncore): HubSpot public app. Authorize on app.hubspot.com,
  // token (both grants, client credentials in the form body) on
  // api.hubapi.com; access tokens live 30 minutes, refresh tokens rotate
  // never (kept). Verified against developers.hubspot.com/docs/apps/legacy-apps/authentication/oauth-quickstart-guide.
  hubspot: {
    authorizeUrl: "https://app.hubspot.com/oauth/authorize",
    tokenUrl: "https://api.hubapi.com/oauth/v1/token",
    scopes: HUBSPOT_SCOPES,
    clientIdEnv: "HUBSPOT_CLIENT_ID",
    clientSecretEnv: "HUBSPOT_CLIENT_SECRET",
  },
  // Phase 11 (devtools): Linear OAuth2 app. Scopes are comma-separated on the
  // authorize URL; the token endpoint takes the client credentials in the
  // form body (both grants). Newer Linear apps get expiring access tokens
  // with rotating refresh tokens (lib/vault/refresh.ts keeps the newest). Verified against linear.app/developers/oauth-2-0-authentication.
  linear: {
    authorizeUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    scopes: LINEAR_SCOPES,
    clientIdEnv: "LINEAR_OAUTH_CLIENT_ID",
    clientSecretEnv: "LINEAR_OAUTH_CLIENT_SECRET",
    scopeSeparator: ",",
    extra: { prompt: "consent" },
  },
  // Phase 11 (devtools): Jira Cloud via Atlassian OAuth 2.0 (3LO).
  // audience=api.atlassian.com + prompt=consent on authorize; the token
  // endpoint takes JSON with the client credentials (both grants) and
  // rotates refresh tokens (lib/vault/refresh.ts keeps the newest). Verified
  // against developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps.
  jira: {
    authorizeUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    scopes: JIRA_SCOPES,
    clientIdEnv: "ATLASSIAN_OAUTH_CLIENT_ID",
    clientSecretEnv: "ATLASSIAN_OAUTH_CLIENT_SECRET",
    extra: { audience: "api.atlassian.com", prompt: "consent" },
    tokenRequest: "json",
  },
  // Phase 11 (devtools): Airtable OAuth — authorization code with PKCE
  // (S256, required). A confidential integration authenticates to the token
  // endpoint with HTTP Basic (client_id:client_secret) and a form body (both
  // grants). Access tokens live 60 minutes; refresh tokens rotate (the vault
  // keeps the newest). Verified against airtable.com/developers/web/api/oauth-reference.
  airtable: {
    authorizeUrl: "https://airtable.com/oauth2/v1/authorize",
    tokenUrl: "https://airtable.com/oauth2/v1/token",
    scopes: AIRTABLE_SCOPES,
    clientIdEnv: "AIRTABLE_OAUTH_CLIENT_ID",
    clientSecretEnv: "AIRTABLE_OAUTH_CLIENT_SECRET",
    tokenRequest: "form_basic",
    pkce: true,
  },
  // NOTE (Phase 18 slice 4, outcome B): Walmart Connect is NOT registered
  // here and never will be as an OAuth connector. Research 2026-10-01
  // (docs/phases/PHASE18-SLICE4-WALMART.md) established there is no public
  // OAuth authorize URL: the Ads API is exclusive to WCPN partners and
  // uses partner-level RSA-signed credentials issued after a business
  // application. Walmart ships guided-only; startAdsOAuth() fails closed
  // with GUIDED_ONLY.
};

export interface OAuthState {
  userId: string;
  workspaceId: string;
  connectorKey: string;
  exp: number;
  nonce: string;
  /** Phase 11 (devtools): PKCE code verifier (only for pkce providers; encrypted with the state). */
  cv?: string;
}

/** Phase 11 (devtools): RFC 7636 S256 code challenge for a verifier. PURE. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
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
 * Strict structural validation of a lib/secrets envelope
 * ("v2:kid:iv:ct:tag", or legacy "v1:iv:ct:tag") BEFORE decrypting.
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
  const v2 = parts.length === 5 && parts[0] === "v2" && /^[0-9a-f]{8}$/.test(parts[1]);
  if (!v2 && (parts.length !== 4 || parts[0] !== "v1")) fail();
  const [ivB64, ctB64, tagB64] = parts.slice(v2 ? 2 : 1);
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
    typeof parsed.exp !== "number" ||
    (parsed.cv !== undefined && typeof parsed.cv !== "string")
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

  // Phase 11 (devtools): PKCE — 32 random bytes → a 43-char base64url verifier.
  const verifier = config.pkce ? randomBytes(32).toString("base64url") : undefined;
  const state = signOAuthState({
    userId,
    workspaceId,
    connectorKey,
    exp: Date.now() + STATE_TTL_MS,
    nonce: randomBytes(16).toString("hex"),
    ...(verifier ? { cv: verifier } : {}),
  });

  const redirectUri = `${redirectBase.replace(/\/+$/, "")}/api/oauth/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    ...(config.scopes.length ? { scope: config.scopes.join(config.scopeSeparator ?? " ") } : {}),
    ...(config.extra ?? {}),
    ...(verifier ? { code_challenge: pkceChallenge(verifier), code_challenge_method: "S256" } : {}),
  });
  return { url: `${config.authorizeUrl}?${params.toString()}`, state };
}

/** Look up the OAuth config for a connector key (undefined for non-OAuth connectors). */
export function getOAuthConfig(connectorKey: string): OAuthProviderConfig | undefined {
  return OAUTH_CONFIGS[connectorKey];
}

// ---------------------------------------------------------------------------
// E2E TEST SEAM (Playwright). Registered ONLY when E2E_MOCK_OAUTH=1.
// The authorize/token URLs point at same-origin fixture routes
// (/api/e2e/mock-oauth/*) so the suite can run the real OAuth round-trip
// without a live provider. NEVER enabled in production.
// ---------------------------------------------------------------------------
if (process.env.E2E_MOCK_OAUTH === "1") {
  const e2eBase = (process.env.E2E_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  OAUTH_CONFIGS["mock-oauth"] = {
    authorizeUrl: `${e2eBase}/api/e2e/mock-oauth/authorize`,
    tokenUrl: `${e2eBase}/api/e2e/mock-oauth/token`,
    scopes: ["e2e:read"],
    clientIdEnv: "E2E_MOCK_OAUTH_CLIENT_ID",
    clientSecretEnv: "E2E_MOCK_OAUTH_CLIENT_SECRET",
  };
}
