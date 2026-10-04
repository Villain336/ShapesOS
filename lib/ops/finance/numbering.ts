// ShapesOS — Phase 10 (finance): gap-free document numbers.
//
// One row per (workspace, kind) in ops_number_sequences. nextDocumentNumber()
// increments it with a single row-locking upsert INSIDE the transaction that
// issues the document:
//   - concurrent issuers serialize on the row lock (no duplicates), and
//   - a rolled-back issue rolls the increment back too (no gaps).
// Numbers are only assigned when a document is issued (invoice sent, credit
// note issued, quote sent, bill posted, claim submitted) — drafts have none.

import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

export type DocumentKind = "invoice" | "credit_note" | "quote" | "bill" | "expense";

export const DEFAULT_PREFIX: Readonly<Record<DocumentKind, string>> = {
  invoice: "INV-",
  credit_note: "CN-",
  quote: "QUO-",
  bill: "BILL-",
  expense: "EXP-",
};

/** INV- + 7 with padding 4 → "INV-0007". Longer numbers are never truncated. */
export function formatDocumentNumber(prefix: string, n: number, padding = 4): string {
  if (!Number.isInteger(n) || n < 1) throw new Error("document numbers start at 1");
  return `${prefix}${String(n).padStart(Math.max(0, padding), "0")}`;
}

export async function nextDocumentNumber(tx: Tx, workspaceId: string, kind: DocumentKind): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ n: number; prefix: string; padding: number }>>`
    INSERT INTO "ops_number_sequences" ("workspace_id", "kind", "prefix", "next_value", "padding", "updated_at")
    VALUES (${workspaceId}, ${kind}, ${DEFAULT_PREFIX[kind]}, 2, 4, now())
    ON CONFLICT ("workspace_id", "kind")
    DO UPDATE SET "next_value" = "ops_number_sequences"."next_value" + 1, "updated_at" = now()
    RETURNING ("next_value" - 1)::int AS n, "prefix", "padding"`;
  const row = rows[0];
  if (!row) throw new Error("number sequence upsert returned no row");
  return formatDocumentNumber(row.prefix, row.n, row.padding);
}

/**
 * Unit-test stub transactions (written before Phase 10) carry only the
 * delegates their suite needs. Production Prisma transaction clients always
 * have the ledger delegates and $queryRaw; the finance side effects
 * (numbering, posting) only run when they are present.
 */
export function hasFinanceLedger(tx: unknown): boolean {
  const t = tx as { opsJournalEntry?: { createMany?: unknown }; $queryRaw?: unknown } | null;
  return Boolean(t && typeof t.$queryRaw === "function" && typeof t.opsJournalEntry?.createMany === "function");
}
