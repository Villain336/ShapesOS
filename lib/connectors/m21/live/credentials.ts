// ShapesOS — Phase 4b: vault credential + refresher for live adapter calls.
//
// loadLiveCredential() decrypts a connection's credential (lib/vault) and
// returns a refresher the adapters call on 401. A token that is already
// past (or within 60s of) its stored expiry is refreshed up front, so the
// first provider call does not burn a round-trip on a known-dead token.
// Refreshes persist through refreshConnection() (encrypted blob + expiry +
// lastRefreshAt); a failed refresh flips the connection to needs_reauth.
// Nothing here logs or returns token material beyond the decrypted
// credential handed to the adapter.

import { prisma } from "@/lib/prisma";
import { getDecryptedCredential, refreshConnection, type RefreshDeps } from "@/lib/vault/refresh";
import type { DecryptedCredential } from "../types";

const EXPIRY_SKEW_MS = 60_000;

export interface LiveCredential {
  credential: DecryptedCredential | null;
  /** One-shot refresher for InvokeContext.refreshCredential. */
  refreshCredential: () => Promise<DecryptedCredential | null>;
}

export async function loadLiveCredential(
  connectionId: string,
  deps: RefreshDeps & { now?: () => number } = {},
): Promise<LiveCredential> {
  let refreshedOnce = false;
  const refreshCredential = async (): Promise<DecryptedCredential | null> => {
    if (refreshedOnce) return null;
    refreshedOnce = true;
    const outcome = await refreshConnection(connectionId, { fetchImpl: deps.fetchImpl });
    return outcome === "refreshed" ? getDecryptedCredential(connectionId) : null;
  };

  let credential = await getDecryptedCredential(connectionId);
  if (credential?.kind === "oauth2" && typeof credential.payload.refresh_token === "string") {
    const row = await prisma.connectorCredential.findUnique({
      where: { connectionId },
      select: { expiresAt: true },
    });
    const now = deps.now?.() ?? Date.now();
    if (row?.expiresAt && row.expiresAt.getTime() - now < EXPIRY_SKEW_MS) {
      const fresh = await refreshCredential();
      // A failed proactive refresh leaves the connection needs_reauth; hand
      // the adapter nothing so it cannot call with a known-dead token.
      credential = fresh;
    }
  }
  return { credential, refreshCredential };
}
