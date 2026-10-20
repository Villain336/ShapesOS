// ShapesOS — Phase 21B (WS=drive): sharing a FOLDER. A per-member entry on a folder
// is inherited by everything beneath it unless a deeper entry (a subfolder or a file)
// says otherwise (lib/drive/acl.ts is the arithmetic). In the shared area an entry
// narrows or raises an editor, never beyond their workspace role, and admins are never
// narrowed. In a PRIVATE HOME an entry is the only way anyone but the owner sees
// anything: it is view or edit (never ownership), and it is the owner's alone to give.
// There is no break-glass for admins here; that is a decision for the workspace owner.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { prisma } from "@/lib/prisma";
import { auditEvent } from "@/lib/auditlog";
import { BadRequestError, ForbiddenError, NotFoundError } from "@/lib/api/errors";
import { checkOverride, isFileRole, type FileRole, type WorkspaceRoleName } from "../files/acl";
import { resolveDriveRole, type AclEntry } from "./acl";
import { loadEntries, driveRoleFor, type DriveActor } from "./access";
import { fileCan } from "../files/acl";
import { displayPath } from "../filesystem/paths";
import { recordChanges } from "./changes";
import { lockDriveTree } from "./quota-store";

export interface FolderAccessEntry {
  userId: string;
  name: string | null;
  email: string | null;
  workspaceRole: WorkspaceRoleName;
  /** The entry set on THIS folder, if any. */
  override: FileRole | null;
  /** What they can do here after inheritance (null = nothing: a private folder not shared with them). */
  effective: FileRole | null;
}

async function folderOf(actor: DriveActor, folderId: string) {
  const f = await withWorkspaceScope(actor.workspaceId, (tx) => tx.workspaceFolder.findFirst({ where: { id: folderId, workspaceId: actor.workspaceId, trashedAt: null } }));
  if (!f) throw new NotFoundError("Folder not found.");
  const role = await driveRoleFor(actor, { path: f.path, ownerUserId: f.ownerUserId, createdBy: f.createdBy });
  if (!role) throw new NotFoundError("Folder not found.");
  return { folder: f, role };
}

export async function listFolderAccess(actor: DriveActor, folderId: string): Promise<{ entries: FolderAccessEntry[]; canManage: boolean; private: boolean }> {
  const { folder, role } = await folderOf(actor, folderId);
  const [members, entries] = await Promise.all([
    prisma.workspaceMember.findMany({ where: { workspaceId: actor.workspaceId, userId: { not: null } }, select: { userId: true, name: true, email: true, role: true }, orderBy: { createdAt: "asc" } }),
    withWorkspaceScope(actor.workspaceId, (tx) => loadEntries(tx, actor.workspaceId, null, folder.path, null)),
  ]);
  const own = new Map(entries.filter((e) => e.path === folder.path).map((e) => [e.userId, e.role]));
  const out = members.flatMap((m) => {
    const effective = resolveDriveRole({ workspaceRole: m.role, userId: m.userId!, ownerUserId: folder.ownerUserId, createdBy: folder.createdBy, path: folder.path, entries: entries as AclEntry[] });
    // In a private home only the owner and the people it was shared with are listed.
    if (folder.ownerUserId && !effective) return [];
    return [{ userId: m.userId!, name: m.name, email: m.email, workspaceRole: m.role, override: own.get(m.userId!) ?? null, effective }];
  });
  return { entries: out, canManage: fileCan(role, "manageAccess"), private: !!folder.ownerUserId };
}

/** Set (role) or clear (null) a member's entry on a folder. The folder's owner or an admin (shared area), or the home's owner. */
export async function setFolderAccess(actor: DriveActor, folderId: string, targetUserId: string, role: FileRole | null): Promise<FolderAccessEntry[]> {
  const { folder, role: mine } = await folderOf(actor, folderId);
  if (!fileCan(mine, "manageAccess")) throw new ForbiddenError("Only the folder's owner or an admin can change who can do what with it.");
  if (folder.system) throw new BadRequestError("System folders are shared with the whole workspace; change a subfolder instead.");
  const target = await prisma.workspaceMember.findFirst({ where: { workspaceId: actor.workspaceId, userId: targetUserId }, select: { role: true, email: true, name: true } });
  if (!target) throw new NotFoundError("That person isn't a member of this workspace.");
  if (role !== null) {
    if (!isFileRole(role)) throw new BadRequestError("role is viewer, editor or owner.");
    if (folder.ownerUserId) {
      if (role === "owner") throw new BadRequestError("A share from a private folder is view or edit; ownership stays with the person it belongs to.");
      if (targetUserId === folder.ownerUserId) throw new BadRequestError("That folder is already theirs.");
    } else {
      const ok = checkOverride(target.role, role);
      if (!ok.ok) throw new BadRequestError(ok.reason);
    }
  }
  await withWorkspaceScope(actor.workspaceId, async (tx) => {
    await lockDriveTree(tx, actor.workspaceId);
    if (role === null) await tx.workspaceFolderAcl.deleteMany({ where: { workspaceId: actor.workspaceId, folderId, userId: targetUserId } });
    else {
      const existing = await tx.workspaceFolderAcl.findFirst({ where: { workspaceId: actor.workspaceId, folderId, userId: targetUserId }, select: { id: true } });
      if (existing) await tx.workspaceFolderAcl.update({ where: { id: existing.id, workspaceId: actor.workspaceId }, data: { role, grantedBy: actor.userId } });
      else await tx.workspaceFolderAcl.create({ data: { workspaceId: actor.workspaceId, folderId, userId: targetUserId, role, grantedBy: actor.userId } });
    }
    await recordChanges(tx, actor.workspaceId, [{ type: "update", entity: "folder", entityId: folderId, path: folder.path, actorUserId: actor.userId }]);
  });
  await auditEvent({
    workspaceId: actor.workspaceId,
    projectId: null,
    action: "file_access_changed",
    summary: `Folder "${displayPath(folder.path)}": ${target.email ?? target.name ?? targetUserId} ${role ? `set to ${role}` : "back to their workspace role"}`,
    actorUserId: actor.userId,
  }).catch(() => {});
  return (await listFolderAccess(actor, folderId)).entries;
}
