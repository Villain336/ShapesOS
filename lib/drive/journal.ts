// ShapesOS — Phase 21B (WS=drive): the change journal, the pure half.
//
// GET /api/drive/changes?cursor= returns events in strict order of a
// per-workspace sequence number. The sequence is allocated inside the same
// transaction as the write it describes, under a row lock on the workspace's
// counter (lib/drive/changes.ts), so commit order IS sequence order: a client
// that has seen cursor N has seen every change committed before N and can
// never later receive one numbered below N.
//
// CONTRACT (the desktop sync engine, apps and Spotlight consume this; see
// lib/drive/SYNC-CONTRACT.md):
//   cursor   opaque "v1.<seq>"; omit/empty = from the beginning.
//   event    { seq, type, entity, entityId, path, prevPath, version, actorUserId, at }
//   type     create | update | move | trash | restore | delete   (delete = purged for good)
//   entity   file | folder
// A person's private home appears only in that person's feed.

export type DriveChangeType = "create" | "update" | "move" | "trash" | "restore" | "delete";

export interface DriveChange {
  seq: bigint;
  type: DriveChangeType;
  entity: "file" | "folder";
  entityId: string;
  path: string;
  prevPath: string | null;
  version: number | null;
  actorUserId: string | null;
  /** ISO time the change was recorded. */
  at: string;
}

export class CursorError extends Error {}

export function formatCursor(seq: bigint): string {
  return `v1.${seq.toString()}`;
}

export function parseCursor(cursor: string | null | undefined): bigint {
  if (cursor === null || cursor === undefined || cursor === "") return 0n;
  const m = /^v1\.(\d{1,19})$/.exec(cursor);
  if (!m) throw new CursorError("Unknown cursor. Start again without one.");
  return BigInt(m[1]!);
}

function privateOwner(path: string | null): string | null {
  if (!path || !path.startsWith("/home/")) return null;
  return path.split("/")[2] ?? null;
}

/**
 * What `userId` may see of a change, or null. A change in someone's private
 * home is theirs alone; a move across the boundary shows the shared side
 * only (into a home it looks like a removal from the shared area).
 */
export function redactChange(c: DriveChange, userId: string): DriveChange | null {
  const now = privateOwner(c.path);
  const before = privateOwner(c.prevPath);
  if (now === null && before === null) return c;
  if (now !== null && before !== null) return now === userId ? c : null;
  if (now !== null) {
    if (now === userId) return c;
    // A move out of the shared area into a home looks like a removal to everyone else;
    // a plain change inside a home (no previous path) is not theirs to see.
    if (c.prevPath === null) return null;
    return { ...c, type: "delete", path: c.prevPath, prevPath: null };
  }
  // home -> shared
  if (before === userId) return c;
  return { ...c, prevPath: null };
}
