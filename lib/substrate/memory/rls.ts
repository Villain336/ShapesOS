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
  // Phase 13 (twincore): long seeding work (the twin sample site) may ask
  // for more than Prisma's default 5 s interactive-transaction timeout.
  opts?: { timeoutMs?: number },
): Promise<T> {
  if (!workspaceId) throw new Error("withWorkspaceScope: workspaceId is required");
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ${WORKSPACE_GUC} = '${escapeLiteral(workspaceId)}'`);
      return fn(tx);
    },
    opts?.timeoutMs ? { timeout: opts.timeoutMs } : undefined,
  );
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

/**
 * A PrismaClient-shaped handle whose every model call runs in its own short
 * withWorkspaceScope transaction. For code written against a plain client
 * (e.g. lib/reports/report-gate.ts) that touches FORCE-RLS tables but also
 * does slow non-DB work between queries (PDF rendering): wrapping the whole
 * flow in one interactive transaction would hold a connection and risk the
 * transaction timeout. Under the least-privilege app role an unscoped query on
 * a FORCE-RLS table sees zero rows, so such code must use this (or a tx).
 * Only model delegates are scoped; $transaction/$queryRaw are not exposed.
 */
export function scopedDb(workspaceId: string): PrismaClient {
  if (!workspaceId) throw new Error("scopedDb: workspaceId is required");
  return new Proxy({} as PrismaClient, {
    get(_target, model) {
      if (typeof model !== "string" || model.startsWith("$")) {
        throw new Error(`scopedDb: only model delegates are available (got ${String(model)})`);
      }
      return new Proxy(
        {},
        {
          get(_t, method) {
            return (...args: unknown[]) =>
              withWorkspaceScope(workspaceId, (tx) => {
                const delegate = (tx as unknown as Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>)[model];
                return delegate[method as string](...args);
              });
          },
        },
      );
    },
  });
}
