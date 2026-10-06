// ShapesOS — Phase 18.2 (WS=content): version history for Office docs and
// notes (UniverDoc rows of every kind).
//
//   - Snapshots on idle ("auto"): before a save overwrites a doc that sat
//     untouched for AUTO_SNAPSHOT_IDLE_MS, the state it had is kept — so each
//     editing session can be rolled back to how it started. The collab server
//     (lib/collab/server.ts) also snapshots the live document once it goes
//     idle, at most every AUTO_SNAPSHOT_EVERY_MS.
//   - Named versions ("named"): a person saves the current state with a name.
//   - Restore: the current state is kept first ("restore"), then the chosen
//     snapshot is written back as a NEW doc version (history only grows), and
//     any live-collaboration state is dropped so every editor reloads it.
//
// All reads/writes run inside withWorkspaceScope (univer_doc_versions and
// univer_docs are FORCE RLS) and also filter by workspaceId.

import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { BadRequestError, NotFoundError } from "@/lib/api/errors";

/**
 * Spotlight re-index, lazily: the indexer (and its embedder) must never be in
 * a route bundle (coordinator's bundle-size rule) — it loads on first use.
 * Integration may repoint this to @/lib/search/text-index-schedule.
 */
function scheduleDocTextIndex(workspaceId: string, docId: string): void {
  void import("@/lib/search/text-index")
    .then((m) => m.scheduleUniverDocTextIndex(workspaceId, docId))
    .catch(() => undefined);
}


type Tx = Prisma.TransactionClient;

/** A doc untouched this long gets its state kept before the next save. */
export const AUTO_SNAPSHOT_IDLE_MS = 5 * 60_000;
/** The collab server snapshots a live doc at most this often. */
export const AUTO_SNAPSHOT_EVERY_MS = 10 * 60_000;
/** Automatic snapshots kept per doc (named and restore versions are never pruned). */
export const AUTO_VERSIONS_KEPT = 50;
export const VERSION_NAME_MAX = 120;

export type DocVersionKind = "auto" | "named" | "restore";

export interface DocVersionMeta {
  id: string;
  docId: string;
  docVersion: number;
  kind: DocVersionKind;
  name: string | null;
  title: string;
  createdBy: string | null;
  createdAt: string;
}

/**
 * PURE: should the state a doc has now be kept before it is overwritten?
 * Yes when the doc was idle for AUTO_SNAPSHOT_IDLE_MS and no version was
 * taken since its last change.
 */
export function shouldSnapshotBeforeSave(input: { updatedAt: Date; lastVersionAt: Date | null; now: Date }): boolean {
  if (input.now.getTime() - input.updatedAt.getTime() < AUTO_SNAPSHOT_IDLE_MS) return false;
  return !input.lastVersionAt || input.lastVersionAt.getTime() < input.updatedAt.getTime();
}

/** PURE: should the collab server snapshot a live doc now? */
export function shouldSnapshotLive(input: { lastVersionAt: Date | null; now: Date }): boolean {
  return !input.lastVersionAt || input.now.getTime() - input.lastVersionAt.getTime() >= AUTO_SNAPSHOT_EVERY_MS;
}

function toMeta(r: { id: string; docId: string; docVersion: number; kind: string; name: string | null; title: string; createdBy: string | null; createdAt: Date }): DocVersionMeta {
  return {
    id: r.id,
    docId: r.docId,
    docVersion: r.docVersion,
    kind: (["auto", "named", "restore"].includes(r.kind) ? r.kind : "auto") as DocVersionKind,
    name: r.name,
    title: r.title,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  };
}

const META_SELECT = { id: true, docId: true, docVersion: true, kind: true, name: true, title: true, createdBy: true, createdAt: true } as const;

/** Keep one version of a doc (inside the caller's tenant transaction). */
export async function recordDocVersion(
  tx: Tx,
  input: { workspaceId: string; docId: string; docVersion: number; kind: DocVersionKind; name?: string | null; title: string; snapshot: unknown; createdBy?: string | null },
): Promise<DocVersionMeta> {
  const row = await tx.univerDocVersion.create({
    data: {
      workspaceId: input.workspaceId,
      docId: input.docId,
      docVersion: input.docVersion,
      kind: input.kind,
      name: input.name ? input.name.slice(0, VERSION_NAME_MAX) : null,
      title: input.title.slice(0, 200),
      snapshot: input.snapshot as Prisma.InputJsonValue,
      createdBy: input.createdBy ?? null,
    },
    select: META_SELECT,
  });
  if (input.kind === "auto") await pruneAutoVersions(tx, input.workspaceId, input.docId);
  return toMeta(row);
}

async function pruneAutoVersions(tx: Tx, workspaceId: string, docId: string): Promise<void> {
  const old = await tx.univerDocVersion.findMany({
    where: { workspaceId, docId, kind: "auto" },
    orderBy: { createdAt: "desc" },
    skip: AUTO_VERSIONS_KEPT,
    select: { id: true },
  });
  if (old.length) await tx.univerDocVersion.deleteMany({ where: { workspaceId, id: { in: old.map((o) => o.id) } } });
}

/** The newest version's time (any kind), or null. */
export async function lastVersionAt(tx: Tx, workspaceId: string, docId: string): Promise<Date | null> {
  const last = await tx.univerDocVersion.findFirst({
    where: { workspaceId, docId },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return last?.createdAt ?? null;
}

/**
 * Before overwriting `doc`, keep its current state when it was idle long
 * enough (see shouldSnapshotBeforeSave). Call inside the save's transaction.
 */
export async function snapshotBeforeSave(
  tx: Tx,
  doc: { id: string; workspaceId: string; version: number; title: string; snapshot: unknown; updatedAt: Date },
  userId: string | null,
  now = new Date(),
): Promise<boolean> {
  const last = await lastVersionAt(tx, doc.workspaceId, doc.id);
  if (!shouldSnapshotBeforeSave({ updatedAt: doc.updatedAt, lastVersionAt: last, now })) return false;
  await recordDocVersion(tx, {
    workspaceId: doc.workspaceId,
    docId: doc.id,
    docVersion: doc.version,
    kind: "auto",
    title: doc.title,
    snapshot: doc.snapshot,
    createdBy: userId,
  });
  return true;
}

/** Newest first, metadata only (snapshots can be large). */
export async function listDocVersions(workspaceId: string, docId: string, limit = 100): Promise<DocVersionMeta[]> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.univerDocVersion.findMany({
      where: { workspaceId, docId },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 200),
      select: META_SELECT,
    }),
  );
  return rows.map(toMeta);
}

/** One version with its snapshot (for preview). Null when not in this workspace/doc. */
export async function getDocVersion(workspaceId: string, docId: string, versionId: string): Promise<(DocVersionMeta & { snapshot: unknown }) | null> {
  const row = await withWorkspaceScope(workspaceId, (tx) =>
    tx.univerDocVersion.findFirst({ where: { id: versionId, workspaceId, docId }, select: { ...META_SELECT, snapshot: true } }),
  );
  return row ? { ...toMeta(row), snapshot: row.snapshot } : null;
}

/** Save the doc's current state as a named version. */
export async function saveNamedVersion(workspaceId: string, docId: string, name: string, userId: string): Promise<DocVersionMeta> {
  const clean = name.replace(/\s+/g, " ").trim();
  if (!clean) throw new BadRequestError("A version needs a name.");
  if (clean.length > VERSION_NAME_MAX) throw new BadRequestError(`A version name is at most ${VERSION_NAME_MAX} characters.`);
  return withWorkspaceScope(workspaceId, async (tx) => {
    const doc = await tx.univerDoc.findFirst({ where: { id: docId, workspaceId }, select: { id: true, version: true, title: true, snapshot: true } });
    if (!doc) throw new NotFoundError("Document not found.");
    return recordDocVersion(tx, { workspaceId, docId, docVersion: doc.version, kind: "named", name: clean, title: doc.title, snapshot: doc.snapshot, createdBy: userId });
  });
}

/**
 * Restore a version: keep the current state ("restore"), write the chosen
 * snapshot back as a new doc version, and drop the live-collaboration state
 * (the collab server notices the version change and makes every editor
 * reload). Returns the doc's new version number.
 */
export async function restoreDocVersion(
  workspaceId: string,
  docId: string,
  versionId: string,
  userId: string,
): Promise<{ version: number; restoredFrom: DocVersionMeta }> {
  const res = await withWorkspaceScope(workspaceId, async (tx) => {
    const v = await tx.univerDocVersion.findFirst({ where: { id: versionId, workspaceId, docId }, select: { ...META_SELECT, snapshot: true } });
    if (!v) throw new NotFoundError("Version not found.");
    const doc = await tx.univerDoc.findFirst({ where: { id: docId, workspaceId }, select: { id: true, version: true, title: true, snapshot: true } });
    if (!doc) throw new NotFoundError("Document not found.");
    await recordDocVersion(tx, { workspaceId, docId, docVersion: doc.version, kind: "restore", name: null, title: doc.title, snapshot: doc.snapshot, createdBy: userId });
    const updated = await tx.univerDoc.update({
      where: { id: docId, workspaceId },
      data: { snapshot: v.snapshot as Prisma.InputJsonValue, title: v.title, version: { increment: 1 } },
      select: { version: true },
    });
    await tx.univerDocCollabState.deleteMany({ where: { workspaceId, docId } });
    return { version: updated.version, restoredFrom: toMeta(v) };
  });
  // Spotlight and agents read the restored text.
  scheduleDocTextIndex(workspaceId, docId);
  return res;
}
