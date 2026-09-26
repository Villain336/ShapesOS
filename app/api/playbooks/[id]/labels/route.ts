// Marketr — /api/playbooks/:id/labels (Phase 9 M5).
// POST (editor): { label, version } → moves the pointer only. Rollback is
// this call with label=production and the previous version number.

import { playbooksGuard, badRequest, readJson, storeError } from "../../_lib";
import { setLabel, type PlaybookLabel } from "@/lib/playbooks/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await playbooksGuard("editor");
  if (gate instanceof Response) return gate;
  const { id } = await ctx.params;
  const body = await readJson(req);
  const label = body.label as PlaybookLabel | undefined;
  const version = body.version as number | undefined;
  if (!label || typeof version !== "number") {
    return badRequest("label and version are required.");
  }
  try {
    const result = await setLabel(gate.workspaceId, id, label, version);
    return Response.json(result);
  } catch (err) {
    return storeError(err);
  }
}
