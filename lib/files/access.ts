// ShapesOS — Phase 18.2 (WS=content): per-file access, server side.
//
// The arithmetic is lib/files/acl.ts (pure, unit-tested); this file loads the
// pieces — the member's workspace role, whether they made the file, and the
// per-file override (workspace_file_acls, FORCE RLS) — and is what every
// Files route calls before acting on a file:
//   const { file, role } = await requireFileAction(actor, fileId, "version");

import type { WorkspaceRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { auditEvent } from "@/lib/auditlog";
import { ForbiddenError, NotFoundError, BadRequestError } from "@/lib/api/errors";
import { checkOverride, fileCan, isFileRole, type FileAction, type FileRole } from "./acl";
// Phase 21B (WS=drive): folder ACLs with inheritance and private homes.
import { driveRoleFor, loadEntries } from "@/lib/drive/access";
import { resolveDriveRole } from "@/lib/drive/acl";

export interface FileActor {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

export interface FileRow {
  id: string;
  workspaceId: string;
  logicalPath: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: string;
  createdBy: string;
  createdAt: Date;
  version: number;
  /** Phase 21B: the person whose private home it is (null = the workspace's). */
  ownerUserId: string | null;
}

const FILE_SELECT = { id: true, workspaceId: true, logicalPath: true, filename: true, mimeType: true, sizeBytes: true, kind: true, createdBy: true, createdAt: true, version: true, ownerUserId: true } as const;

/** The member's role on one live file; null when the file isn't in this workspace. */
export async function fileRoleFor(actor: FileActor, fileId: string): Promise<{ file: FileRow; role: FileRole } | null> {
  const file = await prisma.workspaceFile.findFirst({ where: { id: fileId, workspaceId: actor.workspaceId, trashedAt: null }, select: FILE_SELECT });
  if (!file) return null;
  // Folder ACLs above the file and the file's own entry, nearest wins; a file in
  // someone else's private home is invisible unless explicitly shared (null).
  const role = await driveRoleFor(actor, { path: file.logicalPath, ownerUserId: file.ownerUserId, createdBy: file.createdBy, fileId });
  if (!role) return null;
  return { file, role };
}

/** Throws 404 (not in this workspace / trashed) or 403 (the file role can't). */
export async function requireFileAction(actor: FileActor, fileId: string, action: FileAction): Promise<{ file: FileRow; role: FileRole }> {
  const found = await fileRoleFor(actor, fileId);
  if (!found) throw new NotFoundError("File not found.");
  if (!fileCan(found.role, action)) {
    throw new ForbiddenError(
      action === "manageAccess"
        ? "Only the file's owner or an admin can change who can do what with it."
        : "Your access to this file doesn't allow that.",
    );
  }
  return found;
}

export interface FileAccessEntry {
  userId: string;
  name: string | null;
  email: string | null;
  workspaceRole: WorkspaceRole;
  isCreator: boolean;
  override: FileRole | null;
  effective: FileRole;
}

/** Every member's access to the file (anyone who can see it may look). */
export async function listFileAccess(actor: FileActor, fileId: string): Promise<{ entries: FileAccessEntry[]; canManage: boolean }> {
  const { file, role } = await requireFileAction(actor, fileId, "view");
  const [members, aclEntries] = await Promise.all([
    prisma.workspaceMember.findMany({ where: { workspaceId: actor.workspaceId, userId: { not: null } }, select: { userId: true, name: true, email: true, role: true }, orderBy: { createdAt: "asc" } }),
    withWorkspaceScope(actor.workspaceId, (tx) => loadEntries(tx, actor.workspaceId, null, file.logicalPath, fileId)),
  ]);
  const own = new Map(aclEntries.filter((e) => e.path === file.logicalPath).map((e) => [e.userId, e.role]));
  const entries = members.flatMap((m) => {
    const effective = resolveDriveRole({
      workspaceRole: m.role,
      userId: m.userId!,
      ownerUserId: file.ownerUserId,
      createdBy: file.createdBy,
      path: file.logicalPath,
      entries: aclEntries,
    });
    // A private home hides the file from everyone it was not shared with.
    if (!effective) return [];
    return [{
      userId: m.userId!,
      name: m.name,
      email: m.email,
      workspaceRole: m.role,
      isCreator: file.createdBy === m.userId,
      override: own.get(m.userId!) ?? null,
      effective,
    }];
  });
  return { entries, canManage: fileCan(role, "manageAccess") };
}

/** Set (role) or clear (null) a member's override. File owners and admins only. */
export async function setFileAccess(actor: FileActor, fileId: string, targetUserId: string, role: FileRole | null): Promise<FileAccessEntry[]> {
  const { file } = await requireFileAction(actor, fileId, "manageAccess");
  const target = await prisma.workspaceMember.findFirst({ where: { workspaceId: actor.workspaceId, userId: targetUserId }, select: { role: true, email: true, name: true } });
  if (!target) throw new NotFoundError("That person isn't a member of this workspace.");
  if (role !== null) {
    if (!isFileRole(role)) throw new BadRequestError("role is viewer, editor or owner.");
    if (file.ownerUserId) {
      // A share into a private home (admins included) is view or edit, never ownership.
      if (role === "owner") throw new BadRequestError("A share from a private folder is view or edit; ownership stays with the person it belongs to.");
    } else {
      const ok = checkOverride(target.role, role);
      if (!ok.ok) throw new BadRequestError(ok.reason);
    }
  }
  if (targetUserId === actor.userId && role !== null && role !== "owner") {
    throw new BadRequestError("You can't lower your own access to a file; ask another owner or an admin.");
  }
  await withWorkspaceScope(actor.workspaceId, async (tx) => {
    if (role === null) {
      await tx.workspaceFileAcl.deleteMany({ where: { workspaceId: actor.workspaceId, fileId, userId: targetUserId } });
    } else {
      const existing = await tx.workspaceFileAcl.findFirst({ where: { workspaceId: actor.workspaceId, fileId, userId: targetUserId }, select: { id: true } });
      if (existing) await tx.workspaceFileAcl.update({ where: { id: existing.id, workspaceId: actor.workspaceId }, data: { role, grantedBy: actor.userId } });
      else await tx.workspaceFileAcl.create({ data: { workspaceId: actor.workspaceId, fileId, userId: targetUserId, role, grantedBy: actor.userId } });
    }
  });
  await auditEvent({
    workspaceId: actor.workspaceId,
    projectId: null,
    action: "file_access_changed",
    summary: `"${file.filename}": ${target.email ?? target.name ?? targetUserId} ${role ? `set to ${role}` : "back to their workspace role"}`,
    actorUserId: actor.userId,
  }).catch(() => {});
  return (await listFileAccess(actor, fileId)).entries;
}
