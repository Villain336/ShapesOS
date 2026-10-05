// ShapesOS — Phase 15.4 (zernio): the Zernio card's data.
// GET /api/zernio?workspaceId= (viewer+) →
//   { mode: "live"|"mock"|"off", platforms, adNetworks, profileId|null,
//     accounts: [{ accountId, platform, category, username, status, health, issues }],
//     rateLimit }
// Reads the workspace's profile if it has one (it is created by the first
// Connect — never on a read) and refreshes the account mirror from Zernio
// (listAccounts + getAllAccountsHealth, ?profileId=<ours>).

import type { NextRequest } from "next/server";
import { activeZernioMode } from "@/lib/zernio/config";
import { ZERNIO_AD_NETWORKS, ZERNIO_CLOSED_BETA_PLATFORMS, ZERNIO_PLATFORM_LABELS, ZERNIO_SOCIAL_PLATFORMS } from "@/lib/zernio/spec";
import { ZernioScopeError, getZernioScope, syncZernioAccounts } from "@/lib/zernio/tenancy";
import { zernioErrorResponse, zernioGuard } from "./_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const g = await zernioGuard(req, "viewer");
  if (g instanceof Response) return g;
  const mode = activeZernioMode();
  const base = {
    mode,
    platforms: ZERNIO_SOCIAL_PLATFORMS.map((p) => ({ key: p, label: ZERNIO_PLATFORM_LABELS[p] ?? p, closedBeta: ZERNIO_CLOSED_BETA_PLATFORMS.has(p) })),
    adNetworks: ZERNIO_AD_NETWORKS.map((n) => ({
      key: n.key,
      label: n.label,
      connect: n.connect.kind,
      needsPostingAccount: n.connect.kind === "oauth" ? (n.connect.needsPostingAccount ?? null) : null,
    })),
  };
  if (mode === "off") return Response.json({ ...base, profileId: null, accounts: [], rateLimit: null });
  try {
    const scope = await getZernioScope(g.workspaceId, { create: false });
    const accounts = await syncZernioAccounts(scope);
    return Response.json({ ...base, profileId: scope.profileId, accounts, rateLimit: scope.client.lastRateLimit });
  } catch (e) {
    if (e instanceof ZernioScopeError) return Response.json({ ...base, profileId: null, accounts: [], rateLimit: null });
    return zernioErrorResponse(e);
  }
}
