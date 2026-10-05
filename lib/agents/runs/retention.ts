// Marketr — Phase 16 slice 8: recording retention sweep + storage accounting.
//
// Locked decision (c): "30 days, then summarize — traces kept, videos dropped
// after 30 days unless pinned."
//
// Sweep semantics (exact):
//   - SELECTs recordings with retentionUntil < now AND pinned = false AND
//     videoPath IS NOT NULL (workspace-scoped; FORCE RLS fail-closed, so a
//     caller that forgets the scope sees zero rows).
//   - Deletes the VIDEO file only. The trace (trace.zip) is NEVER touched.
//   - Pinned recordings are NEVER touched. Not-yet-expired recordings are
//     NEVER touched.
//   - A video file that is already missing from disk is tolerated (reclaimed
//     0 bytes); the row is still marked purged so the state stays honest.
//   - A stored videoPath that escapes the artifact root is FAIL-CLOSED:
//     the row is skipped, the file is not deleted, and the skip is reported.
//   - On purge the row is marked: videoPath = null, videoPurgedAt = now, and
//     sizeBytes is reduced by the ACTUAL bytes stat'ed off disk (floored at
//     0), so accounting keeps matching disk truth.
//   - What was reclaimed is logged per row and totaled in the report.
//
// Scheduling: POST /api/cron/recording-retention (host cron + CRON_SECRET,
// daily; a signed-in editor can also trigger it for their own workspace).

import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { ARTIFACT_ROOT } from "./recorder";

export interface SweepRowResult {
  runId: string;
  workspaceId: string;
  /** Bytes actually reclaimed (0 when the file was already gone). */
  reclaimedBytes: number;
  videoMissing: boolean;
}

export interface SweepSkip {
  runId: string;
  workspaceId: string;
  reason: string;
}

export interface SweepReport {
  ok: boolean;
  at: string;
  scanned: number;
  swept: SweepRowResult[];
  skipped: SweepSkip[];
  totalReclaimedBytes: number;
  workspaces: string[];
}

export interface RecordingStorage {
  workspaceId: string;
  /** Sum of recorded sizeBytes across the workspace's recordings. */
  totalBytes: number;
  /** Video bytes actually present on disk. */
  videoBytes: number;
  /** Trace bytes actually present on disk. */
  traceBytes: number;
  count: number;
  pinnedCount: number;
  purgedVideoCount: number;
  missingFileCount: number;
}

export interface SweepOptions {
  /** Restrict the sweep to one workspace (session-triggered runs). */
  workspaceId?: string;
  /** Clock override (tests). */
  now?: Date;
  /** Artifact root override (tests). Defaults to .run-artifacts/. */
  artifactRoot?: string;
}

/** Pure sweep predicate — unit-testable without a DB. */
export function isSweepCandidate(
  rec: { retentionUntil: Date; pinned: boolean; videoPath: string | null },
  now: Date,
): boolean {
  return !rec.pinned && rec.videoPath != null && rec.videoPath !== "" && rec.retentionUntil < now;
}

/**
 * Resolve a stored artifact path inside the artifact root. Returns null
 * (fail-closed) when the stored path escapes the root.
 */
export function resolveRecordingPath(storedPath: string, artifactRoot: string): string | null {
  const root = path.resolve(artifactRoot);
  const abs = path.isAbsolute(storedPath)
    ? path.resolve(storedPath)
    : path.resolve(root, storedPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

async function statBytes(absPath: string): Promise<number | null> {
  try {
    const st = await fs.stat(absPath);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/**
 * Sweep expired, unpinned recordings: drop videos, keep traces.
 * See the file header for the exact semantics.
 */
export async function sweepExpiredRecordings(opts?: SweepOptions): Promise<SweepReport> {
  const now = opts?.now ?? new Date();
  const artifactRoot = opts?.artifactRoot ?? ARTIFACT_ROOT;
  const workspaces = opts?.workspaceId
    ? [{ id: opts.workspaceId }]
    : await prisma.workspace.findMany({ select: { id: true } });

  const report: SweepReport = {
    ok: true,
    at: now.toISOString(),
    scanned: 0,
    swept: [],
    skipped: [],
    totalReclaimedBytes: 0,
    workspaces: workspaces.map((w) => w.id),
  };

  for (const ws of workspaces) {
    await withWorkspaceScope(ws.id, async (tx) => {
      const candidates = await tx.agentRunRecording.findMany({
        where: {
          workspaceId: ws.id,
          retentionUntil: { lt: now },
          pinned: false,
          videoPath: { not: null },
        },
        select: { id: true, runId: true, workspaceId: true, videoPath: true, sizeBytes: true },
      });
      report.scanned += candidates.length;

      for (const c of candidates) {
        if (!isSweepCandidate({ retentionUntil: new Date(0), pinned: false, videoPath: c.videoPath }, now)) {
          // Defensive: the DB predicate above already enforces this; skip
          // rather than risk a bad delete.
          report.skipped.push({
            runId: c.runId,
            workspaceId: c.workspaceId,
            reason: "candidate predicate failed on re-check",
          });
          continue;
        }

        const abs = resolveRecordingPath(c.videoPath!, artifactRoot);
        if (!abs) {
          report.skipped.push({
            runId: c.runId,
            workspaceId: c.workspaceId,
            reason: "videoPath escapes artifact root (fail-closed)",
          });
          continue;
        }

        const before = await statBytes(abs);
        if (before !== null) {
          try {
            await fs.unlink(abs);
          } catch (err) {
            report.skipped.push({
              runId: c.runId,
              workspaceId: c.workspaceId,
              reason: `video delete failed: ${err instanceof Error ? err.message : String(err)}`,
            });
            continue;
          }
        }
        const reclaimed = before ?? 0;
        const recorded = Number(c.sizeBytes);
        const newSize = Math.max(0, (Number.isFinite(recorded) ? recorded : 0) - reclaimed);

        await tx.agentRunRecording.update({
          where: { id: c.id, workspaceId: c.workspaceId },
          data: { videoPath: null, videoPurgedAt: now, sizeBytes: newSize },
        });

        report.swept.push({
          runId: c.runId,
          workspaceId: c.workspaceId,
          reclaimedBytes: reclaimed,
          videoMissing: before === null,
        });
        report.totalReclaimedBytes += reclaimed;
        console.info(
          `[recording-retention] purged video run=${c.runId} ws=${c.workspaceId} ` +
            `reclaimed=${reclaimed}B${before === null ? " (file already missing)" : ""}`,
        );
      }
    });
  }

  console.info(
    `[recording-retention] done at=${report.at} workspaces=${report.workspaces.length} ` +
      `scanned=${report.scanned} swept=${report.swept.length} skipped=${report.skipped.length} ` +
      `reclaimed=${report.totalReclaimedBytes}B`,
  );
  return report;
}

/** Pin or unpin a recording (workspace-scoped; pinned videos survive the sweep). */
export async function setRecordingPinned(workspaceId: string, runId: string, pinned: boolean) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.agentRunRecording.update({
      where: { runId, workspaceId },
      data: { pinned },
    }),
  );
}

/** Per-workspace storage rollup for agent run recordings (admin/ops surface). */
export async function getRecordingStorage(
  workspaceId: string,
  artifactRoot?: string,
): Promise<RecordingStorage> {
  const root = artifactRoot ?? ARTIFACT_ROOT;
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.agentRunRecording.findMany({
      where: { workspaceId },
      select: {
        videoPath: true,
        tracePath: true,
        pinned: true,
        videoPurgedAt: true,
        sizeBytes: true,
      },
    }),
  );

  let videoBytes = 0;
  let traceBytes = 0;
  let pinnedCount = 0;
  let purgedVideoCount = 0;
  let missingFileCount = 0;

  for (const r of rows) {
    if (r.pinned) pinnedCount += 1;
    if (r.videoPurgedAt) purgedVideoCount += 1;
    for (const [stored, kind] of [
      [r.videoPath, "video"],
      [r.tracePath, "trace"],
    ] as const) {
      if (!stored) continue;
      const abs = resolveRecordingPath(stored, root);
      const size = abs ? await statBytes(abs) : null;
      if (size === null) {
        missingFileCount += 1;
      } else if (kind === "video") {
        videoBytes += size;
      } else {
        traceBytes += size;
      }
    }
  }

  const totalBytes = rows.reduce((sum, r) => {
    const n = Number(r.sizeBytes);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);

  return {
    workspaceId,
    totalBytes,
    videoBytes,
    traceBytes,
    count: rows.length,
    pinnedCount,
    purgedVideoCount,
    missingFileCount,
  };
}
