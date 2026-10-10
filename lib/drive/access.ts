// ShapesOS — Phase 21B (WS=drive): who may do what with a file or folder.
//
// The arithmetic is lib/drive/acl.ts (pure, unit-tested). This file loads its
// inputs: the member's explicit entries on the item (workspace_file_acls) and on
// every folder above it (workspace_folder_acls, FORCE RLS), then resolves one
// role — or null when the item is a private home that was not shared with them.

import type { Prisma, PrismaClient, WorkspaceRole } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { collisionKey } from "../filesystem/paths";
import { ancestorsOf, resolveDriveRole, type AclEntry } from "./acl";
import { isFileRole, type FileRole } from "../files/acl";

type Tx = Prisma.TransactionClient | PrismaClient;

export interface DriveActor {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

/** The explicit ACL entries that can apply to `path` (for one person, or for everyone when `userId` is null). */
export async function loadEntries(tx: Tx, workspaceId: string, userId: string | null, path: string, fileId?: string | null): Promise<AclEntry[]> {
  const dirs = ancestorsOf(path).filter((p) => p !== path || !fileId);
  const folders = dirs.length
    ? await tx.workspaceFolder.findMany({
        where: { workspaceId, trashedAt: null, pathKey: { in: dirs.map(collisionKey) } },
        select: { path: true, acl: { where: userId ? { userId } : {}, select: { userId: true, role: true } } },
      })
    : [];
  const out: AclEntry[] = [];
  for (const f of folders) for (const a of f.acl) if (isFileRole(a.role)) out.push({ path: f.path, userId: a.userId, role: a.role });
  if (fileId) {
    const fas = await tx.workspaceFileAcl.findMany({ where: { workspaceId, fileId, ...(userId ? { userId } : {}) }, select: { userId: true, role: true } });
    for (const fa of fas) if (isFileRole(fa.role)) out.push({ path, userId: fa.userId, role: fa.role });
  }
  return out;
}

export interface ItemRef {
  path: string;
  ownerUserId: string | null;
  createdBy: string | null;
  fileId?: string | null;
}

/** The actor's role on an item, or null when they cannot see it at all. */
export async function driveRoleFor(actor: DriveActor, item: ItemRef, tx?: Tx): Promise<FileRole | null> {
  const run = async (t: Tx) => {
    const entries = await loadEntries(t, actor.workspaceId, actor.userId, item.path, item.fileId);
    return resolveDriveRole({
      workspaceRole: actor.role,
      userId: actor.userId,
      ownerUserId: item.ownerUserId,
      createdBy: item.createdBy,
      path: item.path,
      entries,
    });
  };
  return tx ? run(tx) : withWorkspaceScope(actor.workspaceId, run);
}
