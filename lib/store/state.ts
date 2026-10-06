// ShapesOS — Phase 18.2 (WS=content): the Store's per-workspace state that
// other pages read (small on purpose: the Missions page and API import it
// without the whole catalogue).

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

/** Mission templates this workspace removed from its picker in the Store. */
export async function removedMissionTemplates(workspaceId: string): Promise<Set<string>> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.workspaceStoreItem.findMany({ where: { workspaceId, kind: "mission_template", state: "removed" }, select: { itemKey: true } }),
  );
  return new Set(rows.map((r) => r.itemKey));
}
