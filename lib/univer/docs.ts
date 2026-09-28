// Marketr — Phase 14 slice 6: UniverDoc persistence (host-owned storage).
//
// The host (Marketr) owns storage: Univer hands us content snapshots
// (IWorkbookData / IDocumentData JSON) and we persist them versioned per
// workspace. All access is tenant-scoped via withWorkspaceScope — the same
// fail-closed RLS pattern as the Composio tables.

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import {
  isUniverDocKind,
  validateSnapshot,
  type UniverDocKind,
} from "@/lib/univer/snapshots";

export const UNIVER_SHARE_STATES = ["private", "workspace", "link"] as const;
export type UniverShareState = (typeof UNIVER_SHARE_STATES)[number];

export interface UniverDocRecord {
  id: string;
  workspaceId: string;
  kind: UniverDocKind;
  title: string;
  snapshot: unknown;
  version: number;
  sourceRef: string | null;
  shareState: string;
  createdAt: Date;
  updatedAt: Date;
}

function toRecord(row: {
  id: string;
  workspaceId: string;
  kind: string;
  title: string;
  snapshot: unknown;
  version: number;
  sourceRef: string | null;
  shareState: string;
  createdAt: Date;
  updatedAt: Date;
}): UniverDocRecord {
  return {
    ...row,
    kind: isUniverDocKind(row.kind) ? row.kind : "sheet",
  };
}

export interface CreateUniverDocInput {
  kind: UniverDocKind;
  title: string;
  snapshot: unknown;
  sourceRef?: string;
  shareState?: UniverShareState;
}

/** Create a doc. Snapshot goes through the validate gate — invalid never persists. */
export async function createUniverDoc(
  workspaceId: string,
  input: CreateUniverDocInput,
): Promise<UniverDocRecord> {
  if (!isUniverDocKind(input.kind)) throw new Error(`invalid kind: ${String(input.kind)}`);
  const title = input.title.trim();
  if (!title) throw new Error("title is required");
  if (title.length > 200) throw new Error("title exceeds 200 chars");
  const validation = validateSnapshot(input.kind, input.snapshot);
  if (!validation.ok) {
    throw new Error(`invalid ${input.kind} snapshot: ${validation.errors.join("; ")}`);
  }
  const shareState: UniverShareState =
    input.shareState && (UNIVER_SHARE_STATES as readonly string[]).includes(input.shareState)
      ? input.shareState
      : "private";

  const row = await withWorkspaceScope(workspaceId, (tx) =>
    tx.univerDoc.create({
      data: {
        workspaceId,
        kind: input.kind,
        title,
        snapshot: input.snapshot as object,
        sourceRef: input.sourceRef?.slice(0, 200) ?? null,
        shareState,
      },
    }),
  );
  return toRecord(row);
}

/** Get one doc; null when missing or owned by another workspace (RLS). */
export async function getUniverDoc(
  workspaceId: string,
  id: string,
): Promise<UniverDocRecord | null> {
  const row = await withWorkspaceScope(workspaceId, (tx) =>
    tx.univerDoc.findUnique({ where: { id } }),
  );
  return row ? toRecord(row) : null;
}

export interface ListUniverDocsOptions {
  kind?: UniverDocKind;
  sourceRef?: string;
  limit?: number;
}

/** Newest-first list for the Office docs surface. */
export async function listUniverDocs(
  workspaceId: string,
  opts: ListUniverDocsOptions = {},
): Promise<UniverDocRecord[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.univerDoc.findMany({
      where: {
        workspaceId,
        ...(opts.kind && isUniverDocKind(opts.kind) ? { kind: opts.kind } : {}),
        ...(opts.sourceRef ? { sourceRef: opts.sourceRef } : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: limit,
    }),
  );
  return rows.map(toRecord);
}

/**
 * Persist a new snapshot from the editor. Version bumps atomically so the
 * UI can detect concurrent saves (expectedVersion mismatch → 409).
 */
export async function saveUniverDocSnapshot(
  workspaceId: string,
  id: string,
  snapshot: unknown,
  opts: { expectedVersion?: number } = {},
): Promise<UniverDocRecord> {
  const existing = await getUniverDoc(workspaceId, id);
  if (!existing) throw new Error("doc not found");
  const validation = validateSnapshot(existing.kind, snapshot);
  if (!validation.ok) {
    throw new Error(`invalid ${existing.kind} snapshot: ${validation.errors.join("; ")}`);
  }
  if (opts.expectedVersion !== undefined && opts.expectedVersion !== existing.version) {
    throw new Error(
      `version conflict: expected ${opts.expectedVersion}, current ${existing.version}`,
    );
  }
  const row = await withWorkspaceScope(workspaceId, (tx) =>
    tx.univerDoc.update({
      where: { id },
      data: { snapshot: snapshot as object, version: { increment: 1 } },
    }),
  );
  return toRecord(row);
}

export async function renameUniverDoc(
  workspaceId: string,
  id: string,
  title: string,
): Promise<UniverDocRecord> {
  const clean = title.trim();
  if (!clean) throw new Error("title is required");
  if (clean.length > 200) throw new Error("title exceeds 200 chars");
  const existing = await getUniverDoc(workspaceId, id);
  if (!existing) throw new Error("doc not found");
  const row = await withWorkspaceScope(workspaceId, (tx) =>
    tx.univerDoc.update({ where: { id }, data: { title: clean } }),
  );
  return toRecord(row);
}

export async function deleteUniverDoc(workspaceId: string, id: string): Promise<void> {
  const existing = await getUniverDoc(workspaceId, id);
  if (!existing) throw new Error("doc not found");
  await withWorkspaceScope(workspaceId, (tx) => tx.univerDoc.delete({ where: { id } }));
}
