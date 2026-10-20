// ShapesOS — Phase 18.1 (WS=desk): owner-only RLS scope.
//
// user_desktop_layouts, user_recent_items and desktop_briefings are FORCE RLS
// on the tenant GUC (app.workspace_id) AND the person GUC (app.user_id) — see
// migration 20261020100000_p18_desk_desktop. Every read and write of those
// tables runs inside withUserScope(): a caller that forgets it sees zero rows,
// and a write for another member is rejected WITH CHECK. The person is always
// the session subject (or, for the briefing worker, the row's own member).

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { WORKSPACE_GUC } from "@/lib/substrate/memory/rls";

export const USER_GUC = "app.user_id";

export type DeskTx = Prisma.TransactionClient;

/** Run fn in a transaction with app.workspace_id AND app.user_id set (SET LOCAL). */
export async function withUserScope<T>(
  workspaceId: string,
  userId: string,
  fn: (tx: DeskTx) => Promise<T>,
): Promise<T> {
  if (!workspaceId) throw new Error("withUserScope: workspaceId is required");
  if (!userId) throw new Error("withUserScope: userId is required");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config(${WORKSPACE_GUC}, ${workspaceId}, true)`;
    await tx.$queryRaw`SELECT set_config(${USER_GUC}, ${userId}, true)`;
    return fn(tx);
  });
}
