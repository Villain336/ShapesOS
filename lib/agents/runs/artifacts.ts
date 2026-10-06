// Marketr — Phase 16 slice 6: workspace-scoped recording artifact resolution.
//
// The artifact-serving API route streams bytes ONLY through
// resolveRecordingAsset() + readRecordingBytes(). The viewer page never sees
// a storage location. Every access is re-checked against the run's
// workspace via the slice-5 service (getAgentRun → RLS fail-closed), so a
// foreign runId resolves to null and the route answers 404.
//
// Deploy PR (WS=state): recordings live in the shared blob store
// (namespace "run-recordings", key <workspaceId>/<runId>/<file>) so the web
// replica serving the viewer can read what the worker recorded. The recorder
// still writes to a scratch directory (Playwright needs local files);
// publishRecordingArtifacts() uploads video, trace and screenshots when the
// recording stops and removes the scratch directory. Rows written before the
// deploy PR hold a filesystem path (absolute, or relative to the artifact
// root): those are still served while the file exists on this disk, and a
// path that escapes the artifact root is rejected (fail-closed).

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  blobDelete,
  blobGet,
  blobHead,
  blobPath,
  blobPut,
  encodeBlobSegment,
  parseBlobRef,
  isBlobRef,
} from "@/lib/filesystem/storage";
import { ARTIFACT_ROOT } from "./recorder";
import { getAgentRun } from "./service";

export const RECORDING_ASSETS = ["video", "trace"] as const;
export type RecordingAsset = (typeof RECORDING_ASSETS)[number];

export const RECORDING_NAMESPACE = "run-recordings" as const;

export interface ResolvedRecordingAsset {
  location: RecordingLocation;
  contentType: string;
  filename: string;
  sizeBytes: number;
}

export type RecordingLocation = { kind: "blob"; path: string } | { kind: "legacy"; absPath: string };

export function isRecordingAsset(value: string): value is RecordingAsset {
  return (RECORDING_ASSETS as readonly string[]).includes(value);
}

/** Blob path of one recording file: <workspaceId>/<runId>/<file>. */
export function recordingBlobPath(workspaceId: string, runId: string, file: string): string {
  return blobPath(encodeBlobSegment(workspaceId), encodeBlobSegment(runId), encodeBlobSegment(file));
}

/**
 * Resolve a stored artifact path inside the artifact root. Returns null
 * (fail-closed) when the stored path escapes the root.
 */
export function resolveRecordingPath(storedPath: string, artifactRoot: string): string | null {
  const root = path.resolve(artifactRoot);
  const abs = path.isAbsolute(storedPath) ? path.resolve(storedPath) : path.resolve(root, storedPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/**
 * Locate what a recording row stores. A blob ref must be in the recordings
 * namespace AND under this workspace's prefix; a legacy path must stay
 * inside the artifact root. Anything else is null (fail-closed).
 */
export function locateRecording(
  stored: string | null | undefined,
  workspaceId: string,
  artifactRoot: string = ARTIFACT_ROOT,
): RecordingLocation | null {
  if (!stored) return null;
  if (isBlobRef(stored)) {
    const ref = parseBlobRef(stored);
    if (!ref || ref.namespace !== RECORDING_NAMESPACE) return null;
    if (!ref.path.startsWith(`${encodeBlobSegment(workspaceId)}/`)) return null;
    return { kind: "blob", path: ref.path };
  }
  const absPath = resolveRecordingPath(stored, artifactRoot);
  if (!absPath || absPath === path.resolve(artifactRoot)) return null;
  return { kind: "legacy", absPath };
}

/** Size of a located recording file; null when it is gone. */
export async function recordingSize(loc: RecordingLocation): Promise<number | null> {
  if (loc.kind === "blob") return (await blobHead(RECORDING_NAMESPACE, loc.path))?.size ?? null;
  const st = await fs.stat(loc.absPath).catch(() => null);
  return st && st.isFile() ? st.size : null;
}

/** Bytes of a located recording file (inclusive range optional). */
export async function readRecordingBytes(loc: RecordingLocation, range?: { start: number; end: number }): Promise<Buffer | null> {
  if (loc.kind === "blob") return blobGet(RECORDING_NAMESPACE, loc.path, range);
  try {
    if (!range) return await fs.readFile(loc.absPath);
    const fh = await fs.open(loc.absPath, "r");
    try {
      const buf = Buffer.alloc(range.end - range.start + 1);
      const { bytesRead } = await fh.read(buf, 0, buf.length, range.start);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/** Delete a located recording file. Missing is not an error. */
export async function deleteRecordingFile(loc: RecordingLocation): Promise<void> {
  if (loc.kind === "blob") return blobDelete(RECORDING_NAMESPACE, loc.path);
  try {
    await fs.unlink(loc.absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}

/**
 * Resolve a recording artifact for streaming. Returns null (route → 404)
 * when: the run is not visible in this workspace, there is no recording,
 * the requested asset is missing, the file is gone from storage, or the
 * stored location escapes its root (fail-closed on all five).
 */
export async function resolveRecordingAsset(
  workspaceId: string,
  runId: string,
  asset: RecordingAsset,
): Promise<ResolvedRecordingAsset | null> {
  const run = await getAgentRun(workspaceId, runId);
  if (!run?.recording) return null;

  const stored = asset === "video" ? run.recording.videoPath : run.recording.tracePath;
  const location = locateRecording(stored, workspaceId);
  if (!location) return null;
  const sizeBytes = await recordingSize(location);
  if (sizeBytes === null) return null;

  return {
    location,
    contentType: asset === "video" ? "video/webm" : "application/zip",
    filename: asset === "video" ? `run-${runId}.webm` : `trace-${runId}.zip`,
    sizeBytes,
  };
}

export interface PublishedRecording {
  /** Blob refs to store on the recording row (null = absent or not uploaded). */
  videoRef: string | null;
  traceRef: string | null;
  screenshots: string[];
  /** Bytes uploaded (video + trace), the row's sizeBytes. */
  sizeBytes: number;
  /** Upload failures (the scratch directory is then kept for an operator). */
  errors: string[];
}

/**
 * Upload a stopped recording (scratch directory → shared blob store) and
 * remove the scratch directory once everything is stored. Never throws: a
 * failed upload is reported in `errors` and that asset's ref stays null.
 */
export async function publishRecordingArtifacts(input: {
  workspaceId: string;
  runId: string;
  artifactDir: string;
  videoPath: string | null;
  tracePath: string | null;
}): Promise<PublishedRecording> {
  const out: PublishedRecording = { videoRef: null, traceRef: null, screenshots: [], sizeBytes: 0, errors: [] };
  const upload = async (abs: string, file: string, mime: string): Promise<string | null> => {
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(abs);
    } catch {
      return null; // never produced (no video on this browser build, failed start)
    }
    try {
      const ref = await blobPut(RECORDING_NAMESPACE, recordingBlobPath(input.workspaceId, input.runId, file), bytes, mime);
      if (file === "video.webm" || file === "trace.zip") out.sizeBytes += bytes.length;
      return ref;
    } catch (err) {
      out.errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };
  if (input.videoPath) out.videoRef = await upload(input.videoPath, "video.webm", "video/webm");
  if (input.tracePath) out.traceRef = await upload(input.tracePath, "trace.zip", "application/zip");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(input.artifactDir);
  } catch {
    entries = [];
  }
  for (const name of entries.filter((e) => /^step-[A-Za-z0-9_-]+\.png$/.test(e)).sort()) {
    const ref = await upload(path.join(input.artifactDir, name), name, "image/png");
    if (ref) out.screenshots.push(ref);
  }
  if (out.errors.length === 0) {
    await fs.rm(input.artifactDir, { recursive: true, force: true }).catch(() => undefined);
  } else {
    console.warn(
      `[recording] upload failed for run ${input.runId}; scratch files kept at ${input.artifactDir}: ${out.errors.join("; ")}`,
    );
  }
  return out;
}
