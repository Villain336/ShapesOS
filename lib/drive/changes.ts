// ShapesOS — Phase 21B (WS=drive): the change journal, the database half.
//
// recordChange() runs INSIDE the transaction of the write it describes. It
// takes the next number from the workspace's counter row with one atomic
// upsert (INSERT … ON CONFLICT DO UPDATE seq = seq + n). That update holds the
// counter row's lock until the writer commits, so two writers in one workspace
// are strictly ordered and COMMIT ORDER == SEQUENCE ORDER: when a reader can
// see event N, every event below N is committed and visible too. A client
// that saves the last cursor it got can never miss a change that gets a lower
// number later. (The cost: writes to one workspace's tree are serialised at
// the counter. They already serialise on the quota row.)
//
// Lock order everywhere: workspace quota row -> scope quota rows -> this
// counter row (always last), so the journal cannot create a deadlock.

import type { Prisma, PrismaClient } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { CursorError, formatCursor, parseCursor, redactChange, type DriveChange, type DriveChangeType } from "./journal";

type Tx = Prisma.TransactionClient | PrismaClient;

export interface NewChange {
  type: DriveChangeType;
  entity: "file" | "folder";
  entityId: string;
  path: string;
  prevPath?: string | null;
  version?: number | null;
  actorUserId?: string | null;
}

/** Record events for the write in progress. Returns their sequence numbers, in order. */
export async function recordChanges(tx: Tx, workspaceId: string, changes: NewChange[]): Promise<bigint[]> {
  if (changes.length === 0) return [];
  const n = changes.length;
  const rows = (await tx.$queryRaw`
    INSERT INTO "workspace_drive_cursors" ("workspace_id", "seq", "floor_seq")
    VALUES (${workspaceId}, ${n}, 0)
    ON CONFLICT ("workspace_id") DO UPDATE SET "seq" = "workspace_drive_cursors"."seq" + ${n}
    RETURNING "seq"
  `) as Array<{ seq: bigint }>;
  const last = BigInt(rows[0]!.seq);
  const seqs = changes.map((_, i) => last - BigInt(n - 1 - i));
  await tx.workspaceDriveChange.createMany({
    data: changes.map((c, i) => ({
      workspaceId,
      seq: seqs[i]!,
      type: c.type,
      entity: c.entity,
      entityId: c.entityId,
      path: c.path,
      prevPath: c.prevPath ?? null,
      version: c.version ?? null,
      actorUserId: c.actorUserId ?? null,
    })),
  });
  return seqs;
}

export async function recordChange(tx: Tx, workspaceId: string, change: NewChange): Promise<bigint> {
  return (await recordChanges(tx, workspaceId, [change]))[0]!;
}

export class CursorExpiredError extends Error {}

export interface ChangesPage {
  changes: Array<Omit<DriveChange, "seq"> & { seq: string; cursor: string }>;
  /** Pass this back as ?cursor= to continue. Equal to the input when nothing is new. */
  cursor: string;
  /** The newest event number in the workspace right now (a full listing taken before reading it is consistent with following from here). */
  head: string;
  hasMore: boolean;
}

export const MAX_CHANGES_PAGE = 500;

/** Events after `cursor`, in order, as `viewerUserId` may see them. */
export async function listChanges(args: { workspaceId: string; viewerUserId: string; cursor?: string | null; limit?: number }): Promise<ChangesPage> {
  const from = parseCursor(args.cursor);
  const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 200)), MAX_CHANGES_PAGE);
  return withWorkspaceScope(args.workspaceId, async (tx) => {
    const cur = await tx.workspaceDriveCursor.findUnique({ where: { workspaceId: args.workspaceId } });
    const head = cur?.seq ?? 0n;
    const floor = cur?.floorSeq ?? 0n;
    if (from > head) throw new CursorError("That cursor is from the future. Start again without one.");
    if (from < floor) throw new CursorExpiredError("That cursor is older than the journal keeps. Do a full listing, then follow changes from the head cursor.");
    const rows = await tx.workspaceDriveChange.findMany({
      where: { workspaceId: args.workspaceId, seq: { gt: from } },
      orderBy: { seq: "asc" },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const out: ChangesPage["changes"] = [];
    for (const r of page) {
      const ev: DriveChange = {
        seq: r.seq,
        type: r.type as DriveChangeType,
        entity: r.entity as "file" | "folder",
        entityId: r.entityId,
        path: r.path,
        prevPath: r.prevPath,
        version: r.version,
        actorUserId: r.actorUserId,
        at: r.createdAt.toISOString(),
      };
      const seen = redactChange(ev, args.viewerUserId);
      if (seen) out.push({ ...seen, seq: r.seq.toString(), cursor: formatCursor(r.seq) });
    }
    const last = page.length ? page[page.length - 1]!.seq : from;
    return { changes: out, cursor: formatCursor(last), head: formatCursor(head), hasMore };
  });
}

/** Drop events older than `before` (keeps the counter; clients behind the new floor must resync). */
export async function purgeChangesBefore(workspaceId: string, before: Date): Promise<{ purged: number }> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const old = await tx.workspaceDriveChange.findFirst({
      where: { workspaceId, createdAt: { lt: before } },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    if (!old) return { purged: 0 };
    const res = await tx.workspaceDriveChange.deleteMany({ where: { workspaceId, seq: { lte: old.seq } } });
    await tx.workspaceDriveCursor.update({ where: { workspaceId }, data: { floorSeq: old.seq } });
    return { purged: res.count };
  });
}
