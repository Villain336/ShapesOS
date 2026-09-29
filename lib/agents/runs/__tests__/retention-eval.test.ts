// Marketr — Phase 16 slice 11 evals: retention behavior (eval level).
// Run: DATABASE_URL=postgresql://postgres@localhost:5434/marketr_16s8_test
//        npx tsx --test lib/agents/runs/__tests__/retention-eval.test.ts
// Requires the slice-8 migration on the scratch DB.
//
// Slice 8's retention-sweep.test.ts proved the sweep mechanics. This eval
// proves the INVARIANTS at the eval level:
//   1. pinned is never dropped — pinning after expiry still protects the
//      video across repeated sweeps; unpinning re-arms the sweep;
//   2. traces are never dropped — no sweep, however late, touches a trace
//      file, a tracePath, or a trace-only recording;
//   3. the sweep never over-reclaims — sizeBytes accounting stays ≥ the
//      trace bytes on disk.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import {
  sweepExpiredRecordings,
  getRecordingStorage,
  setRecordingPinned,
} from "../retention";
import { createAgentRun, attachAgentRunRecording } from "../service";

const NOW = new Date("2026-09-29T12:00:00Z");
const EXPIRED = new Date("2026-09-20T12:00:00Z"); // retentionUntil < NOW
const ANCIENT = new Date("2026-06-01T12:00:00Z"); // 90+ days past

let ART: string;
const testWorkspaces: string[] = [];
let wsN = 0;

async function freshWorkspace(): Promise<string> {
  wsN += 1;
  const id = `16s11-t${wsN}`;
  testWorkspaces.push(id);
  await prisma.workspace.deleteMany({ where: { id } });
  await prisma.workspace.create({
    data: { id, name: `16s11 ${id}`, ownerUserId: "16s11-owner" },
  });
  return id;
}

async function writeFile(p: string, bytes: number): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, Buffer.alloc(bytes, 0x61));
}

async function exists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

let seedN = 0;

async function seedRecording(opts: {
  workspaceId: string;
  videoBytes: number | null;
  traceBytes: number;
  retentionUntil: Date;
}): Promise<{ runId: string }> {
  seedN += 1;
  const run = await createAgentRun({
    workspaceId: opts.workspaceId,
    kind: "browser",
    startedBy: "agent:eval-retention",
  });
  const dir = path.join(ART, run.id);
  let videoPath: string | null = null;
  let size = 0;
  if (opts.videoBytes !== null) {
    const abs = path.join(dir, "video.webm");
    await writeFile(abs, opts.videoBytes);
    videoPath = path.relative(ART, abs);
    size += opts.videoBytes;
  }
  const traceAbs = path.join(dir, "trace.zip");
  await writeFile(traceAbs, opts.traceBytes);
  const tracePath = path.relative(ART, traceAbs);
  size += opts.traceBytes;
  await attachAgentRunRecording(opts.workspaceId, run.id, {
    videoPath,
    tracePath,
    stepCount: 3,
    sizeBytes: size,
    retentionUntil: opts.retentionUntil,
  });
  return { runId: run.id };
}

function getRecording(workspaceId: string, runId: string) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.agentRunRecording.findUniqueOrThrow({ where: { runId } }),
  );
}

before(async () => {
  ART = await fs.mkdtemp(path.join(os.tmpdir(), "16s11-art-"));
});

after(async () => {
  for (const id of testWorkspaces) {
    await prisma.workspace.deleteMany({ where: { id } });
  }
  await prisma.$disconnect();
  await fs.rm(ART, { recursive: true, force: true });
});

describe("retention eval: pinned is never dropped", () => {
  it("pinning AFTER expiry still protects the video across repeated sweeps", async () => {
    const ws = await freshWorkspace();
    const { runId } = await seedRecording({
      workspaceId: ws,
      videoBytes: 1000,
      traceBytes: 400,
      retentionUntil: EXPIRED,
    });
    // The recording is already expired when the user pins it — the pin must
    // still win. (Tico's decision (c): pinned unless explicitly unpinned.)
    await setRecordingPinned(ws, runId, true);

    for (let i = 0; i < 2; i++) {
      const report = await sweepExpiredRecordings({ workspaceId: ws, now: NOW, artifactRoot: ART });
      assert.equal(report.swept.length, 0, `sweep ${i}: pinned video must not be swept`);
    }
    assert.equal(await exists(path.join(ART, runId, "video.webm")), true);
    assert.equal(await exists(path.join(ART, runId, "trace.zip")), true);
    const rec = await getRecording(ws, runId);
    assert.equal(rec.videoPath !== null, true);
    assert.equal(rec.videoPurgedAt, null);
    assert.equal(Number(rec.sizeBytes), 1400, "recorded bytes untouched while pinned");
  });

  it("unpinning re-arms the sweep (the pin was the protection, not luck)", async () => {
    const ws = await freshWorkspace();
    const { runId } = await seedRecording({
      workspaceId: ws,
      videoBytes: 1000,
      traceBytes: 400,
      retentionUntil: EXPIRED,
    });
    await setRecordingPinned(ws, runId, true);
    const first = await sweepExpiredRecordings({ workspaceId: ws, now: NOW, artifactRoot: ART });
    assert.equal(first.swept.length, 0);

    await setRecordingPinned(ws, runId, false);
    const second = await sweepExpiredRecordings({ workspaceId: ws, now: NOW, artifactRoot: ART });
    assert.equal(second.swept.length, 1, "unpinned + expired → swept");
    assert.equal(second.swept[0]!.runId, runId);
    assert.equal(await exists(path.join(ART, runId, "video.webm")), false);
    // The trace survives even the video sweep.
    assert.equal(await exists(path.join(ART, runId, "trace.zip")), true);
  });

  it("a pinned recording's storage row keeps its recorded bytes", async () => {
    const ws = await freshWorkspace();
    const { runId } = await seedRecording({
      workspaceId: ws,
      videoBytes: 2000,
      traceBytes: 500,
      retentionUntil: EXPIRED,
    });
    await setRecordingPinned(ws, runId, true);
    await sweepExpiredRecordings({ workspaceId: ws, now: NOW, artifactRoot: ART });
    const s = await getRecordingStorage(ws, ART);
    assert.equal(s.pinnedCount, 1);
    assert.equal(s.purgedVideoCount, 0);
    assert.equal(s.totalBytes, 2500, "pinned row must not be reclaimed");
    assert.equal(s.videoBytes, 2000);
    assert.equal(s.traceBytes, 500);
  });
});

describe("retention eval: traces are never dropped", () => {
  it("a 90-day-overdue recording still keeps its trace after the sweep", async () => {
    const ws = await freshWorkspace();
    const { runId } = await seedRecording({
      workspaceId: ws,
      videoBytes: 1000,
      traceBytes: 600,
      retentionUntil: ANCIENT,
    });
    const report = await sweepExpiredRecordings({ workspaceId: ws, now: NOW, artifactRoot: ART });
    assert.equal(report.swept.length, 1, "video is swept");
    assert.equal(await exists(path.join(ART, runId, "trace.zip")), true, "trace file survives");
    const rec = await getRecording(ws, runId);
    assert.equal(rec.tracePath !== null, true, "tracePath survives");
    assert.equal(Number(rec.sizeBytes), 600, "sizeBytes reduced to trace only — never below");
  });

  it("trace-only recordings (videoPath null from birth) are never sweep candidates", async () => {
    const ws = await freshWorkspace();
    const { runId } = await seedRecording({
      workspaceId: ws,
      videoBytes: null,
      traceBytes: 700,
      retentionUntil: ANCIENT,
    });
    const report = await sweepExpiredRecordings({ workspaceId: ws, now: NOW, artifactRoot: ART });
    assert.equal(report.swept.length, 0);
    assert.equal(report.skipped.length, 0);
    assert.equal(await exists(path.join(ART, runId, "trace.zip")), true);
    const rec = await getRecording(ws, runId);
    assert.equal(Number(rec.sizeBytes), 700);
  });

  it("repeated sweeps never touch the trace (idempotent trace preservation)", async () => {
    const ws = await freshWorkspace();
    const { runId } = await seedRecording({
      workspaceId: ws,
      videoBytes: 800,
      traceBytes: 300,
      retentionUntil: EXPIRED,
    });
    for (let i = 0; i < 3; i++) {
      await sweepExpiredRecordings({ workspaceId: ws, now: NOW, artifactRoot: ART });
    }
    assert.equal(await exists(path.join(ART, runId, "trace.zip")), true);
    const rec = await getRecording(ws, runId);
    assert.equal(Number(rec.sizeBytes), 300, "exactly the trace bytes remain");
  });
});

describe("retention eval: the sweep never over-reclaims", () => {
  it("totalBytes never drops below the trace bytes on disk", async () => {
    const ws = await freshWorkspace();
    const r1 = await seedRecording({
      workspaceId: ws,
      videoBytes: 1500,
      traceBytes: 500,
      retentionUntil: EXPIRED,
    });
    const r2 = await seedRecording({
      workspaceId: ws,
      videoBytes: null,
      traceBytes: 250,
      retentionUntil: ANCIENT,
    });
    await sweepExpiredRecordings({ workspaceId: ws, now: NOW, artifactRoot: ART });

    const s = await getRecordingStorage(ws, ART);
    // Recorded: 2000 + 250 = 2250; video 1500 reclaimed → 750 = 500 + 250.
    assert.equal(s.totalBytes, 750);
    assert.equal(s.traceBytes, 750);
    assert.ok(s.totalBytes >= s.traceBytes, "accounting must never go below trace bytes");

    // Row-level truth agrees.
    assert.equal(Number((await getRecording(ws, r1.runId)).sizeBytes), 500);
    assert.equal(Number((await getRecording(ws, r2.runId)).sizeBytes), 250);
  });
});
