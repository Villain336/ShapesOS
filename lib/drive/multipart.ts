// ShapesOS — Phase 21B (WS=drive): the multipart upload state machine (PURE).
//
//   initiated ──recordPart──▶ uploading ──completeUpload──▶ completing ──▶ completed
//       │                         │                              │
//       └────── abortUpload / expire (terminal: aborted / expired) ┘
//
// The state is persisted in workspace_uploads (service side). A part can be
// re-sent any number of times (resumable: a dropped connection re-PUTs that
// part; the newest etag wins). Every part but the last is exactly `partSize`;
// the last is exactly the remainder, so the server can verify the total
// without trusting the client. S3 limits: parts 5 MiB..5 GiB (the last may be
// smaller), at most 10,000 parts.

const MiB = 1024 * 1024;
export const MIN_PART_BYTES = 5 * MiB;
export const DEFAULT_PART_BYTES = 16 * MiB;
export const MAX_PARTS = 10_000;

export type UploadStatus = "initiated" | "uploading" | "completing" | "completed" | "aborted" | "expired";

export interface UploadState {
  status: UploadStatus;
  totalBytes: number;
  partSize: number;
  partCount: number;
  parts: Record<number, { etag: string; size: number }>;
  expiresAt: Date;
}

/** 16 MiB parts, grown (whole MiB) so a huge file stays within 10,000 parts. */
export function choosePartSize(totalBytes: number): number {
  let size = DEFAULT_PART_BYTES;
  if (Math.ceil(totalBytes / size) > MAX_PARTS) size = Math.ceil(totalBytes / MAX_PARTS / MiB) * MiB;
  return Math.max(size, MIN_PART_BYTES);
}

export function newUpload(input: { totalBytes: number; partSize: number; now: Date; ttlMs: number }): UploadState {
  if (!Number.isSafeInteger(input.totalBytes) || input.totalBytes < 1) throw new Error("An upload needs at least one byte.");
  if (input.partSize < MIN_PART_BYTES && input.totalBytes > input.partSize) throw new Error("Parts must be at least 5 MiB.");
  const partCount = Math.ceil(input.totalBytes / input.partSize);
  if (partCount > MAX_PARTS) throw new Error(`An upload can have at most ${MAX_PARTS} parts.`);
  return { status: "initiated", totalBytes: input.totalBytes, partSize: input.partSize, partCount, parts: {}, expiresAt: new Date(input.now.getTime() + input.ttlMs) };
}

/** The exact byte size part `n` must have. */
export function expectedPartSize(u: Pick<UploadState, "totalBytes" | "partSize" | "partCount">, n: number): number {
  return n < u.partCount ? u.partSize : u.totalBytes - u.partSize * (u.partCount - 1);
}

function live(u: UploadState): void {
  if (u.status === "aborted") throw new Error("This upload was aborted.");
  if (u.status === "expired") throw new Error("This upload expired.");
  if (u.status === "completed") throw new Error("This upload is already complete.");
  if (u.status === "completing") throw new Error("This upload is already being completed.");
}

export function recordPart(u: UploadState, partNumber: number, part: { etag: string; size: number }): UploadState {
  live(u);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > u.partCount) throw new Error(`Part number must be 1 to ${u.partCount}.`);
  const want = expectedPartSize(u, partNumber);
  if (part.size !== want) throw new Error(`Part ${partNumber} has the wrong size (expected ${want} bytes, got ${part.size}).`);
  return { ...u, status: "uploading", parts: { ...u.parts, [partNumber]: { etag: part.etag, size: part.size } } };
}

export function completeUpload(u: UploadState): { state: UploadState; parts: Array<{ partNumber: number; etag: string }> } {
  live(u);
  const parts: Array<{ partNumber: number; etag: string }> = [];
  for (let n = 1; n <= u.partCount; n++) {
    const p = u.parts[n];
    if (!p) throw new Error(`Missing part ${n} of ${u.partCount}.`);
    parts.push({ partNumber: n, etag: p.etag });
  }
  return { state: { ...u, status: "completing" }, parts };
}

export function abortUpload(u: UploadState): UploadState {
  if (u.status === "completed") throw new Error("This upload is already complete.");
  return { ...u, status: "aborted" };
}

/** Mark an unfinished upload expired once its time is up. */
export function expire(u: UploadState, now: Date): UploadState {
  if (u.status === "completed" || u.status === "aborted" || u.status === "expired") return u;
  return now.getTime() > u.expiresAt.getTime() ? { ...u, status: "expired" } : u;
}
