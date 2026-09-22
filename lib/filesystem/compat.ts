// Marketr — attachment compat read path (Phase B, W3, track B1).
//
// Existing FileAttachment rows keep working after chat attach moves to the
// filesystem registry:
//
// - New uploads: storagePath = "fs:<workspaceFileId>" → resolved through the
//   registry (workspace re-checked via the row's project), so bytes live in
//   the workspace filesystem under /files.
// - Legacy uploads: storagePath = ".data/attachments/<projectId>/<uuid>.<ext>"
//   → read straight from disk, path-confined with resolveWithinDir.
//
// Nothing here is addressable by storage key; registry rows remain the only
// mapping between an attachment and its bytes.

import { readFile as fsRead, unlink } from "node:fs/promises";
import { join } from "node:path";
import { resolveWithinDir } from "@/lib/security/upload-safety";
import { readFile as fsReadFile } from "./service";
import { prisma } from "@/lib/prisma";

const FS_PREFIX = "fs:";
const LEGACY_ROOT = ".data/attachments";

/** True when the row points at the new filesystem registry. */
export function isRegistryAttachment(storagePath: string | null | undefined): boolean {
  return !!storagePath && storagePath.startsWith(FS_PREFIX);
}

/**
 * Read attachment bytes, old or new. Returns null when the bytes are gone.
 * Registry reads re-check the workspace via the FileAttachment's project.
 */
export async function readAttachmentBytes(attachment: {
  id: string;
  projectId: string;
  storagePath: string | null;
}): Promise<Buffer | null> {
  const sp = attachment.storagePath;
  if (!sp) return null;

  if (isRegistryAttachment(sp)) {
    const fileId = sp.slice(FS_PREFIX.length);
    const att = await prisma.fileAttachment.findUnique({
      where: { id: attachment.id },
      select: { project: { select: { workspaceId: true } } },
    });
    if (!att) return null;
    const res = await fsReadFile({
      workspaceId: att.project.workspaceId,
      fileId,
    }).catch(() => null);
    return res ? res.bytes : null;
  }

  // Legacy path: must stay inside .data/attachments.
  if (!sp.startsWith(`${LEGACY_ROOT}/`)) return null;
  try {
    const abs = resolveWithinDir(join(process.cwd(), LEGACY_ROOT), sp.slice(LEGACY_ROOT.length + 1));
    return await fsRead(abs);
  } catch {
    return null;
  }
}

/** Delete attachment bytes, old or new. Never throws. */
export async function deleteAttachmentBytes(attachment: {
  projectId: string;
  storagePath: string | null;
}): Promise<void> {
  const sp = attachment.storagePath;
  if (!sp) return;
  if (isRegistryAttachment(sp)) {
    const { deleteFile, trashFile } = await import("./service");
    const fileId = sp.slice(FS_PREFIX.length);
    const att = await prisma.fileAttachment
      .findFirst({
        where: { storagePath: sp },
        select: { project: { select: { workspaceId: true } } },
      })
      .catch(() => null);
    if (!att) return;
    const ws = att.project.workspaceId;
    // Trash-then-purge keeps the "purge requires trash" invariant.
    await trashFile({ workspaceId: ws, fileId }).catch(() => {});
    await deleteFile({ workspaceId: ws, fileId }).catch(() => {});
    return;
  }
  if (!sp.startsWith(`${LEGACY_ROOT}/`)) return;
  try {
    const abs = resolveWithinDir(join(process.cwd(), LEGACY_ROOT), sp.slice(LEGACY_ROOT.length + 1));
    await unlink(abs);
  } catch {
    /* already gone */
  }
}
