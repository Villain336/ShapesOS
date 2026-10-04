// ShapesOS — saving generated images as WorkspaceFiles (Phase 7).
//
// Generated images go through the existing workspace filesystem service
// (lib/filesystem/service.ts writeFile: upload-safety sniff, quota under a
// row lock, S3/MinIO or local storage) — there is no second image store.
// Files land under /files/images/<projectId>/… so a project's images sit
// together in the file tree; WorkspaceFile itself has no project column.

import { randomUUID } from "node:crypto";
import { writeFile, type PublicFile } from "@/lib/filesystem/service";
import { imageFileStem } from "./openai";

export const IMAGE_FILES_ROOT = "/files/images";

/** The in-app URL a member can open the file at (download route, viewer+). */
export function workspaceFileUrl(workspaceId: string, fileId: string): string {
  return `/api/files/${encodeURIComponent(fileId)}?workspaceId=${encodeURIComponent(workspaceId)}&download=1`;
}

function safeSegment(v: string): string {
  return v.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 80) || "x";
}

export interface StoredImage {
  file: PublicFile;
  url: string;
}

/**
 * Save one PNG into the project's image folder. `logicalPath` may be given
 * for deterministic paths (Batch collection: a re-collect hits a 409 instead
 * of duplicating); otherwise a unique name is minted.
 */
export async function storeGeneratedImage(opts: {
  workspaceId: string;
  projectId: string;
  userId: string;
  bytes: Buffer;
  fileName?: string | null;
  logicalPath?: string;
  now?: Date;
}): Promise<StoredImage> {
  const month = (opts.now ?? new Date()).toISOString().slice(0, 7);
  const logicalPath =
    opts.logicalPath ??
    `${IMAGE_FILES_ROOT}/${safeSegment(opts.projectId)}/${month}/${imageFileStem(opts.fileName)}-${randomUUID().slice(0, 8)}.png`;
  const file = await writeFile({
    workspaceId: opts.workspaceId,
    logicalPath,
    kind: "file",
    bytes: opts.bytes,
    mimeType: "image/png",
    createdBy: opts.userId,
    // Bytes come from a third-party service: they still pass the sniff gate.
  });
  return { file, url: workspaceFileUrl(opts.workspaceId, file.id) };
}

export function batchImagePath(projectId: string, batchId: string, customId: string, index: number): string {
  return `${IMAGE_FILES_ROOT}/${safeSegment(projectId)}/batch-${safeSegment(batchId)}/${imageFileStem(customId)}-${index + 1}.png`;
}
