// Marketr — /api/playbooks/sharing-opt-in (Phase 9 M5).
// GET: { enabled } — community sharing is OFF by default (locked decision).
// POST (editor): { enabled } → flips the workspace-level opt-in flag
// (stored in workspace_settings.dataGovernance JSON).

import { playbooksGuard, readJson, storeError } from "../_lib";
import { getSharingOptIn, setSharingOptIn } from "@/lib/playbooks/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await playbooksGuard("viewer");
  if (gate instanceof Response) return gate;
  try {
    return Response.json({ enabled: await getSharingOptIn(gate.workspaceId) });
  } catch (err) {
    return storeError(err);
  }
}

export async function POST(req: Request) {
  const gate = await playbooksGuard("editor");
  if (gate instanceof Response) return gate;
  const body = await readJson(req);
  try {
    const result = await setSharingOptIn(gate.workspaceId, body.enabled === true, gate.userId);
    return Response.json(result);
  } catch (err) {
    return storeError(err);
  }
}
