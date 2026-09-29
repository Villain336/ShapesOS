// Marketr — Phase 16 slice 6: workspace-scoped recording artifact resolution.
//
// The artifact-serving API route streams bytes ONLY through
// resolveRecordingAsset(). The viewer page never sees a filesystem path.
// Every access is re-checked against the run's workspace via the slice-5
// service (getAgentRun → RLS fail-closed), so a foreign runId resolves to
// null and the route answers 404. Stored paths are pinned inside
// ARTIFACT_ROOT — anything that escapes is rejected.

import { promises as fs } from "node:fs";
import path from "node:path";
import { ARTIFACT_ROOT } from "./recorder";
import { getAgentRun } from "./service";

export const RECORDING_ASSETS = ["video", "trace"] as const;
export type RecordingAsset = (typeof RECORDING_ASSETS)[number];

export interface ResolvedRecordingAsset {
  absPath: string;
  contentType: string;
  filename: string;
  sizeBytes: number;
}

export function isRecordingAsset(value: string): value is RecordingAsset {
  return (RECORDING_ASSETS as readonly string[]).includes(value);
}

/**
 * Resolve a recording artifact for streaming. Returns null (route → 404)
 * when: the run is not visible in this workspace, there is no recording,
 * the requested asset is missing, the file is gone from disk, or the
 * stored path escapes the artifact root (fail-closed on all five).
 */
export async function resolveRecordingAsset(
  workspaceId: string,
  runId: string,
  asset: RecordingAsset,
): Promise<ResolvedRecordingAsset | null> {
  const run = await getAgentRun(workspaceId, runId);
  if (!run?.recording) return null;

  const stored = asset === "video" ? run.recording.videoPath : run.recording.tracePath;
  if (!stored) return null;

  const root = path.resolve(ARTIFACT_ROOT);
  const absPath = path.isAbsolute(stored) ? path.resolve(stored) : path.resolve(root, stored);
  if (absPath !== root && !absPath.startsWith(root + path.sep)) return null;

  const stat = await fs.stat(absPath).catch(() => null);
  if (!stat || !stat.isFile()) return null;

  return {
    absPath,
    contentType: asset === "video" ? "video/webm" : "application/zip",
    filename: asset === "video" ? `run-${runId}.webm` : `trace-${runId}.zip`,
    sizeBytes: stat.size,
  };
}
