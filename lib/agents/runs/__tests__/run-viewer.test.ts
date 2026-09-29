// Marketr — Phase 16 slice 6 tests: run viewer data loading + artifact guard.
// Run: npx tsx --test lib/agents/runs/__tests__/run-viewer.test.ts
//
// Integration: hits the configured Postgres (same pattern as the slice-5
// runs-rls battery), exercising the exact code paths the viewer page and
// the artifact API route use: getAgentRun (page 404 on foreign runId),
// listAgentRunEvents (seq ordering), resolveRecordingAsset (route rejects
// cross-workspace, missing files, and path traversal).
// No browser is launched: artifacts are real files on disk under
// .run-artifacts/<runId>/, matching what the recorder writes.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { prisma } from "@/lib/prisma";
import {
  createAgentRun,
  appendAgentRunEvent,
  attachAgentRunRecording,
  getAgentRun,
  listAgentRunEvents,
} from "../service";
import { ARTIFACT_ROOT } from "../recorder";
import { resolveRecordingAsset, isRecordingAsset } from "../artifacts";

const WS_A = "16s6-ws-a";
const WS_B = "16s6-ws-b";

let runId = "";
let artifactDir = "";

before(async () => {
  for (const id of [WS_A, WS_B]) {
    await prisma.workspace.deleteMany({ where: { id } });
    await prisma.workspace.create({
      data: { id, name: `16s6 ${id}`, ownerUserId: "16s6-owner" },
    });
  }

  const run = await createAgentRun({
    workspaceId: WS_A,
    kind: "browser",
    startedBy: "agent:test-viewer",
    threadId: "thread-16s6",
    missionId: "mission-16s6",
  });
  runId = run.id;
  artifactDir = path.join(ARTIFACT_ROOT, runId);
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(path.join(artifactDir, "video.webm"), "fake-webm-bytes");
  await fs.writeFile(path.join(artifactDir, "trace.zip"), "fake-trace-bytes");

  await attachAgentRunRecording(WS_A, runId, {
    videoPath: path.join(artifactDir, "video.webm"),
    tracePath: path.join(artifactDir, "trace.zip"),
    stepCount: 4,
    sizeBytes: 30,
    retentionUntil: new Date(Date.now() + 30 * 24 * 3600 * 1000),
  });

  await appendAgentRunEvent(WS_A, runId, { type: "agui", summary: "RUN_STARTED" });
  await appendAgentRunEvent(WS_A, runId, {
    type: "browser",
    summary: "navigated to https://example.com",
    payload: { action: "goto", url: "https://example.com" },
  });
  await appendAgentRunEvent(WS_A, runId, { type: "gate", summary: "approval requested" });
  await appendAgentRunEvent(WS_A, runId, { type: "note", summary: "operator note" });
});

after(async () => {
  await fs.rm(path.join(ARTIFACT_ROOT, runId), { recursive: true, force: true });
  for (const id of [WS_A, WS_B]) {
    await prisma.workspace.deleteMany({ where: { id } });
  }
  await prisma.$disconnect();
});

describe("run viewer data loading", () => {
  it("loads the run with its recording inside the workspace scope", async () => {
    const run = await getAgentRun(WS_A, runId);
    assert.ok(run);
    assert.equal(run.kind, "browser");
    assert.equal(run.threadId, "thread-16s6");
    assert.equal(run.missionId, "mission-16s6");
    assert.ok(run.recording);
    assert.equal(run.recording!.stepCount, 4);
    assert.equal(run._count.events, 4);
  });

  it("returns null for a foreign runId (the page 404s)", async () => {
    assert.equal(await getAgentRun(WS_B, runId), null);
    assert.equal(await getAgentRun(WS_A, "does-not-exist"), null);
  });

  it("lists the timeline seq-ordered with types and payloads", async () => {
    const events = await listAgentRunEvents(WS_A, runId);
    assert.deepEqual(events.map((e) => e.seq), [0, 1, 2, 3]);
    assert.deepEqual(events.map((e) => e.type), ["agui", "browser", "gate", "note"]);
    assert.deepEqual((events[1]!.payload as Record<string, unknown>).url, "https://example.com");
  });

  it("assigns strictly increasing seqs under concurrent appends", async () => {
    const concurrent = await createAgentRun({
      workspaceId: WS_A,
      kind: "mission",
      startedBy: "agent:test-viewer",
    });
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        appendAgentRunEvent(WS_A, concurrent.id, { type: "note", summary: `n${i}` }),
      ),
    );
    const events = await listAgentRunEvents(WS_A, concurrent.id);
    assert.deepEqual(events.map((e) => e.seq), [0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("shows no timeline to the other workspace", async () => {
    assert.equal((await listAgentRunEvents(WS_B, runId)).length, 0);
  });
});

describe("artifact route guard (resolveRecordingAsset)", () => {
  it("resolves video and trace for the owning workspace", async () => {
    const video = await resolveRecordingAsset(WS_A, runId, "video");
    assert.ok(video);
    assert.equal(video.contentType, "video/webm");
    assert.ok(video.filename.endsWith(".webm"));
    assert.ok(video.sizeBytes > 0);

    const trace = await resolveRecordingAsset(WS_A, runId, "trace");
    assert.ok(trace);
    assert.equal(trace.contentType, "application/zip");
    assert.ok(trace.filename.endsWith(".zip"));
  });

  it("rejects cross-workspace access (the route 404s, never streams)", async () => {
    assert.equal(await resolveRecordingAsset(WS_B, runId, "video"), null);
    assert.equal(await resolveRecordingAsset(WS_B, runId, "trace"), null);
  });

  it("returns null when the asset is missing or the file is gone", async () => {
    const noVideo = await createAgentRun({
      workspaceId: WS_A,
      kind: "browser",
      startedBy: "agent:test-viewer",
    });
    const dir = path.join(ARTIFACT_ROOT, noVideo.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "trace.zip"), "fake-trace-bytes");
    await attachAgentRunRecording(WS_A, noVideo.id, {
      videoPath: null,
      tracePath: path.join(dir, "trace.zip"),
      stepCount: 0,
      sizeBytes: 15,
      retentionUntil: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    });
    assert.equal(await resolveRecordingAsset(WS_A, noVideo.id, "video"), null);

    await fs.rm(path.join(dir, "trace.zip"));
    assert.equal(await resolveRecordingAsset(WS_A, noVideo.id, "trace"), null);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rejects stored paths that escape the artifact root", async () => {
    const evil = await createAgentRun({
      workspaceId: WS_A,
      kind: "browser",
      startedBy: "agent:test-viewer",
    });
    await attachAgentRunRecording(WS_A, evil.id, {
      videoPath: "/etc/passwd",
      tracePath: path.join(ARTIFACT_ROOT, "..", "package.json"),
      stepCount: 0,
      sizeBytes: 1,
      retentionUntil: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    });
    assert.equal(await resolveRecordingAsset(WS_A, evil.id, "video"), null);
    assert.equal(await resolveRecordingAsset(WS_A, evil.id, "trace"), null);
  });

  it("rejects unknown asset names", () => {
    assert.equal(isRecordingAsset("video"), true);
    assert.equal(isRecordingAsset("trace"), true);
    assert.equal(isRecordingAsset("exe"), false);
    assert.equal(isRecordingAsset(""), false);
    assert.equal(isRecordingAsset("trace.zip"), false);
  });
});
