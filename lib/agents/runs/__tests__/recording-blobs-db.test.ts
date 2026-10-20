// Deploy PR (WS=state): agent run recordings in the SHARED blob store.
// Run: DATABASE_URL=<app role> npx tsx --test lib/agents/runs/__tests__/recording-blobs-db.test.ts
//
// The blob backend is the S3 client pointed at the in-process S3-compatible
// FAKE (lib/filesystem/fake-s3.ts — labelled fake, signature-checked), so
// "recorded on the worker, served by a web replica" is exercised through the
// real S3 code path: publish → attach → resolve → ranged read, all
// workspace-scoped; a ref pointing into another workspace's prefix is
// refused; the retention sweep deletes blob videos and keeps traces; the
// browser tools' last page is read back from the run timeline.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prisma } from "@/lib/prisma";
import { S3BlobBackend, S3CompatibleAdapter, setBlobBackendForTests } from "@/lib/filesystem/storage";
import { startFakeS3, type FakeS3 } from "@/lib/filesystem/fake-s3";
import { appendAgentRunEvent, attachAgentRunRecording, createAgentRun, lastBrowserPageForTask } from "../service";
import { publishRecordingArtifacts, readRecordingBytes, resolveRecordingAsset } from "../artifacts";
import { sweepExpiredRecordings, getRecordingStorage } from "../retention";

const WS_A = "deploy-rec-ws-a";
const WS_B = "deploy-rec-ws-b";
let fake: FakeS3;

before(async () => {
  fake = await startFakeS3({ bucket: "rec", accessKeyId: "AK", secretAccessKey: "SK" });
  setBlobBackendForTests(
    new S3BlobBackend(new S3CompatibleAdapter({ endpoint: fake.endpoint, region: "us-east-1", bucket: "rec", accessKey: "AK", secretKey: "SK", forcePathStyle: true })),
  );
  for (const id of [WS_A, WS_B]) {
    await prisma.workspace.deleteMany({ where: { id } });
    await prisma.workspace.create({ data: { id, name: `deploy ${id}`, ownerUserId: "deploy-owner" } });
  }
});

after(async () => {
  setBlobBackendForTests(null);
  for (const id of [WS_A, WS_B]) await prisma.workspace.deleteMany({ where: { id } });
  await fake.close();
  await prisma.$disconnect();
});

async function scratch(runId: string, video = "WEBM-0123456789", trace = "TRACE-ZIP"): Promise<string> {
  const dir = path.join(os.tmpdir(), `deploy-rec-${runId}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "video.webm"), video);
  await fs.writeFile(path.join(dir, "trace.zip"), trace);
  await fs.writeFile(path.join(dir, "step-1-1.png"), "PNG");
  return dir;
}

describe("recordings in the shared blob store", () => {
  it("publish uploads under the workspace prefix, removes the scratch dir, and any instance serves it", async () => {
    const run = await createAgentRun({ workspaceId: WS_A, kind: "browser", startedBy: "agent:test" });
    const dir = await scratch(run.id);
    const pub = await publishRecordingArtifacts({
      workspaceId: WS_A,
      runId: run.id,
      artifactDir: dir,
      videoPath: path.join(dir, "video.webm"),
      tracePath: path.join(dir, "trace.zip"),
    });
    assert.deepEqual(pub.errors, []);
    assert.equal(pub.videoRef, `blob:run-recordings/${WS_A}/${run.id}/video.webm`);
    assert.equal(pub.traceRef, `blob:run-recordings/${WS_A}/${run.id}/trace.zip`);
    assert.equal(pub.screenshots.length, 1);
    assert.equal(pub.sizeBytes, 15 + 9);
    await assert.rejects(fs.stat(dir), "scratch directory removed after upload");
    assert.ok(fake.objects.has(`blobs/run-recordings/${WS_A}/${run.id}/video.webm`));

    await attachAgentRunRecording(WS_A, run.id, {
      videoPath: pub.videoRef,
      tracePath: pub.traceRef,
      stepCount: 1,
      sizeBytes: pub.sizeBytes,
      retentionUntil: new Date(Date.now() + 86_400_000),
    });
    const video = await resolveRecordingAsset(WS_A, run.id, "video");
    assert.ok(video);
    assert.equal(video.location.kind, "blob");
    assert.equal(video.sizeBytes, 15);
    assert.equal((await readRecordingBytes(video.location))!.toString(), "WEBM-0123456789");
    assert.equal((await readRecordingBytes(video.location, { start: 5, end: 8 }))!.toString(), "0123");
    assert.equal(await resolveRecordingAsset(WS_B, run.id, "video"), null, "foreign workspace → 404");
  });

  it("a ref that points into ANOTHER workspace's prefix is refused (fail-closed)", async () => {
    const victim = await createAgentRun({ workspaceId: WS_B, kind: "browser", startedBy: "agent:test" });
    const dir = await scratch(victim.id, "VICTIM-VIDEO");
    const pub = await publishRecordingArtifacts({ workspaceId: WS_B, runId: victim.id, artifactDir: dir, videoPath: path.join(dir, "video.webm"), tracePath: null });
    const attacker = await createAgentRun({ workspaceId: WS_A, kind: "browser", startedBy: "agent:test" });
    await attachAgentRunRecording(WS_A, attacker.id, {
      videoPath: pub.videoRef, // WS_B's object
      tracePath: "blob:reports/x.pdf", // another namespace
      stepCount: 0,
      sizeBytes: 0,
      retentionUntil: new Date(Date.now() + 86_400_000),
    });
    assert.equal(await resolveRecordingAsset(WS_A, attacker.id, "video"), null);
    assert.equal(await resolveRecordingAsset(WS_A, attacker.id, "trace"), null);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("retention sweep deletes the blob video, keeps the trace, and the rollup reads the store", async () => {
    const run = await createAgentRun({ workspaceId: WS_A, kind: "browser", startedBy: "agent:test" });
    const dir = await scratch(run.id, "OLD-VIDEO", "OLD-TRACE");
    const pub = await publishRecordingArtifacts({
      workspaceId: WS_A,
      runId: run.id,
      artifactDir: dir,
      videoPath: path.join(dir, "video.webm"),
      tracePath: path.join(dir, "trace.zip"),
    });
    await attachAgentRunRecording(WS_A, run.id, {
      videoPath: pub.videoRef,
      tracePath: pub.traceRef,
      stepCount: 1,
      sizeBytes: pub.sizeBytes,
      retentionUntil: new Date(Date.now() - 86_400_000),
    });
    const before = await getRecordingStorage(WS_A);
    assert.ok(before.videoBytes >= 9);
    const report = await sweepExpiredRecordings({ workspaceId: WS_A });
    const row = report.swept.find((s) => s.runId === run.id);
    assert.ok(row, "swept");
    assert.equal(row.reclaimedBytes, 9);
    assert.equal(fake.objects.has(`blobs/run-recordings/${WS_A}/${run.id}/video.webm`), false, "video object deleted");
    assert.equal(fake.objects.has(`blobs/run-recordings/${WS_A}/${run.id}/trace.zip`), true, "trace kept");
    const rec = await prisma.agentRunRecording.findFirst({ where: { runId: run.id } });
    assert.equal(rec, null, "the app role sees no rows without the workspace GUC (FORCE RLS)");
  });

  it("the browser tools' last page comes back from the run timeline on any instance", async () => {
    const chat = await createAgentRun({ workspaceId: WS_A, kind: "chat", startedBy: "u1", threadId: "deploy-thread-1" });
    assert.equal(await lastBrowserPageForTask(WS_A, { threadId: "deploy-thread-1" }), null);
    await appendAgentRunEvent(WS_A, chat.id, { type: "browser", summary: "Opened", payload: { tool: "browser_open", url: "https://a.example/" } });
    await appendAgentRunEvent(WS_A, chat.id, { type: "browser", summary: "noise", payload: { action: "click" } });
    await appendAgentRunEvent(WS_A, chat.id, { type: "browser", summary: "Ran", payload: { tool: "browser_act", url: "https://b.example/next" } });
    assert.equal(await lastBrowserPageForTask(WS_A, { threadId: "deploy-thread-1" }), "https://b.example/next");
    assert.equal(await lastBrowserPageForTask(WS_A, { runId: chat.id }), "https://b.example/next");
    assert.equal(await lastBrowserPageForTask(WS_B, { threadId: "deploy-thread-1" }), null, "RLS: another workspace sees nothing");
  });
});
