// ShapesOS — Phase 13 (twinui): removing a twin layout object (the layout
// editor's "Delete"), wired as twinObjectDef.hooks.remove so the generic
// DELETE /api/ops/twin-objects?id=… route can serve it. A layout object holds
// no business data — its state is derived from the bound record, which is
// untouched — so removal is a plain delete inside the caller's
// workspace-scoped transaction (opsRemove found and audits the row).

import type { Prisma } from "@prisma/client";

export async function removeObjectRow(
  tx: Prisma.TransactionClient,
  actor: { workspaceId: string; userId: string },
  id: string,
  existing: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { count } = await tx.opsSiteObject.deleteMany({ where: { id, workspaceId: actor.workspaceId } });
  if (count === 0) return existing;
  // The site's updatedAt moves so the sites list shows the layout changed.
  if (typeof existing.siteId === "string") {
    await tx.opsSite.updateMany({ where: { id: existing.siteId, workspaceId: actor.workspaceId }, data: { updatedAt: new Date() } });
  }
  return existing;
}
