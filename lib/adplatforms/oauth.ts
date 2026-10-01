// Marketr — Phase 18 slice 1: connect_account OAuth scaffolding.
//
// Builds the platform consent URL using the shared vault OAuth machinery
// (lib/vault/oauth.ts — signed AES-256-GCM state envelopes, no DB write
// until the callback exchanges the code). Tokens are NEVER in code, logs,
// or chat: the callback stores the vault-encrypted credential and only an
// opaque tokenRef ("vault:oauth:<platform>:<connectionId>") lands on
// AdAccount.tokenRef.
//
// Slice 1 covers: amazon-ads (fully registered). walmart-connect fails
// closed until slice 4 pins the partner-program authorize URL. stackadapt
// is API-key based (its key is stored via lib/vault/apikey.ts, same
// tokenRef scheme). spotify is guided-only — there is no OAuth to start.

import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { secrets } from "@/lib/secrets";
import { OAUTH_CONFIGS } from "@/lib/vault/oauth";
import { ADS_PLATFORMS, isAdsPlatformKey, type AdsPlatformKey } from "./types";

export class AdsOAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AdsOAuthError";
    this.code = code;
  }
}

const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Build the consent URL for an OAuth ad platform. Fails closed when the
 * platform is guided-only, key-based, or not yet registered.
 */
export function startAdsOAuth(
  platformKey: string,
  userId: string,
  workspaceId: string,
  redirectBase: string,
): { url: string; state: string } {
  if (!isAdsPlatformKey(platformKey)) {
    throw new AdsOAuthError("UNKNOWN_PLATFORM", `Unknown ad platform: ${platformKey}`);
  }
  const def = ADS_PLATFORMS[platformKey as AdsPlatformKey];
  if (def.guidedOnly) {
    throw new AdsOAuthError(
      "GUIDED_ONLY",
      `${def.displayName} has no campaign API — connect via the guided setup flow instead`,
    );
  }
  if (def.authKind !== "oauth" || !def.oauthConnectorKey) {
    throw new AdsOAuthError(
      "NOT_OAUTH",
      `${def.displayName} connects with an API key, not OAuth — store it via the vault API-key flow`,
    );
  }
  const config = OAUTH_CONFIGS[def.oauthConnectorKey];
  if (!config) {
    throw new AdsOAuthError(
      "NOT_CONFIGURED",
      `${def.displayName} OAuth is not registered yet (connector lands in its platform slice)`,
    );
  }
  const clientId = (process.env[config.clientIdEnv] ?? "").trim();
  if (!clientId) {
    throw new AdsOAuthError(
      "OAUTH_NOT_CONFIGURED",
      `${def.displayName} OAuth is not configured: ${config.clientIdEnv} is not set`,
    );
  }

  const state = secrets()
    .encrypt(
      JSON.stringify({
        userId,
        workspaceId,
        connectorKey: def.oauthConnectorKey,
        adsPlatform: platformKey,
        exp: Date.now() + STATE_TTL_MS,
        nonce: randomBytes(16).toString("hex"),
      }),
    )
    .toString();
  const redirectUri = `${redirectBase.replace(/\/+$/, "")}/api/ads/oauth/callback`;
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

/** Opaque vault reference stored on AdAccount.tokenRef. Never the credential. */
export function vaultTokenRef(platformKey: AdsPlatformKey, connectionId: string): string {
  return `vault:oauth:${platformKey}:${connectionId}`;
}

/**
 * Ensure the four Phase 1 platform rows exist for a workspace (idempotent).
 * Called by the Advertising hub before rendering.
 */
export async function ensureAdPlatforms(workspaceId: string) {
  for (const def of Object.values(ADS_PLATFORMS)) {
    await prisma.adPlatform.upsert({
      where: { workspaceId_key: { workspaceId, key: def.key } },
      update: {
        displayName: def.displayName,
        authKind: def.authKind,
        supportsApiLaunch: def.supportsApiLaunch,
        supportsReportingApi: def.supportsReportingApi,
        guidedOnly: def.guidedOnly,
      },
      create: {
        workspaceId,
        key: def.key,
        displayName: def.displayName,
        authKind: def.authKind,
        supportsApiLaunch: def.supportsApiLaunch,
        supportsReportingApi: def.supportsReportingApi,
        guidedOnly: def.guidedOnly,
      },
    });
  }
}

/**
 * Link (or re-link) an ad account row after the vault callback stores the
 * credential. tokenRef is the opaque vault reference — never the secret.
 */
export async function linkAdAccount(input: {
  workspaceId: string;
  platformKey: AdsPlatformKey;
  name?: string;
  externalAccountId: string;
  tokenRef: string;
}) {
  const platform = await prisma.adPlatform.findFirst({
    where: { workspaceId: input.workspaceId, key: input.platformKey },
  });
  if (!platform) throw new AdsOAuthError("PLATFORM_MISSING", "Run ensureAdPlatforms first");
  return prisma.adAccount.upsert({
    where: {
      workspaceId_platformId_externalAccountId: {
        workspaceId: input.workspaceId,
        platformId: platform.id,
        externalAccountId: input.externalAccountId,
      },
    },
    update: { tokenRef: input.tokenRef, status: "connected", name: input.name },
    create: {
      workspaceId: input.workspaceId,
      platformId: platform.id,
      name: input.name,
      externalAccountId: input.externalAccountId,
      tokenRef: input.tokenRef,
      status: "connected",
    },
  });
}
