// Marketr — Phase 18 slice 3: StackAdapt vault key resolution.
//
// AdAccount.tokenRef is an opaque "vault:oauth:<platform>:<connectionId>"
// pointer (slice 1 scheme — the scheme name predates key-based platforms but
// the pointer shape is shared). This module resolves it to a live API key:
// decrypt the vault credential (stored by lib/vault/apikey.ts storeApiKey)
// and fail closed when the connection needs re-keying. The key is never
// logged — errors carry codes only.

import { prisma } from "@/lib/prisma";
import { getDecryptedCredential } from "@/lib/vault/refresh";

export class StackAdaptKeyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "StackAdaptKeyError";
    this.code = code;
  }
}

/** Parse "vault:oauth:<platform>:<connectionId>". Throws on any other shape. */
export function parseTokenRef(tokenRef: string): { platform: string; connectionId: string } {
  const m = /^vault:oauth:([a-z0-9-]+):(.+)$/.exec((tokenRef ?? "").trim());
  if (!m) {
    throw new StackAdaptKeyError("BAD_TOKEN_REF", "AdAccount tokenRef is not a vault reference");
  }
  return { platform: m[1], connectionId: m[2] };
}

export interface ResolvedStackAdaptAccount {
  id: string;
  workspaceId: string;
  externalAccountId: string;
}

/**
 * Resolve an AdAccount row to its StackAdapt API key. Static keys do not
 * expire, so there is no refresh path — a missing credential means the
 * seat must reconnect its key.
 */
export async function resolveStackAdaptKey(
  accountId: string,
): Promise<{ apiKey: string; account: ResolvedStackAdaptAccount }> {
  const account = await prisma.adAccount.findUnique({
    where: { id: accountId },
    select: { id: true, workspaceId: true, externalAccountId: true, tokenRef: true, status: true },
  });
  if (!account) {
    throw new StackAdaptKeyError("ACCOUNT_NOT_FOUND", `AdAccount ${accountId} not found`);
  }
  if (!account.tokenRef) {
    throw new StackAdaptKeyError("NOT_CONNECTED", "AdAccount has no vault key — connect the StackAdapt API key first");
  }
  const { platform, connectionId } = parseTokenRef(account.tokenRef);
  if (platform !== "stackadapt") {
    throw new StackAdaptKeyError("WRONG_PLATFORM", `tokenRef is for platform "${platform}", not stackadapt`);
  }

  const credential = await getDecryptedCredential(connectionId);
  const payload = credential?.payload;
  const apiKey = payload && typeof payload.apiKey === "string" ? payload.apiKey : null;
  if (!apiKey) {
    throw new StackAdaptKeyError("REKEY_REQUIRED", "Vault credential has no API key — reconnect the StackAdapt key");
  }
  return {
    apiKey,
    account: {
      id: account.id,
      workspaceId: account.workspaceId,
      externalAccountId: account.externalAccountId,
    },
  };
}
