// Marketr — Phase 18 slice 3: connect a StackAdapt API key.
//
// StackAdapt auth is a static GraphQL API key per tenant seat — there is no
// OAuth consent flow. The key is validated against the StackAdapt GraphQL
// API (tokenInfo) BEFORE anything is stored: a bad key fails closed here
// with AUTH_FAILED and never reaches the vault. Valid keys land in the
// Latchkey vault via lib/vault/apikey.ts; only the opaque
// "vault:oauth:stackadapt:<connectionId>" tokenRef lands on AdAccount.
// The raw key is never in code, logs, or the DB.

import { StackAdaptClient, StackAdaptError, STACKADAPT_GRAPHQL_URL } from "./client";
import { storeApiKey } from "@/lib/vault/apikey";
import { linkAdAccount, vaultTokenRef } from "../oauth";

export interface ConnectStackAdaptKeyInput {
  userId: string;
  workspaceId: string;
  label?: string;
  apiKey: string;
}

export interface ConnectStackAdaptKeyDeps {
  fetchImpl?: typeof fetch;
  storeKey?: (input: {
    userId: string;
    workspaceId: string;
    label: string;
    apiKey: string;
    baseUrl: string;
  }) => Promise<{ id: string }>;
  link?: typeof linkAdAccount;
}

export interface ConnectStackAdaptKeyResult {
  connectionId: string;
  accountId: string;
  advertiserId: string;
  advertiserName: string;
}

/**
 * Validate a StackAdapt GraphQL key, store it in the vault, and link the
 * tenant's advertiser as the AdAccount. The advertiser id becomes
 * AdAccount.externalAccountId — the spend container the key's seat reaches.
 */
export async function connectStackAdaptKey(
  input: ConnectStackAdaptKeyInput,
  deps: ConnectStackAdaptKeyDeps = {},
): Promise<ConnectStackAdaptKeyResult> {
  const apiKey = (input.apiKey ?? "").trim();
  if (!apiKey) {
    throw new StackAdaptError("INVALID_KEY", "StackAdapt API key must not be empty");
  }
  const baseUrl = STACKADAPT_GRAPHQL_URL;
  const client = new StackAdaptClient({ auth: { apiKey, baseUrl }, fetchImpl: deps.fetchImpl });

  // Validate before storing anything: 401 here means the key is wrong.
  await client.checkAuth();

  const advertisers = await client.listAdvertisers({ first: 1 });
  const advertiser = advertisers.nodes[0];
  if (!advertiser?.id) {
    throw new StackAdaptError(
      "NO_ADVERTISERS",
      "StackAdapt key is valid but exposes no advertisers — nothing to link",
    );
  }

  const storeKey =
    deps.storeKey ??
    (async (s: { userId: string; workspaceId: string; label: string; apiKey: string; baseUrl: string }) =>
      storeApiKey(s.userId, s.workspaceId, "stackadapt", s.label, s.apiKey, { extra: { baseUrl: s.baseUrl } }));
  const link = deps.link ?? linkAdAccount;

  const connection = await storeKey({
    userId: input.userId,
    workspaceId: input.workspaceId,
    label: input.label?.trim() || "StackAdapt API key",
    apiKey,
    baseUrl,
  });
  const account = await link({
    workspaceId: input.workspaceId,
    platformKey: "stackadapt",
    name: advertiser.name ?? "StackAdapt advertiser",
    externalAccountId: advertiser.id,
    tokenRef: vaultTokenRef("stackadapt", connection.id),
  });
  return {
    connectionId: connection.id,
    accountId: account.id,
    advertiserId: advertiser.id,
    advertiserName: advertiser.name ?? "StackAdapt advertiser",
  };
}
