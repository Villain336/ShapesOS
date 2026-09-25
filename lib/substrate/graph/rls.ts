// Marketr — Phase 8 G1: RLS tenant scoping for the graph substrate.
//
// Every graph table has FORCE ROW LEVEL SECURITY with a tenant policy on the
// `app.workspace_id` GUC (see migration 20260925174000_phase8_graph). A
// session that does NOT set the GUC sees ZERO rows (fail-closed) — so ALL
// substrate reads/writes MUST go through `withWorkspaceScope()`. This is the
// database-level enforcement behind spec §9.2 ("RLS from day one, not just
// WHERE clauses"); the application-level `where: { workspaceId }` filters
// remain as defense in depth.

import { prisma } from "@/lib/prisma";

/** Run `fn` inside a transaction with the tenant GUC pinned via SET LOCAL.
 *  The GUC dies with the transaction — it cannot leak to other requests. */
export async function withWorkspaceScope<T>(
  workspaceId: string,
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // Parameterized — never interpolate the workspace id into SQL.
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    return fn(tx);
  });
}

/** Prisma transaction client type (subset we use). Exported for tests. */
export type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Verify at runtime that the RLS policy is actually constraining this
 * session: with the GUC pinned to workspace A, a probe for workspace B's
 * row must return nothing. Returns true when isolation holds.
 */
export async function verifyTenantIsolation(
  workspaceA: string,
  probeWorkspaceB: string,
): Promise<{ isolated: boolean; detail: string }> {
  try {
    const rows = await withWorkspaceScope(workspaceA, (tx) =>
      tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM graph_nodes WHERE workspace_id = ${probeWorkspaceB} LIMIT 1`,
    );
    if (rows.length === 0) {
      return { isolated: true, detail: "cross-workspace probe returned 0 rows" };
    }
    return {
      isolated: false,
      detail: `RLS LEAK: ${rows.length} row(s) from ${probeWorkspaceB} visible under ${workspaceA}`,
    };
  } catch (e) {
    return { isolated: false, detail: `probe failed: ${(e as Error).message}` };
  }
}
