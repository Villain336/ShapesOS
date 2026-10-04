// ShapesOS — Phase 10 (finance): the journal — posting and reversing.
//
// postEntry() is the ONLY writer of ops_journal_entries / ops_journal_lines.
//   - Lines are resolved (system keys → the workspace's accounts), compacted
//     and balance-checked in code; the database re-checks at COMMIT (deferred
//     constraint trigger) and rejects any UPDATE/DELETE (append-only).
//   - Idempotent per source: an entry with a sourceKey is inserted with
//     ON CONFLICT DO NOTHING on (workspace_id, source_key). A re-post of the
//     same source (a retried send, a duplicate webhook) is a no-op that
//     returns the original entry; a concurrent duplicate blocks on the unique
//     index until the first commits, then becomes the same no-op.
//   - Runs inside the caller's withWorkspaceScope transaction, so a document
//     transition and its posting commit or roll back together.
// reverseEntry() writes the mirror entry (one reversal per entry, enforced by
// a unique reversal_of_id) — corrections never edit history.

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { OpsError, type OpsActor } from "../doctype";
import { resolveSystemAccounts } from "./chart";
import {
  assertBalanced,
  compactLines,
  reversalLines,
  UnbalancedEntryError,
  type DraftLine,
  type SystemAccountKey,
} from "./rules";

type Tx = Prisma.TransactionClient;

export interface PostEntryInput {
  entryDate?: Date;
  memo?: string | null;
  sourceType: string;
  sourceId?: string | null;
  /** Idempotency key for the source event, e.g. "invoice:<id>:issue". */
  sourceKey?: string | null;
  lines: DraftLine[];
  reversalOfId?: string | null;
  /** Reversals may post against accounts deactivated since the original. */
  allowInactive?: boolean;
}

export interface JournalLineView {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
  memo: string | null;
}

export interface JournalEntryView {
  id: string;
  entryDate: Date;
  memo: string | null;
  sourceType: string;
  sourceId: string | null;
  sourceKey: string | null;
  reversalOfId: string | null;
  reversedById: string | null;
  totalCents: number;
  createdBy: string;
  createdAt: Date;
  lines: JournalLineView[];
}

export interface PostResult {
  entry: JournalEntryView;
  /** False when the source was already posted (idempotent no-op). */
  created: boolean;
}

async function auditJournal(tx: Tx, actor: OpsActor, action: string, entityId: string, summary: string) {
  await tx.opsAuditEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      entity: "journal-entries",
      entityId,
      action,
      actor: actor.userId,
      summary: summary.slice(0, 2000),
    },
  });
}

const ENTRY_INCLUDE = {
  lines: { include: { account: { select: { code: true, name: true } } }, orderBy: { id: "asc" as const } },
  reversedBy: { select: { id: true } },
} satisfies Prisma.OpsJournalEntryInclude;

type EntryWithLines = Prisma.OpsJournalEntryGetPayload<{ include: typeof ENTRY_INCLUDE }>;

function toView(e: EntryWithLines): JournalEntryView {
  return {
    id: e.id,
    entryDate: e.entryDate,
    memo: e.memo,
    sourceType: e.sourceType,
    sourceId: e.sourceId,
    sourceKey: e.sourceKey,
    reversalOfId: e.reversalOfId,
    reversedById: e.reversedBy?.id ?? null,
    totalCents: e.totalCents,
    createdBy: e.createdBy,
    createdAt: e.createdAt,
    lines: e.lines.map((l) => ({
      id: l.id,
      accountId: l.accountId,
      accountCode: l.account.code,
      accountName: l.account.name,
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      memo: l.memo,
    })),
  };
}

export async function getJournalEntry(tx: Tx, workspaceId: string, id: string): Promise<JournalEntryView> {
  const e = await tx.opsJournalEntry.findFirst({ where: { id, workspaceId }, include: ENTRY_INCLUDE });
  if (!e) throw new OpsError(404, `Journal entry "${id}" not found in workspace`);
  return toView(e);
}

export async function findEntryBySource(tx: Tx, workspaceId: string, sourceKey: string): Promise<JournalEntryView | null> {
  const e = await tx.opsJournalEntry.findFirst({ where: { workspaceId, sourceKey }, include: ENTRY_INCLUDE });
  return e ? toView(e) : null;
}

/** Post one balanced entry (idempotent per sourceKey). */
export async function postEntry(tx: Tx, actor: OpsActor, input: PostEntryInput): Promise<PostResult> {
  const lines = compactLines(input.lines);
  let total: number;
  try {
    total = assertBalanced(lines);
  } catch (err) {
    if (err instanceof UnbalancedEntryError) throw new OpsError(400, err.message);
    throw err;
  }
  if (input.sourceKey) {
    const prior = await findEntryBySource(tx, actor.workspaceId, input.sourceKey);
    if (prior) return { entry: prior, created: false };
  }

  // Resolve accounts: system keys via the chart, ids must be this
  // workspace's active accounts.
  const keys = lines.flatMap((l) => ("key" in l.account ? [l.account.key] : [])) as SystemAccountKey[];
  const byKey = await resolveSystemAccounts(tx, actor.workspaceId, keys);
  const ids = [...new Set(lines.flatMap((l) => ("id" in l.account ? [l.account.id] : [])))];
  if (ids.length > 0) {
    const found = await tx.opsAccount.findMany({
      where: { workspaceId: actor.workspaceId, id: { in: ids } },
      select: { id: true, active: true },
    });
    for (const id of ids) {
      const a = found.find((f) => f.id === id);
      if (!a) throw new OpsError(400, `Account "${id}" is not in this workspace's chart`);
      if (!a.active && !input.allowInactive) throw new OpsError(422, `Account "${id}" is inactive — reactivate it or pick another account`);
    }
  }
  const accountIdOf = (l: DraftLine) => ("key" in l.account ? byKey.get(l.account.key)! : l.account.id);

  const entryId = `je_${randomUUID().replace(/-/g, "")}`;
  const entryDate = input.entryDate ?? new Date();
  const created = await tx.opsJournalEntry.createMany({
    data: [
      {
        id: entryId,
        workspaceId: actor.workspaceId,
        entryDate,
        memo: input.memo ?? null,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        sourceKey: input.sourceKey ?? null,
        reversalOfId: input.reversalOfId ?? null,
        totalCents: total,
        createdBy: actor.userId,
      },
    ],
    skipDuplicates: true,
  });
  if (created.count === 0) {
    // Lost the race on (workspace_id, source_key) or reversal_of_id: the
    // other writer's entry is the posting of record.
    const existing = input.sourceKey ? await findEntryBySource(tx, actor.workspaceId, input.sourceKey) : null;
    if (existing) return { entry: existing, created: false };
    throw new OpsError(409, "This entry was already posted");
  }
  await tx.opsJournalLine.createMany({
    data: lines.map((l) => ({
      workspaceId: actor.workspaceId,
      entryId,
      accountId: accountIdOf(l),
      entryDate,
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      memo: l.memo ?? null,
    })),
  });
  await auditJournal(
    tx,
    actor,
    input.reversalOfId ? "reverse" : "post",
    entryId,
    `posted ${input.sourceType} entry ${entryId} (${total}c, ${lines.length} lines)${input.sourceKey ? ` for ${input.sourceKey}` : ""}`,
  );
  return { entry: await getJournalEntry(tx, actor.workspaceId, entryId), created: true };
}

/** Post the mirror of an entry. One reversal per entry; reversals can't be reversed. */
export async function reverseEntry(
  tx: Tx,
  actor: OpsActor,
  entryId: string,
  opts: { entryDate?: Date; memo?: string | null } = {},
): Promise<PostResult> {
  const original = await getJournalEntry(tx, actor.workspaceId, entryId);
  if (original.reversalOfId) throw new OpsError(422, "A reversal entry can't itself be reversed — post a new entry instead");
  if (original.reversedById) {
    return { entry: await getJournalEntry(tx, actor.workspaceId, original.reversedById), created: false };
  }
  const lines: DraftLine[] = reversalLines(
    original.lines.map((l) => ({
      account: { id: l.accountId },
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      memo: l.memo ?? undefined,
    })),
  );
  return postEntry(tx, actor, {
    entryDate: opts.entryDate,
    memo: opts.memo ?? `Reversal of ${entryId}${original.memo ? ` — ${original.memo}` : ""}`,
    sourceType: "reversal",
    sourceId: entryId,
    sourceKey: `reversal:${entryId}`,
    reversalOfId: entryId,
    allowInactive: true,
    lines,
  });
}

export interface JournalListQuery {
  limit?: number;
  from?: Date;
  to?: Date;
  sourceType?: string;
  sourceId?: string;
  accountId?: string;
}

export async function listJournal(tx: Tx, workspaceId: string, q: JournalListQuery = {}): Promise<JournalEntryView[]> {
  const where: Prisma.OpsJournalEntryWhereInput = { workspaceId };
  if (q.from || q.to) where.entryDate = { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) };
  if (q.sourceType) where.sourceType = q.sourceType;
  if (q.sourceId) where.sourceId = q.sourceId;
  if (q.accountId) where.lines = { some: { accountId: q.accountId } };
  const rows = await tx.opsJournalEntry.findMany({
    where,
    include: ENTRY_INCLUDE,
    orderBy: [{ entryDate: "desc" }, { createdAt: "desc" }],
    take: Math.min(Math.max(q.limit ?? 50, 1), 200),
  });
  return rows.map(toView);
}
