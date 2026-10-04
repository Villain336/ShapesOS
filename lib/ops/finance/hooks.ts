// ShapesOS — Phase 10 (finance): server-side behaviour for the finance
// entities on the generic Ops route (lib/ops/doctype.ts calls these).
//
//   prepare          normalize a create body / validated patch (line tax,
//                    account checks) before it is written
//   create           materialize a create (replaces the generic insert)
//   beforeTransition extra columns written WITH a status move (numbers)
//   afterTransition  side effects in the same transaction after the move
//                    lands (posting, payments, receipts) — throwing here rolls
//                    the move back
//
// Every hook runs inside the caller's withWorkspaceScope transaction.

import type { Prisma } from "@prisma/client";
import { OpsError, type OpsActor } from "../doctype";
import { postEntry, type DraftLine } from "../accounting";

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;

export interface TransitionArgs {
  id: string;
  from: string;
  to: string;
  existing: Row;
  patch: Row;
}

export interface OpsEntityHooks {
  prepare?(tx: Tx, actor: OpsActor, body: Row, existing: Row | null): Promise<Row>;
  create?(tx: Tx, actor: OpsActor, body: Row): Promise<Row[]>;
  beforeTransition?(tx: Tx, actor: OpsActor, args: TransitionArgs): Promise<Row | void>;
  afterTransition?(tx: Tx, actor: OpsActor, args: TransitionArgs & { row: Row }): Promise<Row | void>;
}

export function parseIsoDate(v: unknown, field: string): Date {
  const d = new Date(String(v ?? ""));
  if (Number.isNaN(d.getTime())) throw new OpsError(400, `Invalid ${field}: must be an ISO-8601 date`);
  return d;
}

/** 400 unless every id is an account in this workspace's chart. */
export async function assertAccountsInWorkspace(tx: Tx, workspaceId: string, ids: Array<string | null | undefined>): Promise<void> {
  const want = [...new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0))];
  if (want.length === 0) return;
  const found = await tx.opsAccount.count({ where: { workspaceId, id: { in: want } } });
  if (found !== want.length) throw new OpsError(400, "Unknown account: pick an account from this workspace's chart");
}

// ---------------------------------------------------------------------------
// Accounting entities
// ---------------------------------------------------------------------------

const accountHooks: OpsEntityHooks = {
  async prepare(tx, actor, body, existing) {
    const parentId = body.parentId as string | null | undefined;
    if (parentId) {
      if (existing && parentId === existing.id) throw new OpsError(400, "An account can't be its own parent");
      await assertAccountsInWorkspace(tx, actor.workspaceId, [parentId]);
    }
    if (existing && body.active === false && existing.systemKey) {
      throw new OpsError(422, `"${String(existing.name)}" is used by automatic posting (${String(existing.systemKey)}) and can't be deactivated`);
    }
    return body;
  },
};

const taxRateHooks: OpsEntityHooks = {
  async prepare(tx, actor, body) {
    await assertAccountsInWorkspace(tx, actor.workspaceId, [
      body.salesAccountId as string | undefined,
      body.purchaseAccountId as string | undefined,
    ]);
    return body;
  },
};

const journalEntryHooks: OpsEntityHooks = {
  async create(tx, actor, body) {
    const lines = (body.lines as Array<{ accountId: string; debitCents: number; creditCents: number; memo?: string }>).map(
      (l): DraftLine => ({ account: { id: l.accountId }, debitCents: l.debitCents, creditCents: l.creditCents, memo: l.memo }),
    );
    const { entry } = await postEntry(tx, actor, {
      entryDate: body.entryDate ? parseIsoDate(body.entryDate, "entryDate") : undefined,
      memo: (body.memo as string | undefined) ?? null,
      sourceType: "manual",
      lines,
    });
    return [entry as unknown as Row];
  },
};

export const FINANCE_ENTITY_HOOKS: Record<string, OpsEntityHooks> = {
  accounts: accountHooks,
  "tax-rates": taxRateHooks,
  "journal-entries": journalEntryHooks,
};
