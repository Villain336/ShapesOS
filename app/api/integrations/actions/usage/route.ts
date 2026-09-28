// Marketr — Phase 14 slice 10: Composio usage API.
// GET /api/integrations/actions/usage — per-workspace Composio tool-call
// usage for the current calendar month + the platform free-tier budget state.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { checkComposioBudget, getComposioUsage } from "@/lib/integrations/actions/budget";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const [usage, budget] = await Promise.all([
      getComposioUsage(workspace.id),
      checkComposioBudget(),
    ]);
    return Response.json({ usage, budget });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
