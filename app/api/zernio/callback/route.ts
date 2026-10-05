// ShapesOS — Phase 15.4 (zernio): where Zernio's hosted connect flow returns.
// GET /api/zernio/callback?s=<state>&connected=…&profileId=…&accountId=…  (or &error=…)
//   → 302 to Settings → Connectors with the result.
// Not public: the signed-in user must be the one the state was signed for
// (lib/zernio/connect.ts verifyConnectState) AND an admin of the workspace it
// names (requireWorkspaceAccess). The account is recorded only when Zernio
// lists it on that workspace's profile — the redirect's own params are never
// trusted. Audits zernio_account_connected.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { requireWorkspaceAccess } from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";
import { completeConnect, verifyConnectState } from "@/lib/zernio/connect";
import { getZernioScope } from "@/lib/zernio/tenancy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const back = (params: Record<string, string>) => {
    const u = new URL("/dashboard/settings/connectors", origin);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return Response.redirect(u.toString(), 302);
  };
  const user = await requireUser();
  if (!user) return Response.redirect(new URL("/login", origin).toString(), 302);
  let workspaceId: string | null = null;
  try {
    workspaceId = verifyConnectState(req.nextUrl.searchParams.get("s"), { userId: user.id });
  } catch {
    workspaceId = null;
  }
  if (!workspaceId) return back({ zernio_error: "The Zernio connection link expired or was not started by you. Try Connect again." });
  const access = await requireWorkspaceAccess(user.id, workspaceId, "admin");
  if ("error" in access) return back({ zernio_error: "You need to be an admin of this workspace to connect accounts." });
  const query = Object.fromEntries(req.nextUrl.searchParams.entries());
  try {
    const scope = await getZernioScope(workspaceId, { create: false, userId: user.id });
    const out = await completeConnect(scope, query);
    if (out.ok && out.account) {
      await auditEvent({
        projectId: null,
        workspaceId,
        action: "zernio_account_connected",
        summary: `Zernio: connected ${out.account.platform} account ${out.account.accountId}${out.account.username ? ` (${out.account.username})` : ""}`,
        actorUserId: user.id,
      });
    }
    return out.ok ? back({ zernio: out.message }) : back({ zernio_error: out.message });
  } catch (e) {
    return back({ zernio_error: e instanceof Error ? e.message.slice(0, 300) : "The connection could not be recorded." });
  }
}
