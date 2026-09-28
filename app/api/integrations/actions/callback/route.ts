// Marketr — Phase 14: Composio OAuth callback.
// GET /api/integrations/actions/callback?state=<signed>&connected_account_id=
//
// Hardened (slice 4): the (workspaceId, appKey, userId) binding comes from
// the SIGNED state token minted by initiateConnect — never from forgeable
// query params. The callback verifies the signature AND that the logged-in
// user matches state.userId before confirming. Unsigned, tampered, expired,
// or user-mismatched callbacks confirm NOTHING.
//
// NOTE: Next's redirect() throws to abort the request — it must NOT be
// called inside a try/catch that would swallow it.

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { confirmConnection } from "@/lib/integrations/actions/connections";
import { verifyOAuthState } from "@/lib/integrations/actions/oauth-state";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "";
  const connectedAccountId = url.searchParams.get("connected_account_id")?.trim() ?? "";

  let bound: { workspaceId: string; appKey: string; userId: string };
  try {
    bound = verifyOAuthState(state);
  } catch {
    // Unsigned / tampered / expired state — confirm nothing.
    redirect("/dashboard/actions?connect=error");
  }
  if (bound.userId !== user.id) {
    // Handshake was minted for a different user — refuse to bind.
    redirect("/dashboard/actions?connect=error");
  }
  if (connectedAccountId) {
    try {
      await confirmConnection({
        workspaceId: bound.workspaceId,
        appKey: bound.appKey,
        connectedAccountId,
      });
    } catch {
      // Confirm failure keeps the user on the actions page with the app
      // still unconnected — no silent half-state.
    }
  }
  redirect("/dashboard/actions");
}
