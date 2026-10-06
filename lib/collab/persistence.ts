// ShapesOS — Phase 18.2 (WS=content): where a live document lives in Postgres.
//
// The collab server (lib/collab/server.ts) is the only caller. Every read and
// write runs under the workspace scope from the verified token (FORCE RLS on
// univer_docs and univer_doc_collab_states) and also filters by workspaceId.
//
//   loadCollabDoc   the stored yjs state, or — the first time a note is
//                   opened live — a yjs document seeded from the note's JSON
//                   snapshot (so nothing written before collaboration is lost)
//   storeCollabDoc  the yjs state to univer_doc_collab_states AND the JSON
//                   snapshot back to univer_docs.snapshot (version + 1), so
//                   Spotlight, agents (read_note) and export always read the
//                   latest text; a live snapshot into the version history at
//                   most every AUTO_SNAPSHOT_EVERY_MS. Refuses (returns
//                   "stale") when someone else replaced the document since it
//                   was loaded — a version restore or a non-live save — so a
//                   stale live copy never overwrites it.
//   docVersions     current version numbers (the server's poll for restores)

import * as Y from "yjs";
import { getSchema } from "@tiptap/core";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "@tiptap/y-tiptap";
import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { NOTE_YJS_FIELD, noteSchemaExtensions } from "@/lib/notes/schema";
import { emptyNoteDoc, validateNoteDoc } from "@/lib/notes/content";
import { recordDocVersion, lastVersionAt, shouldSnapshotLive } from "@/lib/univer/versions";
import type { CollabDocKind } from "./token";

let schemaCache: ReturnType<typeof getSchema> | null = null;
/** The note schema (same extensions as the browser editor). */
export function noteSchema() {
  schemaCache ??= getSchema(noteSchemaExtensions({ history: false }));
  return schemaCache;
}

export interface LoadedCollabDoc {
  /** yjs update to apply to the live document. */
  update: Uint8Array;
  /** univer_docs.version at load time. */
  version: number;
  seeded: boolean;
}

/** null = the doc doesn't exist in this workspace (or isn't of this kind). */
export async function loadCollabDoc(workspaceId: string, kind: CollabDocKind, docId: string): Promise<LoadedCollabDoc | null> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const doc = await tx.univerDoc.findFirst({ where: { id: docId, workspaceId, kind }, select: { id: true, version: true, snapshot: true } });
    if (!doc) return null;
    const state = await tx.univerDocCollabState.findFirst({ where: { docId, workspaceId }, select: { state: true } });
    if (state) return { update: new Uint8Array(state.state), version: doc.version, seeded: false };
    const v = validateNoteDoc(doc.snapshot);
    const seed = prosemirrorJSONToYDoc(noteSchema(), v.ok ? v.doc : emptyNoteDoc(), NOTE_YJS_FIELD);
    const update = Y.encodeStateAsUpdate(seed);
    seed.destroy();
    return { update, version: doc.version, seeded: true };
  });
}

export type StoreResult = { status: "stored"; version: number; snapshotted: boolean } | { status: "unchanged"; version: number } | { status: "stale"; version: number } | { status: "missing" };

/** The note JSON a live yjs document holds. */
export function collabDocJson(ydoc: Y.Doc): unknown {
  return yDocToProsemirrorJSON(ydoc, NOTE_YJS_FIELD);
}

export async function storeCollabDoc(
  workspaceId: string,
  kind: CollabDocKind,
  docId: string,
  ydoc: Y.Doc,
  expectedVersion: number,
  userId: string | null,
  now = new Date(),
): Promise<StoreResult> {
  const json = collabDocJson(ydoc);
  const v = validateNoteDoc(json);
  const state = Buffer.from(Y.encodeStateAsUpdate(ydoc));
  return withWorkspaceScope(workspaceId, async (tx) => {
    // Lock the row: a restore and a store can't interleave.
    const rows = await tx.$queryRaw<Array<{ version: number; title: string; snapshot: unknown }>>`
      SELECT version, title, snapshot FROM univer_docs WHERE id = ${docId} AND workspace_id = ${workspaceId} AND kind = ${kind} FOR UPDATE`;
    const doc = rows[0];
    if (!doc) return { status: "missing" } as const;
    if (doc.version !== expectedVersion) return { status: "stale", version: doc.version } as const;
    await tx.univerDocCollabState.upsert({
      where: { docId, workspaceId },
      create: { docId, workspaceId, state },
      update: { state },
    });
    if (!v.ok) return { status: "unchanged", version: doc.version } as const;
    if (JSON.stringify(doc.snapshot) === JSON.stringify(v.doc)) return { status: "unchanged", version: doc.version } as const;
    const updated = await tx.univerDoc.update({
      where: { id: docId, workspaceId },
      data: { snapshot: v.doc as unknown as Prisma.InputJsonValue, version: { increment: 1 } },
      select: { version: true, title: true },
    });
    let snapshotted = false;
    if (shouldSnapshotLive({ lastVersionAt: await lastVersionAt(tx, workspaceId, docId), now })) {
      await recordDocVersion(tx, { workspaceId, docId, docVersion: updated.version, kind: "auto", title: updated.title, snapshot: v.doc, createdBy: userId });
      snapshotted = true;
    }
    return { status: "stored", version: updated.version, snapshotted } as const;
  });
}

/** Current versions of these docs (one workspace). Missing docs are absent. */
export async function docVersions(workspaceId: string, docIds: string[]): Promise<Map<string, number>> {
  if (docIds.length === 0) return new Map();
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.univerDoc.findMany({ where: { workspaceId, id: { in: docIds } }, select: { id: true, version: true } }),
  );
  return new Map(rows.map((r) => [r.id, r.version]));
}
