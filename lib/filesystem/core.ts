// ShapesOS — Phase 21B (WS=drive): shared constants and the error type of the
// workspace filesystem, in a module of their own so lib/drive/* can use them
// without importing lib/filesystem/service.ts (which imports lib/drive/*).
// service.ts re-exports everything here, so existing imports keep working.

export const DEFAULT_QUOTA_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
export const TRASH_RETENTION_DAYS = 30;
/** Buffered (single request) writes: uploads through the browser form and server-made files. */
export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024; // W1 upload cap

/**
 * The hard maximum for ONE file written through the large-file path. The
 * per-upload cap is quota-governed (a file may be as big as the quota room
 * allows) but never above this. 2 GiB - 1 because workspace_files.size_bytes
 * is a 32-bit column; raising it needs a BIGINT migration.
 */
export const MAX_FILE_BYTES_CEILING = 2_147_483_647;

export function driveMaxFileBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.DRIVE_MAX_FILE_BYTES);
  if (Number.isFinite(raw) && raw > 0) return Math.min(Math.floor(raw), MAX_FILE_BYTES_CEILING);
  return MAX_FILE_BYTES_CEILING;
}

export type FsErrorCode =
  | "not_found"
  | "conflict"
  | "quota_exceeded"
  | "invalid_path"
  | "unsafe_content"
  | "too_large"
  | "invalid_state"
  | "scanner_unavailable"
  | "forbidden";

export class FsError extends Error {
  readonly code: FsErrorCode;
  constructor(code: FsErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
