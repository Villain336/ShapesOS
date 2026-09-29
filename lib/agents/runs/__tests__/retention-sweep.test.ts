// Marketr — Phase 16 slice 8 tests: retention sweep + storage accounting.
// Run: DATABASE_URL=postgresql://postgres@localhost:5434/marketr_16s8_test
//        npx tsx --test lib/agents/runs/__tests__/retention-sweep.test.ts
// Requires all repo migrations applied to the DB (incl. the slice-8
// 20260929124000_phase16_recording_retention migration).
//
// Two layers:
//   A. Pure (no DB): isSweepCandidate + resolveRecordingPath fail-closed math.
//   B. Scratch DB (marketr_16s8_test on :5434): sweep semantics — expired +
//      unpinned videos deleted, traces kept, pinned untouched, not-expired
//      untouched, missing file tolerated, escaping path fail-closed,
//      workspace scoping, idempotency; storage rollup math; pin round-trip.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import {
  isSweepCandidate,
  resolveRecordingPath,
  sweepExpiredRecordings,
  getRecordingStorage,
  setRecordingPinned,
} from "../retention";
import { createAgentRun, attachAgentRunRecording } from "../service";

const WS_A = "16s8-ws-a";
const WS_B = "16s8-ws-b";
const NOW = new Date("2026-09-29T12:00:00Z");
const EXPIRED = new Date("2026-09-20T12:00:00Z"); // retentionUntil < NOW
const FRESH = new Date("2026-10-29T12:00:00Z"); // retentionUntil > NOW

let ART: string;
const testWorkspaces: string[] = [];
let wsN = 0;

/** Fresh workspace per test — sweep state never leaks between tests. */
async function freshWorkspace(): Promise<string> {
  wsN += 1;
  const id = `16s8-t${wsN}`;
  testWorkspaces.push(id);
  await prisma.workspace.deleteMany({ where: { id } });
  await prisma.workspace.create({
    data: { id, name: `16s8 ${id}`, ownerUserId: "16s8-owner" },
  });
  return id;
}

async function writeFile(p: string, bytes: number): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, Buffer.alloc(bytes, 0x61));
}

async function exists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

interface SeedOpts {
  workspaceId: string;
  videoBytes: number | null; // null = no video file, videoPath null
  traceBytes: number | null; // null = no trace file, tracePath null
  retentionUntil: Date;
  escapePath?: boolean; // store a videoPath that escapes the artifact root
}

let seedN = 0;

/** Workspace-scoped recording read (FORCE RLS hides unscoped reads). */
function getRecording(workspaceId: string, runId: string) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.agentRunRecording.findUniqueOrThrow({ where: { runId } }),
  );
}

/** Seed a run + recording row with real files in the temp artifact dir. */
async function seedRecording(opts: SeedOpts): Promise<{ runId: string }> {
  seedN += 1;
  const run = await createAgentRun({
    workspaceId: opts.workspaceId,
    kind: "browser",
    startedBy: "agent:test",
  });
  const dir = path.join(ART, run.id);
  let videoPath: string | null = null;
  let tracePath: string | null = null;
  let size = 0;
  if (opts.escapePath) {
    videoPath = "../../outside-escape.webm";
  } else if (opts.videoBytes !== null) {
    const abs = path.join(dir, "video.webm");
    await writeFile(abs, opts.videoBytes);
    videoPath = path.relative(ART, abs);
    size += opts.videoBytes;
  }
  if (opts.traceBytes !== null) {
    const abs = path.join(dir, "trace.zip");
    await writeFile(abs, opts.traceBytes);
    tracePath = path.relative(ART, abs);
    size += opts.traceBytes;
  }
  await attachAgentRunRecording(opts.workspaceId, run.id, {
    videoPath,
    // The recorder always produces a trace; seeds here do too.
    tracePath: tracePath as string,
    stepCount: 3,
    sizeBytes: size,
    retentionUntil: opts.retentionUntil,
  });
  return { runId: run.id };
}

before(async () => {
  ART = await fs.mkdtemp(path.join(os.tmpdir(), "16s8-art-"));
  for (const id of [WS_A, WS_B]) {
    await prisma.workspace.deleteMany({ where: { id } });
    await prisma.workspace.create({
      data: { id, name: `16s8 ${id}`, ownerUserId: "16s8-owner" },
    });
  }
});

after(async () => {
  for (const id of [...testWorkspaces, WS_A, WS_B]) {
    await prisma.workspace.deleteMany({ where: { id } });
  }
  await prisma.$disconnect();
  await fs.rm(ART, { recursive: true, force: true });
});

describe("retention sweep predicates (no DB)", () => {
  it("sweeps expired + unpinned + video recordings", () => {
    assert.equal(
      isSweepCandidate({ retentionUntil: EXPIRED, pinned: false, videoPath: "v.webm" }, NOW),
      true,
    );
  });
  it("never sweeps pinned recordings", () => {
    assert.equal(
      isSweepCandidate({ retentionUntil: EXPIRED, pinned: true, videoPath: "v.webm" }, NOW),
      false,
    );
  });
  it("never sweeps not-yet-expired recordings", () => {
    assert.equal(
      isSweepCandidate({ retentionUntil: FRESH, pinned: false, videoPath: "v.webm" }, NOW),
      false,
    );
  });
  it("boundary: retentionUntil == now is not expired (lt, not lte)", () => {
    assert.equal(
      isSweepCandidate({ retentionUntil: NOW, pinned: false, videoPath: "v.webm" }, NOW),
      false,
    );
  });
  it("never sweeps recordings with no video path", () => {
    assert.equal(
      isSweepCandidate({ retentionUntil: EXPIRED, pinned: false, videoPath: null }, NOW),
      false,
    );
    assert.equal(
      isSweepCandidate({ retentionUntil: EXPIRED, pinned: false, videoPath: "" }, NOW),
      false,
    );
  });
  it("resolveRecordingPath keeps paths inside the root", () => {
    const root = "/art";
    assert.equal(
      resolveRecordingPath("run-1/video.webm", root),
      path.resolve(root, "run-1/video.webm"),
    );
    assert.equal(
      resolveRecordingPath("/art/run-1/video.webm", root),
      path.resolve("/art/run-1/video.webm"),
    );
  });
  it("resolveRecordingPath fails closed on escaping paths", () => {
    const root = "/art";
    assert.equal(resolveRecordingPath("../../etc/passwd", root), null);
    assert.equal(resolveRecordingPath("/etc/passwd", root), null);
    assert.equal(resolveRecordingPath("run-1/../../x.webm", root), null);
  });
});

describe("retention sweep (scratch DB)", () => {
  it("deletes the expired video, keeps the trace, marks the row", async () => {
    const ws = await freshWorkspace();
    const { runId } = await seedRecording({
      workspaceId: ws,
      videoBytes: 1000,
      traceBytes: 500,
      retentionUntil: EXPIRED,
    });
    const report = await sweepExpiredRecordings({ workspaceId: ws, now: NOW, artifactRoot: ART });
    assert.equal(report.swept.length, 1);
    const row = report.swept[0]!;
    assert.equal(row.runId, runId);
    assert.equal(row.reclaimedBytes, 1000);
    assert.equal(row.videoMissing, false);
    assert.equal(report.totalReclaimedBytes, 1000);

    assert.equal(await exists(path.join(ART, runId, "video.webm")), false);
    assert.equal(await exists(path.join(ART, runId, "trace.zip")), true);

    const rec = await getRecording(ws, runId);
    assert.equal(rec.videoPath, null);
    assert.ok(rec.videoPurgedAt);
    assert.equal(rec.tracePath !== null, true);
    assert.equal(Number(rec.sizeBytes), 500); // video subtracted, trace retained
  });

  it("never deletes pinned recordings", async () => {
    const ws = await freshWorkspace();
    const { runId } = await seedRecording({
      workspaceId: ws,
      videoBytes: 700,
      traceBytes: 300,
      retentionUntil: EXPIRED,
    });
    await setRecordingPinned(ws, runId, true);
    const report = await sweepExpiredRecordings({ workspaceId: ws, now: NOW, artifactRoot: ART });
    assert.equal(report.swept.length, 0);
    assert.equal(await exists(path.join(ART, runId, "video.webm")), true);
    const rec = await getRecording(ws, runId);
    assert.equal(rec.videoPath !== null, true);
    assert.equal(rec.videoPurgedAt, null);
    assert.equal(rec.pinned, true);
    // Unpin works (round-trip).
    await setRecordingPinned(ws, runId, false);
    const rec2 = await getRecording(ws, runId);
    assert.equal(rec2.pinned, false);
  });

  it("never deletes not-yet-expired recordings", async () => {
    const ws = await freshWorkspace();
    const { runId } = await seedRecording({
      workspaceId: ws,
      videoBytes: 700,
      traceBytes: 300,
      retentionUntil: FRESH,
    });
    const report = await sweepExpiredRecordings({ workspaceId: ws, now: NOW, artifactRoot: ART });
    assert.equal(report.swept.length, 0);
    assert.equal(await exists(path.join(ART, runId, "video.webm")), true);
  });

  it("tolerates a missing video file (marks purged, reclaims 0)", async () => {
    const ws = await freshWorkspace();
    const { runId } = await seedRecording({
      workspaceId: ws,
      videoBytes: 900,
      traceBytes: 400,
      retentionUntil: EXPIRED,
    });
    // Video already gone from disk (e.g. manual cleanup).
    await fs.unlink(path.join(ART, runId, "video.webm"));
    const report = await sweepExpiredRecordings({ workspaceId: ws, now: NOW, artifactRoot: ART });
    assert.equal(report.swept.length, 1);
    assert.equal(report.swept[0]!.runId, runId);
    assert.equal(report.swept[0]!.reclaimedBytes, 0);
    assert.equal(report.swept[0]!.videoMissing, true);
    const rec = await getRecording(ws, runId);
    assert.equal(rec.videoPath, null);
    assert.ok(rec.videoPurgedAt);
    assert.equal(Number(rec.sizeBytes), 1300); // nothing subtracted (file was gone)
    assert.equal(await exists(path.join(ART, runId, "trace.zip")), true);
  });

  it("fail-closes on a videoPath escaping the artifact root", async () => {
    const ws = await freshWorkspace();
    const outside = path.join(os.tmpdir(), `16s8-outside-${process.pid}.webm`);
    await writeFile(outside, 123);
    const { runId } = await seedRecording({
      workspaceId: ws,
      videoBytes: null,
      traceBytes: 200,
      retentionUntil: EXPIRED,
      escapePath: true,
    });
    const report = await sweepExpiredRecordings({ workspaceId: ws, now: NOW, artifactRoot: ART });
    assert.equal(report.swept.length, 0);
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0]!.runId, runId);
    assert.ok(/artifact root/.test(report.skipped[0]!.reason));
    assert.equal(await exists(outside), true); // outside file untouched
    const rec = await getRecording(ws, runId);
    assert.equal(rec.videoPath, "../../outside-escape.webm");
    assert.equal(rec.videoPurgedAt, null);
    await fs.unlink(outside);
  });

  it("sweep is idempotent: a second run finds nothing to do", async () => {
    const ws = await freshWorkspace();
    const { runId } = await seedRecording({
      workspaceId: ws,
      videoBytes: 600,
      traceBytes: 200,
      retentionUntil: EXPIRED,
    });
    const first = await sweepExpiredRecordings({ workspaceId: ws, now: NOW, artifactRoot: ART });
    assert.ok(first.swept.some((r) => r.runId === runId));
    const second = await sweepExpiredRecordings({ workspaceId: ws, now: NOW, artifactRoot: ART });
    assert.equal(second.swept.length, 0);
    assert.equal(second.skipped.length, 0);
    assert.equal(second.totalReclaimedBytes, 0);
  });

  it("honors the workspace filter (other workspaces untouched)", async () => {
    const ws = await freshWorkspace();
    const wsB = await freshWorkspace();
    const { runId } = await seedRecording({
      workspaceId: wsB,
      videoBytes: 800,
      traceBytes: 200,
      retentionUntil: EXPIRED,
    });
    const report = await sweepExpiredRecordings({ workspaceId: ws, now: NOW, artifactRoot: ART });
    assert.equal(report.swept.some((r) => r.runId === runId), false);
    assert.deepEqual(report.workspaces, [ws]);
    assert.equal(await exists(path.join(ART, runId, "video.webm")), true);
    // Cleanup: sweep WS_B too so it doesn't leak into later tests.
    await sweepExpiredRecordings({ workspaceId: wsB, now: NOW, artifactRoot: ART });
  });
});

describe("storage accounting (scratch DB)", () => {
  it("rolls up bytes and counts per workspace", async () => {
    const ws = await freshWorkspace();
    try {
      // Row 1: video 1000 + trace 500 → sizeBytes 1500.
      const r1 = await seedRecording({
        workspaceId: ws,
        videoBytes: 1000,
        traceBytes: 500,
        retentionUntil: FRESH,
      });
      // Row 2: trace-only (videoPath null from the start).
      await seedRecording({ workspaceId: ws, videoBytes: null, traceBytes: 300, retentionUntil: FRESH });
      // Row 3: expired video → swept (purged, sizeBytes reduced to trace only).
      const r3 = await seedRecording({
        workspaceId: ws,
        videoBytes: 2000,
        traceBytes: 800,
        retentionUntil: EXPIRED,
      });
      await setRecordingPinned(ws, r3.runId, false);
      await sweepExpiredRecordings({ workspaceId: ws, now: NOW, artifactRoot: ART });
      // Row 4: expired video, pinned → kept.
      const r4 = await seedRecording({
        workspaceId: ws,
        videoBytes: 400,
        traceBytes: 100,
        retentionUntil: EXPIRED,
      });
      await setRecordingPinned(ws, r4.runId, true);

      const s = await getRecordingStorage(ws, ART);
      assert.equal(s.workspaceId, ws);
      assert.equal(s.count, 4);
      assert.equal(s.pinnedCount, 1);
      assert.equal(s.purgedVideoCount, 1);
      // Disk truth: videos on disk = r1 1000 + r4 400; traces = 500 + 300 + 800 + 100.
      assert.equal(s.videoBytes, 1400);
      assert.equal(s.traceBytes, 1700);
      // Recorded truth: 1500 + 300 + 800 + 500 = 3100.
      assert.equal(s.totalBytes, 3100);
      assert.equal(s.missingFileCount, 0);
    } finally {
      await prisma.workspace.deleteMany({ where: { id: ws } });
    }
  });

  it("counts missing files instead of failing", async () => {
    const ws = await freshWorkspace();
    try {
      const { runId } = await seedRecording({
        workspaceId: ws,
        videoBytes: 500,
        traceBytes: 500,
        retentionUntil: FRESH,
      });
      await fs.unlink(path.join(ART, runId, "video.webm"));
      const s = await getRecordingStorage(ws, ART);
      assert.equal(s.count, 1);
      assert.equal(s.videoBytes, 0);
      assert.equal(s.traceBytes, 500);
      assert.equal(s.missingFileCount, 1);
      assert.equal(s.totalBytes, 1000); // recorded bytes unchanged
    } finally {
      await prisma.workspace.deleteMany({ where: { id: ws } });
    }
  });
});
