// Marketr — Phase 14: Composio OAuth callback.
// GET /api/integrations/actions/callback?appKey=&connected_account_id=
// Confirms the connection row, then redirects to Settings → Integrations.

import { redirect } from "next/navigation";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { confirmConnection } from "@/lib/integrations/actions/connections";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const url = new URL(req.url);
  const appKey = url.searchParams.get("appKey")?.trim() ?? "";
  const connectedAccountId = url.searchParams.get("connected_account_id")?.trim() ?? "";
  if (appKey && connectedAccountId) {
    try {
      await confirmConnection({
        workspaceId: workspace.id,
        appKey,
        connectedAccountId,
      });
    } catch {
      // Confirm failure keeps the user on the integrations page with the
      // app still unconnected — no silent half-state.
    }
  }
  redirect("/dashboard/actions");
}
