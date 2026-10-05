// ShapesOS — Phase 11 (bizsync): the QuickBooks / Xero provider client for a
// vault credential (no DB, no Prisma — safe in the adapter import graph).

import { tokenSourceFrom, type LiveDeps } from "@/lib/connectors/m21/live/http";
import type { DecryptedCredential, InvokeContext } from "@/lib/connectors/m21/types";
import type { AccountingProvider, AccountingProviderKey } from "./types";
import { quickbooksProvider } from "../quickbooks/provider";
import { xeroProvider } from "../xero/provider";

/** The provider client for a QuickBooks / Xero credential, or null when it can't address a company yet. */
export function accountingProviderFrom(
  key: AccountingProviderKey,
  workspaceId: string,
  credential: DecryptedCredential | null,
  ctx: Pick<InvokeContext, "refreshCredential">,
  deps: LiveDeps = {},
): AccountingProvider | null {
  const token = tokenSourceFrom(credential, ctx);
  if (!token) return null;
  if (key === "quickbooks") {
    const realmId = credential?.payload?.realmId;
    return typeof realmId === "string" && realmId ? quickbooksProvider(workspaceId, { realmId, token }, deps) : null;
  }
  const tenantId = credential?.payload?.tenantId;
  return typeof tenantId === "string" && tenantId ? xeroProvider({ tenantId, token }, deps) : null;
}
