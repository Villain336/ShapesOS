// Marketr — Growth Memory RLS scoping (Phase 8 G3, spec §9.2).
//
// Every memory_* table has FORCE ROW LEVEL SECURITY, fail-closed: sessions
// that do NOT set app.workspace_id see ZERO rows — including the table
// owner. All memory reads/writes MUST go through withWorkspaceScope().
// (Mirrors G1's lib/substrate/graph/rls.ts and the same GUC name so the
// whole substrate shares one tenant principal.)

import { prisma } from "@/lib/prisma";
import type { Prisma, PrismaClient } from "@prisma/client";

export const WORKSPACE_GUC = "app.workspace_id";
export const PLAYBOOK_REVIEWER_GUC = "app.playbook_reviewer";

type TxClient = Prisma.TransactionClient | PrismaClient;

/**
 * Run fn inside a transaction with app.workspace_id set (SET LOCAL).
 * Without this, RLS hides every row — this is the fail-closed guarantee.
 */
export async function withWorkspaceScope<T>(
  workspaceId: string,
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  if (!workspaceId) throw new Error("withWorkspaceScope: workspaceId is required");
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ${WORKSPACE_GUC} = '${escapeLiteral(workspaceId)}'`);
    return fn(tx);
  });
}

/**
 * Run fn with the playbook-reviewer gate set: the human review queue UI can
 * read UNREVIEWED playbook_learnings; every other reader only sees reviewed
 * rows (enforced by the playbook RLS policies). Also sets the tenant GUC so
 * review actions stay attributable to the reviewing workspace.
 */
export async function withPlaybookReviewer<T>(
  workspaceId: string,
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  if (!workspaceId) throw new Error("withPlaybookReviewer: workspaceId is required");
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ${WORKSPACE_GUC} = '${escapeLiteral(workspaceId)}'`);
    await tx.$executeRawUnsafe(`SET LOCAL ${PLAYBOOK_REVIEWER_GUC} = '1'`);
    return fn(tx);
  });
}

function escapeLiteral(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Negative-proof helper for the battery: run a raw count WITHOUT setting
 * the GUC and assert zero rows (proves FORCE RLS fail-closed is on).
 */
export async function countWithoutScope(table: string): Promise<number> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "${table}"`,
  )) as Array<{ n: number }>;
  return rows[0]?.n ?? -1;
}
