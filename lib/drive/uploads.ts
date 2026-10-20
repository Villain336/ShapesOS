// ShapesOS — Phase 21B (WS=drive): large files — resumable multipart uploads.
//
// Flow (S3-compatible storage; local-disk mode keeps the buffered 25 MB path):
//   initiate  -> a row (workspace_uploads, FORCE RLS) + the provider's UploadId;
//                the per-upload cap is QUOTA-GOVERNED (the room the workspace and
//                the target scope have left), under a hard maximum
//                (DRIVE_MAX_FILE_BYTES, default 2 GiB - 1)
//   parts     -> presigned PUT URLs, one per part; the browser sends bytes straight
//                to object storage, never through this server; re-ask for any part
//                to resume after a drop
//   status    -> asks the PROVIDER which parts it holds (the source of truth; the
//                client never needs to read ETag headers)
//   complete  -> assembles the object, then ... validates it: files up to 25 MB get
//                the full upload-safety gate; larger ones must be one of the safe
//                large types (images, PDF, text), are sniffed on their head, and
//                are scanned END TO END by the malware scanner, streamed in ranges.
//                A rejected object is deleted. Only then does the file row exist.
//   abort     -> drops the provider upload and the row.
// The state machine is lib/drive/multipart.ts (pure, unit-tested). Hosted
// deployments refuse to START an upload when no scanner is configured.
//
// Operations on a half-finished upload belong to the person who started it.

import { randomUUID } from "node:crypto";
import type { WorkspaceRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { auditEvent } from "@/lib/auditlog";
import { NotFoundError } from "@/lib/api/errors";
import { validateUploadBuffer } from "@/lib/security/upload-safety";
import { getMalwareScanner, scannerPolicy, ScannerNotConfiguredError } from "@/lib/security/malware-scan";
import { scheduleFileTextIndex } from "@/lib/search/text-index-schedule";
import { FsError, DEFAULT_MAX_FILE_BYTES, driveMaxFileBytes } from "../filesystem/core";
import { basenameOf, dirnameOf, normalizeLogicalPath, sanitizeUploadName, type PathInfo } from "../filesystem/paths";
import { getStorageAdapter, supportsMultipart, type MultipartStorage, type StorageAdapter } from "../filesystem/storage";
import { registerStoredFile } from "../filesystem/service";
import { overwriteFromStoredBlob } from "../filesystem/versions";
import { requireFileAction } from "../files/access";
import { requireDirWrite } from "./ops";
import { MIN_PART_BYTES, MAX_PARTS, abortUpload as abortState, choosePartSize, completeUpload as completeState, expectedPartSize, newUpload, recordPart, type UploadState, type UploadStatus } from "./multipart";
import { quotaScopesFor, uploadLimitBytes } from "./quota";
import { getScopeUsage } from "./quota-store";

export interface UploadActor {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

/** Above this size only these types are accepted (their checks do not need the whole file). */
export const LARGE_FILE_EXTENSIONS: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
};
const LARGE_MIMES = new Set(Object.values(LARGE_FILE_EXTENSIONS).concat("text/plain"));

const MAX_ACTIVE_UPLOADS_PER_PERSON = 20;
const PART_URL_TTL_SEC = 15 * 60;
const SCAN_RANGE = 8 * 1024 * 1024;
const HEAD_BYTES = 1024 * 1024;

function ttlMs(): number {
  const h = Number(process.env.DRIVE_UPLOAD_TTL_HOURS);
  return (Number.isFinite(h) && h > 0 ? Math.min(h, 24 * 7) : 24) * 3600_000;
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

export type InitiateResult =
  | { mode: "direct"; maxBytes: number }
  | { mode: "multipart"; uploadId: string; partSize: number; partCount: number; totalBytes: number; expiresAt: string; path: string; directMaxBytes: number };

export interface InitiateArgs {
  actor: UploadActor;
  /** The folder to put the file in (canonical stored path). */
  dir: string;
  filename: string;
  size: number;
  mimeType?: string;
  /** Put the finished upload on top of this file as a new version. */
  replaceFileId?: string;
  /** Ask for a part size (bytes); clamped to 5 MiB .. what keeps it within 10,000 parts. */
  partSize?: number;
}

/** Room left for a new file: the workspace total and the scope the path is charged to. */
async function roomFor(workspaceId: string, info: PathInfo): Promise<number> {
  const q = await prisma.workspaceQuota.findUnique({ where: { workspaceId } });
  const limit = q ? Number(q.limitBytes) : 10 * 1024 ** 3;
  let room = limit - (q ? Number(q.usedBytes) : 0);
  for (const s of quotaScopesFor(info)) {
    const u = await withWorkspaceScope(workspaceId, (tx) => getScopeUsage(tx, workspaceId, s.key));
    const scopeLimit = u.limitBytes ?? (s.kind === "app" ? 1024 ** 3 : Infinity);
    room = Math.min(room, scopeLimit - u.usedBytes);
  }
  return room;
}

export async function initiateUpload(args: InitiateArgs): Promise<InitiateResult> {
  const { actor } = args;
  if (!Number.isSafeInteger(args.size) || args.size < 1) throw new FsError("too_large", "File is empty.");
  const name = sanitizeUploadName(args.filename);
  const dirInfo = await requireDirWrite(actor, args.dir);
  const path = normalizeLogicalPath(`${dirInfo.path}/${name}`);
  if (!path.ok) throw new FsError("invalid_path", path.reason);

  // Hosted deployments refuse up front when there is no scanner: no bytes are taken in vain.
  const policy = scannerPolicy();
  if (policy.required && !policy.configured) throw new FsError("scanner_unavailable", new ScannerNotConfiguredError().message);

  let replace: { id: string } | null = null;
  if (args.replaceFileId) {
    const { file } = await requireFileAction(actor, args.replaceFileId, "version");
    replace = { id: file.id };
    // The new bytes keep the file's name and place.
    if (file.logicalPath !== path.path) throw new FsError("invalid_path", "A new version keeps the file's name; upload under the same name.");
  }

  const adapter = getStorageAdapter();
  if (!supportsMultipart(adapter)) {
    // Local-disk storage keeps the buffered path (single request, 25 MB).
    if (args.size > DEFAULT_MAX_FILE_BYTES) throw new FsError("too_large", "Files over 25 MB need object storage (MARKETR_STORAGE=s3). Ask an admin to set it up.");
    return { mode: "direct", maxBytes: DEFAULT_MAX_FILE_BYTES };
  }

  const room = await roomFor(actor.workspaceId, path);
  const limit = uploadLimitBytes({ hardMax: driveMaxFileBytes(), room });
  if (args.size > driveMaxFileBytes()) throw new FsError("too_large", `Files can be at most ${Math.floor(driveMaxFileBytes() / 1024 / 1024)} MB.`);
  if (args.size > limit) throw new FsError("quota_exceeded", "There isn't enough storage left for this file.");

  if (args.size > DEFAULT_MAX_FILE_BYTES && !LARGE_FILE_EXTENSIONS[extOf(name)]) {
    throw new FsError("unsafe_content", "Above 25 MB only images (PNG, JPEG, GIF, WebP), PDFs and text files (TXT, Markdown, CSV) can be uploaded.");
  }

  const active = await withWorkspaceScope(actor.workspaceId, (tx) =>
    tx.workspaceUpload.count({ where: { workspaceId: actor.workspaceId, createdBy: actor.userId, status: { in: ["initiated", "uploading"] }, expiresAt: { gt: new Date() } } }),
  );
  if (active >= MAX_ACTIVE_UPLOADS_PER_PERSON) throw new FsError("invalid_state", "Too many uploads are in progress. Finish or cancel some first.");

  // A client may ask for smaller parts (flaky networks); never below 5 MiB, never so small the file needs over 10,000 parts.
  const fewestParts = Math.ceil(args.size / MAX_PARTS / (1024 * 1024)) * 1024 * 1024;
  const partSize = args.partSize && Number.isFinite(args.partSize) ? Math.max(MIN_PART_BYTES, fewestParts, Math.floor(args.partSize)) : choosePartSize(args.size);
  const state = newUpload({ totalBytes: args.size, partSize, now: new Date(), ttlMs: ttlMs() });
  const storageKey = randomUUID();
  const mime = (args.mimeType ?? "").trim() || LARGE_FILE_EXTENSIONS[extOf(name)] || "application/octet-stream";
  const providerUploadId = await adapter.createMultipartUpload(storageKey, mime);
  let row;
  try {
    row = await withWorkspaceScope(actor.workspaceId, (tx) =>
      tx.workspaceUpload.create({
        data: {
          workspaceId: actor.workspaceId,
          logicalPath: path.path,
          filename: basenameOf(path.path).slice(0, 255),
          mimeType: mime,
          totalBytes: BigInt(args.size),
          partSize,
          partCount: state.partCount,
          status: "initiated",
          parts: {},
          storageKey,
          providerUploadId,
          replaceFileId: replace?.id ?? null,
          createdBy: actor.userId,
          expiresAt: state.expiresAt,
        },
      }),
    );
  } catch (err) {
    await adapter.abortMultipartUpload(storageKey, providerUploadId).catch(() => {});
    throw err;
  }
  return { mode: "multipart", uploadId: row.id, partSize, partCount: state.partCount, totalBytes: args.size, expiresAt: state.expiresAt.toISOString(), path: path.path, directMaxBytes: 8 * 1024 * 1024 };
}

type UploadRow = NonNullable<Awaited<ReturnType<typeof loadRow>>>;

async function loadRow(actor: UploadActor, uploadId: string) {
  const row = await withWorkspaceScope(actor.workspaceId, (tx) => tx.workspaceUpload.findFirst({ where: { id: uploadId, workspaceId: actor.workspaceId } }));
  // Someone else's half-finished upload does not exist as far as you can tell.
  if (!row || row.createdBy !== actor.userId) throw new NotFoundError("Upload not found.");
  return row;
}

function stateOf(row: UploadRow): UploadState {
  const parts: UploadState["parts"] = {};
  for (const [n, v] of Object.entries((row.parts ?? {}) as Record<string, { etag: string; size: number }>)) parts[Number(n)] = v;
  return { status: row.status as UploadStatus, totalBytes: Number(row.totalBytes), partSize: row.partSize, partCount: row.partCount, parts, expiresAt: row.expiresAt };
}

async function save(workspaceId: string, id: string, state: UploadState, extra: { completedFileId?: string } = {}) {
  await withWorkspaceScope(workspaceId, (tx) =>
    tx.workspaceUpload.update({ where: { id, workspaceId }, data: { status: state.status, parts: state.parts as never, ...extra } }),
  );
}

function adapterOf(): StorageAdapter & MultipartStorage {
  const a = getStorageAdapter();
  if (!supportsMultipart(a)) throw new FsError("invalid_state", "Large uploads need object storage.");
  return a;
}

function assertOpen(row: UploadRow): void {
  if (row.status === "aborted") throw new FsError("invalid_state", "This upload was cancelled.");
  if (row.status === "completed") throw new FsError("invalid_state", "This upload is already complete.");
  if (row.status === "expired" || row.expiresAt.getTime() < Date.now()) throw new FsError("invalid_state", "This upload expired. Start it again.");
}

export interface UploadStatusView {
  uploadId: string;
  status: UploadStatus;
  partSize: number;
  partCount: number;
  totalBytes: number;
  /** Parts the storage provider holds with the right size. */
  uploaded: number[];
  /** Parts still to send (or to send again: wrong size). */
  missing: number[];
  expiresAt: string;
}

/** Ask the provider which parts it holds and fold them into the state (resume). Does not write. */
async function syncParts(row: UploadRow): Promise<UploadState> {
  const state = stateOf(row);
  const held = await adapterOf().listParts(row.storageKey, row.providerUploadId!);
  const next: UploadState = { ...state, parts: {} };
  let cur = next;
  for (const p of held) {
    if (p.partNumber < 1 || p.partNumber > row.partCount) continue;
    if (p.size !== expectedPartSize(state, p.partNumber)) continue; // wrong size: treated as missing, will be re-sent
    cur = recordPart(cur, p.partNumber, { etag: p.etag, size: p.size });
  }
  return held.length ? cur : { ...next, status: state.status };
}

export async function uploadStatus(actor: UploadActor, uploadId: string): Promise<UploadStatusView> {
  const row = await loadRow(actor, uploadId);
  assertOpen(row);
  if (row.status === "completing") throw new FsError("invalid_state", "This upload is being completed.");
  const state = await syncParts(row);
  await save(actor.workspaceId, row.id, state);
  const uploaded = Object.keys(state.parts).map(Number).sort((a, b) => a - b);
  const missing = Array.from({ length: row.partCount }, (_, i) => i + 1).filter((n) => !state.parts[n]);
  return { uploadId: row.id, status: state.status, partSize: row.partSize, partCount: row.partCount, totalBytes: Number(row.totalBytes), uploaded, missing, expiresAt: row.expiresAt.toISOString() };
}

export interface PartUrl {
  partNumber: number;
  url: string;
  /** The exact number of bytes this part must carry. */
  size: number;
  expiresInSec: number;
}

export async function presignParts(actor: UploadActor, uploadId: string, partNumbers: number[]): Promise<PartUrl[]> {
  const row = await loadRow(actor, uploadId);
  assertOpen(row);
  if (partNumbers.length === 0 || partNumbers.length > 50) throw new FsError("invalid_path", "Ask for 1 to 50 parts at a time.");
  const adapter = adapterOf();
  const state = stateOf(row);
  const out: PartUrl[] = [];
  for (const n of partNumbers) {
    if (!Number.isInteger(n) || n < 1 || n > row.partCount) throw new FsError("invalid_path", `Part number must be 1 to ${row.partCount}.`);
    out.push({ partNumber: n, url: await adapter.presignUploadPart(row.storageKey, row.providerUploadId!, n, PART_URL_TTL_SEC), size: expectedPartSize(state, n), expiresInSec: PART_URL_TTL_SEC });
  }
  return out;
}

export async function abortMultipartUploadFor(actor: UploadActor, uploadId: string): Promise<void> {
  const row = await loadRow(actor, uploadId);
  if (row.status === "completed") throw new FsError("invalid_state", "This upload is already complete.");
  if (row.status !== "aborted") {
    await adapterOf().abortMultipartUpload(row.storageKey, row.providerUploadId!).catch(() => {});
    await save(actor.workspaceId, row.id, abortState(stateOf(row)));
  }
}

/** Stream an object through the malware scanner in ranges (never whole in memory). */
async function* rangesOf(adapter: StorageAdapter, key: string, size: number): AsyncGenerator<Buffer> {
  for (let start = 0; start < size; start += SCAN_RANGE) {
    const chunk = await adapter.getRange(key, start, Math.min(start + SCAN_RANGE, size) - 1);
    if (!chunk) throw new Error("The uploaded file could not be read back for scanning.");
    yield chunk;
  }
}

async function validateAssembled(adapter: StorageAdapter, row: UploadRow, size: number): Promise<{ mime: string }> {
  const filename = row.filename;
  if (size <= DEFAULT_MAX_FILE_BYTES) {
    const bytes = await adapter.get(row.storageKey);
    if (!bytes || bytes.length !== size) throw new FsError("invalid_state", "The uploaded file could not be read back.");
    const check = validateUploadBuffer(bytes, { filename, maxBytes: DEFAULT_MAX_FILE_BYTES, category: "default" });
    if (!check.ok) throw new FsError("unsafe_content", check.reason);
    const scan = await getMalwareScanner().scanBuffer(bytes);
    if (!scan.clean) throw new FsError("unsafe_content", `This file failed the malware scan${scan.signature ? ` (${scan.signature})` : ""} and was rejected.`);
    return { mime: check.mime };
  }
  if (!LARGE_FILE_EXTENSIONS[extOf(filename)]) throw new FsError("unsafe_content", "Above 25 MB only images, PDFs and text files can be uploaded.");
  const head = await adapter.getRange(row.storageKey, 0, Math.min(HEAD_BYTES, size) - 1);
  if (!head) throw new FsError("invalid_state", "The uploaded file could not be read back.");
  const check = validateUploadBuffer(head, { filename, maxBytes: head.length, category: "default" });
  if (!check.ok) throw new FsError("unsafe_content", check.reason);
  if (!LARGE_MIMES.has(check.mime)) throw new FsError("unsafe_content", "Above 25 MB only images, PDFs and text files can be uploaded.");
  const scan = await getMalwareScanner().scanStream(rangesOf(adapter, row.storageKey, size));
  if (!scan.clean) throw new FsError("unsafe_content", `This file failed the malware scan${scan.signature ? ` (${scan.signature})` : ""} and was rejected.`);
  return { mime: check.mime };
}

export interface CompleteResult {
  fileId: string;
  path: string;
  version: number;
  sizeBytes: number;
  replaced: boolean;
}

export async function completeMultipartUploadFor(actor: UploadActor, uploadId: string): Promise<CompleteResult> {
  const row = await loadRow(actor, uploadId);
  assertOpen(row);
  const adapter = adapterOf();
  // Claim the upload so two "complete" calls cannot both assemble it.
  const claimed = await withWorkspaceScope(actor.workspaceId, (tx) =>
    tx.workspaceUpload.updateMany({ where: { id: row.id, workspaceId: actor.workspaceId, status: { in: ["initiated", "uploading"] } }, data: { status: "completing" } }),
  );
  if (claimed.count !== 1) throw new FsError("invalid_state", "This upload is already being completed.");
  const reopen = async (status: UploadStatus) => save(actor.workspaceId, row.id, { ...stateOf(row), status });
  let fresh: UploadState;
  try {
    fresh = await syncParts({ ...row, status: "uploading" } as UploadRow);
  } catch (err) {
    await reopen("uploading");
    throw err;
  }
  let assembled;
  try {
    assembled = completeState({ ...fresh, status: "uploading" });
  } catch (err) {
    await reopen("uploading");
    throw new FsError("invalid_state", err instanceof Error ? err.message : "Some parts are missing.");
  }
  const total = Number(row.totalBytes);
  const reject = async (err: FsError) => {
    await adapter.delete(row.storageKey).catch(() => {});
    await adapter.abortMultipartUpload(row.storageKey, row.providerUploadId!).catch(() => {});
    await save(actor.workspaceId, row.id, { ...fresh, status: "aborted" });
    await auditEvent({ workspaceId: actor.workspaceId, projectId: null, action: "file_rejected", summary: `Upload of "${row.filename}" rejected: ${err.message}`, actorUserId: actor.userId }).catch(() => {});
    return err;
  };
  try {
    await adapter.completeMultipartUpload(row.storageKey, row.providerUploadId!, assembled.parts);
  } catch (err) {
    await reopen("uploading");
    throw new FsError("invalid_state", `The storage provider could not assemble the file: ${err instanceof Error ? err.message : "error"}`);
  }
  const size = await adapter.size(row.storageKey);
  if (size !== total) throw await reject(new FsError("invalid_state", "The assembled file is not the size that was announced."));
  let mime: string;
  try {
    mime = (await validateAssembled(adapter, row, size)).mime;
  } catch (err) {
    if (err instanceof FsError) throw await reject(err);
    if (err instanceof ScannerNotConfiguredError) throw await reject(new FsError("scanner_unavailable", err.message));
    throw await reject(new FsError("scanner_unavailable", "The malware scanner is unavailable, so the upload was rejected. Please try again shortly."));
  }

  const info = normalizeLogicalPath(row.logicalPath);
  if (!info.ok) throw await reject(new FsError("invalid_path", info.reason));
  try {
    if (row.replaceFileId) {
      const res = await overwriteFromStoredBlob({ workspaceId: actor.workspaceId, fileId: row.replaceFileId, userId: actor.userId, storageKey: row.storageKey, sizeBytes: size, mime });
      await save(actor.workspaceId, row.id, { ...fresh, status: "completed" }, { completedFileId: row.replaceFileId });
      return { fileId: row.replaceFileId, path: row.logicalPath, version: res.version, sizeBytes: size, replaced: true };
    }
    const file = await registerStoredFile({ workspaceId: actor.workspaceId, pathCheck: info, storageKey: row.storageKey, sizeBytes: size, mime, kind: info.kind, createdBy: actor.userId });
    await save(actor.workspaceId, row.id, { ...fresh, status: "completed" }, { completedFileId: file.id });
    await auditEvent({ workspaceId: actor.workspaceId, projectId: null, action: "file_attached", summary: `Stored file "${file.filename}" at ${file.logicalPath} (${size} bytes, multipart)`, actorUserId: actor.userId }).catch(() => {});
    if (size <= DEFAULT_MAX_FILE_BYTES) scheduleFileTextIndex(actor.workspaceId, file.id);
    return { fileId: file.id, path: file.logicalPath, version: 1, sizeBytes: size, replaced: false };
  } catch (err) {
    await adapter.delete(row.storageKey).catch(() => {});
    await save(actor.workspaceId, row.id, { ...fresh, status: "aborted" });
    throw err;
  }
}

/** Mark overdue uploads expired and drop them at the provider (a workspace's, for a scheduled sweep). */
export async function expireUploadsFor(workspaceId: string, now = new Date()): Promise<{ expired: number }> {
  const stale = await withWorkspaceScope(workspaceId, (tx) =>
    tx.workspaceUpload.findMany({ where: { workspaceId, status: { in: ["initiated", "uploading"] }, expiresAt: { lt: now } }, take: 200 }),
  );
  const adapter = getStorageAdapter();
  for (const u of stale) {
    if (supportsMultipart(adapter) && u.providerUploadId) await adapter.abortMultipartUpload(u.storageKey, u.providerUploadId).catch(() => {});
    await withWorkspaceScope(workspaceId, (tx) => tx.workspaceUpload.update({ where: { id: u.id, workspaceId }, data: { status: "expired" } }));
  }
  return { expired: stale.length };
}

export { dirnameOf, MAX_PARTS };
