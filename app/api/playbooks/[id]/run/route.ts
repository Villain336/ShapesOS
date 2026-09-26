// Marketr — /api/playbooks/:id/run (Phase 9 M5).
// POST (editor): { input } → resolves the production label, records the
// resolved version in the run log (command_audit), and returns the version's
// steps as a DRAFTED plan. v1 is propose-only: no side effects.
// M3's command bar calls this — the contract is:
//   { input } → { playbookId, playbookName, version, contentHash, resolvedAt,
//                 plan: [{order,title,detail,executor,mode:"proposed"}],
//                 runLogId, note }

import { playbooksGuard, readJson, storeError } from "../../_lib";
import { runPlaybook } from "@/lib/playbooks/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await playbooksGuard("editor");
  if (gate instanceof Response) return gate;
  const { id } = await ctx.params;
  const body = await readJson(req);
  try {
    const result = await runPlaybook(
      gate.workspaceId,
      gate.userId,
      id,
      (body.input ?? {}) as Record<string, unknown>,
    );
    return Response.json(result);
  } catch (err) {
    return storeError(err);
  }
}
