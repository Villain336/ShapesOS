// ShapesOS — Phase 13: twin state service (CONTRACT STUB).
//
// Signatures are fixed by the contract; the data workstream ("twincore")
// replaces the bodies. The scene/pages workstream ("twinui") imports these
// exact names. Server-only.

import type { TwinPatchOp, TwinSnapshot } from "./types";

/** Every object of the site with its derived state, plus KPIs, shipments and agent markers. Workspace-scoped (RLS). */
export async function siteSnapshot(workspaceId: string, siteId: string): Promise<TwinSnapshot> {
  void workspaceId;
  void siteId;
  throw new Error("siteSnapshot: not implemented yet (Phase 13 twincore)");
}

/** Sites of the workspace for the list page (no derived state). */
export async function listSites(
  workspaceId: string,
): Promise<{ id: string; kind: TwinSnapshot["site"]["kind"]; status: TwinSnapshot["site"]["status"]; name: string; code: string; objectCount: number; updatedAt: string }[]> {
  void workspaceId;
  throw new Error("listSites: not implemented yet (Phase 13 twincore)");
}

/** RFC 6902 ops turning `prev` into `next` (empty when equal). PURE. */
export function siteDiff(prev: TwinSnapshot, next: TwinSnapshot): TwinPatchOp[] {
  void prev;
  void next;
  throw new Error("siteDiff: not implemented yet (Phase 13 twincore)");
}
