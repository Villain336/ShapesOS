// ShapesOS — CTV creative validation: dev/test-only local video path reader.
//
// POST /api/flywheel/ctv/creative/validate accepts `videoPath` for local
// ingestion during development. The old check was a raw
// startsWith(tmpdir() + "/"), so "/tmp/../etc/passwd" (or a symlink placed in
// /tmp) read arbitrary files, and a device path that never ends (/dev/zero
// via a /tmp symlink) exhausted memory. This reader:
//   - is refused outright in production (use fileId there);
//   - resolves the real path (symlinks + "..") and requires it to sit inside
//     the real temp dir (path.relative, not a string prefix);
//   - requires a regular file and enforces a byte cap on the OPEN handle
//     (fstat after open, so a swap between check and read can't bypass it).

import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Largest local creative the dev path reader will load (bytes). */
export const DEV_VIDEO_MAX_BYTES = 512 * 1024 * 1024;

export class DevVideoPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevVideoPathError";
  }
}

export interface DevVideoPathOptions {
  /** Directory the path must resolve inside (default: OS temp dir). */
  baseDir?: string;
  maxBytes?: number;
  /** Defaults to process.env.NODE_ENV. */
  nodeEnv?: string;
}

export async function readDevVideoPath(
  rawPath: string,
  opts: DevVideoPathOptions = {},
): Promise<{ bytes: Buffer; realPath: string }> {
  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV;
  if (nodeEnv === "production") {
    throw new DevVideoPathError("videoPath is disabled in production — upload the creative and pass fileId.");
  }
  if (typeof rawPath !== "string" || !path.isAbsolute(rawPath) || rawPath.includes("\0")) {
    throw new DevVideoPathError("videoPath must be an absolute path.");
  }
  const maxBytes = opts.maxBytes ?? DEV_VIDEO_MAX_BYTES;
  let base: string;
  let real: string;
  try {
    base = await realpath(opts.baseDir ?? tmpdir());
    real = await realpath(rawPath);
  } catch {
    throw new DevVideoPathError("videoPath not found.");
  }
  const rel = path.relative(base, real);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new DevVideoPathError("videoPath is restricted to the OS temp dir (use fileId for workspace files).");
  }
  // O_NONBLOCK: opening a FIFO must not hang the request; regular files are
  // unaffected. The type/size checks run on the open handle.
  const fh = await open(real, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new DevVideoPathError("videoPath must be a regular file.");
    if (st.size > maxBytes) throw new DevVideoPathError(`videoPath exceeds the ${maxBytes}-byte limit.`);
    const bytes = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < st.size) {
      const { bytesRead } = await fh.read(bytes, offset, st.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { bytes: bytes.subarray(0, offset), realPath: real };
  } finally {
    await fh.close();
  }
}
