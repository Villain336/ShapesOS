// Marketr — /api/playbooks/:id/versions/:versionId/transition (Phase 9 M5).
// POST (editor): { to } → guarded lifecycle move. The session user is the
// human approver recorded for production promotions.

import { playbooksGuard, badRequest, readJson, storeError } from "../../../../_lib";
import { transitionVersion, type PlaybookVersionStatus } from "@/lib/playbooks/store";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; versionId: string }> },
) {
  const gate = await playbooksGuard("editor");
  if (gate instanceof Response) return gate;
  const { versionId } = await ctx.params;
  const body = await readJson(req);
  const to = body.to as PlaybookVersionStatus | undefined;
  if (!to || typeof to !== "string") return badRequest("to is required.");
  try {
    const result = await transitionVersion(gate.workspaceId, versionId, to, {
      approver: gate.userId,
    });
    return Response.json(result);
  } catch (err) {
    return storeError(err);
  }
}
