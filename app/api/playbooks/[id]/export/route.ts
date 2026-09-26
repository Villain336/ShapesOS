// Marketr — /api/playbooks/:id/export (Phase 9 M5).
// POST (editor): anonymized community export of the production version
// (latest version fallback). Gated on the workspace opt-in (default OFF);
// quarantines when the anonymizer cannot confidently strip tenant signal.

import { playbooksGuard, storeError } from "../../_lib";
import { exportPlaybook } from "@/lib/playbooks/store";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await playbooksGuard("editor");
  if (gate instanceof Response) return gate;
  const { id } = await ctx.params;
  try {
    const exported = await exportPlaybook(gate.workspaceId, id);
    return Response.json({ export: exported });
  } catch (err) {
    return storeError(err);
  }
}
