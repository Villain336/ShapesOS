// Marketr — Phase 18 slice 2: Amazon Ads vault token resolution.
//
// AdAccount.tokenRef is an opaque "vault:oauth:<platform>:<connectionId>"
// pointer (slice 1 scheme). This module resolves it to a live AmazonAdsAuth:
// decrypt the vault credential, silently refresh when the access token is
// expired (lib/vault/refresh.ts), and fail closed when the connection needs
// re-auth. Tokens are never logged — errors carry codes and statuses only.

import { prisma } from "@/lib/prisma";
import { getDecryptedCredential, refreshConnection } from "@/lib/vault/refresh";
import { AmazonAdsError, regionBaseUrl, type AmazonAdsAuth } from "./client";

export class AmazonTokenError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AmazonTokenError";
    this.code = code;
  }
}

/** Parse "vault:oauth:<platform>:<connectionId>". Throws on any other shape. */
export function parseTokenRef(tokenRef: string): { platform: string; connectionId: string } {
  const m = /^vault:oauth:([a-z0-9-]+):(.+)$/.exec((tokenRef ?? "").trim());
  if (!m) {
    throw new AmazonTokenError("BAD_TOKEN_REF", "AdAccount tokenRef is not a vault OAuth reference");
  }
  return { platform: m[1], connectionId: m[2] };
}

export interface ResolvedAmazonAccount {
  id: string;
  workspaceId: string;
  externalAccountId: string;
}

/**
 * Resolve an AdAccount row to a ready-to-call AmazonAdsAuth. Refreshes the
 * access token when expired; throws AmazonTokenError("REAUTH_REQUIRED")
 * when the vault connection needs a fresh OAuth consent.
 */
export async function resolveAmazonAuth(accountId: string): Promise<{
  auth: AmazonAdsAuth;
  account: ResolvedAmazonAccount;
}> {
  const account = await prisma.adAccount.findUnique({
    where: { id: accountId },
    select: { id: true, workspaceId: true, externalAccountId: true, tokenRef: true, status: true },
  });
  if (!account) {
    throw new AmazonTokenError("ACCOUNT_NOT_FOUND", `AdAccount ${accountId} not found`);
  }
  if (!account.tokenRef) {
    throw new AmazonTokenError("NOT_CONNECTED", "AdAccount has no vault token — complete the OAuth flow first");
  }
  const { platform, connectionId } = parseTokenRef(account.tokenRef);
  if (platform !== "amazon") {
    throw new AmazonTokenError("WRONG_PLATFORM", `tokenRef is for platform "${platform}", not amazon`);
  }

  const credentialRow = await prisma.connectorCredential.findUnique({
    where: { connectionId },
    select: { expiresAt: true },
  });
  if (!credentialRow) {
    throw new AmazonTokenError("REAUTH_REQUIRED", "Vault credential missing — reconnect the ad account");
  }
  if (credentialRow.expiresAt && credentialRow.expiresAt.getTime() <= Date.now()) {
    const outcome = await refreshConnection(connectionId);
    if (outcome === "needs_reauth") {
      throw new AmazonTokenError(
        "REAUTH_REQUIRED",
        "Amazon Ads token expired and refresh was rejected — reconnect the ad account",
      );
    }
  }

  const credential = await getDecryptedCredential(connectionId);
  const payload = credential?.payload;
  const accessToken = payload && typeof payload.access_token === "string" ? payload.access_token : null;
  if (!accessToken) {
    throw new AmazonTokenError("REAUTH_REQUIRED", "Vault credential has no access token — reconnect the ad account");
  }
  const clientId =
    (payload && typeof payload.client_id === "string" && payload.client_id) ||
    (process.env.AMAZON_ADS_CLIENT_ID ?? "").trim();
  if (!clientId) {
    throw new AmazonTokenError("NOT_CONFIGURED", "AMAZON_ADS_CLIENT_ID is not set");
  }

  const auth: AmazonAdsAuth = {
    accessToken,
    clientId,
    profileId: account.externalAccountId,
    baseUrl: regionBaseUrl(process.env.AMAZON_ADS_REGION),
  };
  return {
    auth,
    account: { id: account.id, workspaceId: account.workspaceId, externalAccountId: account.externalAccountId },
  };
}
