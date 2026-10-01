// Marketr — Phase 18 slice 2: Amazon Ads OAuth callback.
//
// Completes the round-trip started by startAdsOAuth():
//   1. validate the signed state envelope (rejects tamper/expiry/wrong
//      connector BEFORE any network call),
//   2. exchange the authorization code for tokens at
//      https://api.amazon.com/auth/o2/token (never logged),
//   3. persist via the shared vault primitives (lib/vault/callback.ts —
//      ConnectorConnection + AES-256-GCM ConnectorCredential),
//   4. list advertising profiles (GET /v2/profiles) and link one AdAccount
//      per profile with the opaque tokenRef "vault:oauth:amazon:<id>".
//
// The vault-write layer is an injected port so tests run the whole
// round-trip against stub stores + a mocked token endpoint. No live Amazon
// developer-program credentials exist, so this path is verified against
// mocks only — the live exchange is wired but unproven against Amazon.

import { getOAuthConfig } from "@/lib/vault/oauth";
import {
  exchangeCodeForTokens,
  storeOAuthTokens,
  type OAuthTokenResponse,
} from "@/lib/vault/callback";
import { linkAdAccount, parseAdsOAuthState, vaultTokenRef, AdsOAuthError } from "../oauth";
import { AmazonAdsClient, AmazonAdsError, regionBaseUrl } from "./client";

/** Vault-write port. Default implementation hits Prisma (production). */
export interface AmazonCallbackStore {
  storeTokens(input: {
    userId: string;
    workspaceId: string;
    connectorKey: string;
    token: OAuthTokenResponse;
    scopes: string[];
  }): Promise<{ id: string }>;
  linkAccount(input: {
    workspaceId: string;
    platformKey: "amazon";
    name?: string;
    externalAccountId: string;
    tokenRef: string;
  }): Promise<{ id: string }>;
}

const defaultStore: AmazonCallbackStore = {
  storeTokens: (input) => storeOAuthTokens(input),
  linkAccount: (input) => linkAdAccount(input),
};

export interface AmazonCallbackInput {
  state: string;
  code: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  store?: AmazonCallbackStore;
}

export interface AmazonCallbackResult {
  connectionId: string;
  tokenRef: string;
  accountIds: string[];
  profileCount: number;
}

/**
 * Exchange an Amazon authorization code for tokens. Throws when the
 * amazon-ads connector is not registered or the env credentials are missing.
 */
export async function exchangeAmazonCode(
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokenResponse> {
  const config = getOAuthConfig("amazon-ads");
  if (!config) {
    throw new AmazonAdsError("NOT_CONFIGURED", 'OAuth connector "amazon-ads" is not registered');
  }
  return exchangeCodeForTokens(config, "amazon-ads", code, redirectUri, fetchImpl);
}

/**
 * Full OAuth callback: validate state → exchange code → vault-store →
 * profile-link. Rejects bad state before any network or DB work.
 */
export async function handleAmazonOAuthCallback(
  input: AmazonCallbackInput,
): Promise<AmazonCallbackResult> {
  const parsed = parseAdsOAuthState(input.state, "amazon-ads");
  if (parsed.adsPlatform !== "amazon") {
    throw new AdsOAuthError(
      "INVALID_STATE",
      `OAuth callback rejected: state is for ads platform "${parsed.adsPlatform}"`,
    );
  }
  if (!input.code) {
    throw new AdsOAuthError("MISSING_CODE", "OAuth callback rejected: no authorization code");
  }

  const store = input.store ?? defaultStore;
  const token = await exchangeAmazonCode(input.code, input.redirectUri, input.fetchImpl ?? fetch);
  const config = getOAuthConfig("amazon-ads");
  const connection = await store.storeTokens({
    userId: parsed.userId,
    workspaceId: parsed.workspaceId,
    connectorKey: "amazon-ads",
    token,
    scopes: config?.scopes ?? [],
  });

  const clientId = (process.env.AMAZON_ADS_CLIENT_ID ?? "").trim();
  if (!clientId) {
    throw new AmazonAdsError("NOT_CONFIGURED", "AMAZON_ADS_CLIENT_ID is not set");
  }
  const client = new AmazonAdsClient({
    auth: {
      accessToken: token.access_token,
      clientId,
      baseUrl: regionBaseUrl(process.env.AMAZON_ADS_REGION),
    },
    fetchImpl: input.fetchImpl ?? fetch,
  });
  const profiles = await client.listProfiles();

  const tokenRef = vaultTokenRef("amazon", connection.id);
  const accountIds: string[] = [];
  for (const profile of profiles) {
    const linked = await store.linkAccount({
      workspaceId: parsed.workspaceId,
      platformKey: "amazon",
      name:
        profile.accountInfo?.name ??
        `Amazon Ads ${profile.countryCode} · ${profile.profileId}`,
      externalAccountId: String(profile.profileId),
      tokenRef,
    });
    accountIds.push(linked.id);
  }
  return { connectionId: connection.id, tokenRef, accountIds, profileCount: profiles.length };
}
