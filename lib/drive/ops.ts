// ShapesOS — Phase 21B (WS=drive): actor-aware Drive operations — the layer the
// routes, the Files app and the agent tools call. The mechanics (collisions,
// quotas, the journal) are lib/filesystem/{service,folders,versions}.ts; this
// layer decides WHO may do WHAT: the root policy (roots.ts), the person's role
// on the folder or file (acl.ts via access.ts: folder ACLs with inheritance and
// private homes), and nothing else. No operation here ever skips either.

import { ForbiddenError, NotFoundError } from "@/lib/api/errors";
import { normalizeFolderPath, type PathInfo } from "../filesystem/paths";
import { FsError } from "../filesystem/core";
import { fileCan, type FileAction, type FileRole } from "../files/acl";
import { driveRoleFor, type DriveActor } from "./access";
import { personMayWriteTo } from "./roots";

/** Validate a folder path and make sure this person may add to it. Returns its parsed path. */
export async function requireDirWrite(actor: DriveActor, dirPath: string): Promise<PathInfo> {
  const info = normalizeFolderPath(dirPath);
  if (!info.ok) throw new FsError("invalid_path", info.reason);
  const policy = personMayWriteTo(info, actor.userId);
  if (!policy.ok) {
    // Someone else's home does not exist as far as this person can tell.
    if (info.root === "/home") throw new NotFoundError("Folder not found.");
    throw new ForbiddenError(policy.reason);
  }
  const role = await driveRoleFor(actor, { path: info.path, ownerUserId: info.ownerUserId, createdBy: null });
  if (!role) throw new NotFoundError("Folder not found.");
  if (!fileCan(role, "edit")) throw new ForbiddenError("Your access to this folder doesn't allow adding files.");
  return info;
}

/** Throw unless the person's role on a folder allows `action` (404 when it is not theirs to see). */
export async function requireFolderAction(actor: DriveActor, folder: { path: string; ownerUserId: string | null; createdBy?: string | null }, action: FileAction): Promise<FileRole> {
  const role = await driveRoleFor(actor, { path: folder.path, ownerUserId: folder.ownerUserId, createdBy: folder.createdBy ?? null });
  if (!role) throw new NotFoundError("Folder not found.");
  if (!fileCan(role, action)) throw new ForbiddenError("Your access to this folder doesn't allow that.");
  return role;
}
