// Marketr — Phase 8 G2: RLS tenant scoping for the campaign object.
// Mirrors the G1 convention (lib/substrate/graph/rls.ts): the database-level
// tenant principal is the `app.workspace_id` GUC. All three G2 tables run
// with FORCE ROW LEVEL SECURITY; sessions that never set the GUC see ZERO
// rows (fail-closed). Every engine call below runs inside a transaction
// that sets the GUC first, so the policy and the app's own workspace
// filters compose — defense in depth, not either/or.

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

export type CampaignTx = Prisma.TransactionClient;

/** Run `fn` with `app.workspace_id` set for the whole transaction. */
export async function withCampaignScope<T>(
  workspaceId: string,
  fn: (tx: CampaignTx) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // set_config(..., is_local=true) == SET LOCAL: scoped to this txn.
    await tx.$queryRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    return fn(tx);
  });
}

/** Set the GUC on an already-open interactive transaction (for callers that
 * manage their own txn, e.g. a multi-op flow). */
export async function setWorkspaceGuc(tx: CampaignTx, workspaceId: string): Promise<void> {
  await tx.$queryRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
}
