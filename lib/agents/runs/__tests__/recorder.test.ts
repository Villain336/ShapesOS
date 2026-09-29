// Marketr — Phase 16 slice 5 tests: Playwright run recorder.
// Run: npx tsx --test lib/agents/runs/__tests__/recorder.test.ts
//
// The browser launch is stubbed (BrowserLauncher interface) so these tests
// never spawn Chromium and never touch prisma. They assert the recorder
// contract: artifact paths, step counting, timeline emission order, the
// concurrency semaphore, and fail-fast saturation.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  AgentRunRecorder,
  RecorderBusyError,
  recordingRetentionUntil,
  RECORDING_RETENTION_DAYS,
  _activeRecordingCountForTests,
  type BrowserLauncher,
  type RecorderContext,
  type RecorderPage,
} from "../recorder";
import type { AgentRunEventInput } from "../types";

function stubPage(): RecorderPage {
  return { goto: async () => undefined };
}

function stubContext(over: Partial<RecorderContext> = {}): RecorderContext {
  return {
    tracingStart: async () => undefined,
    tracingStop: async () => undefined,
    newPage: async () => stubPage(),
    close: async () => undefined,
    videoPath: async () => null,
    ...over,
  };
}

/** Stub launcher whose stop() leaves a real trace file so sizeBytes > 0. */
function makeStubLauncher(artifactDirOf: (runId: string) => string, videoPath?: string): BrowserLauncher {
  return {
    launch: async () => ({
      newContext: async () => stubContext({
        tracingStop: async (tracePath: string) => {
          await fs.writeFile(tracePath, "fake-trace-bytes");
        },
        videoPath: async () => videoPath ?? null,
      }),
      close: async () => undefined,
    }),
  };
}

function tmpDir(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}`);
}

beforeEach(async () => {
  // Defensive: never leak a held slot between tests.
  assert.equal(_activeRecordingCountForTests(), 0, "slot leaked from a previous test");
});

describe("AgentRunRecorder (stubbed browser)", () => {
  it("records start/stop artifacts and emits an ordered timeline", async () => {
    const dir = tmpDir("rec-artifacts");
    const seen: AgentRunEventInput[] = [];
    const rec = new AgentRunRecorder({
      runId: "run-1",
      artifactDir: dir,
      launcher: makeStubLauncher(() => dir, path.join(dir, "video.webm")),
      onTimelineEvent: (e) => void seen.push(e),
    });

    const { page } = await rec.start("https://example.com");
    await rec.recordAction("Clicked 'Sign in'", { selector: "#signin" });
    await rec.recordAction("Filled email", { selector: "#email" });
    const stopped = await rec.stop();
    void page;

    assert.equal(stopped.tracePath, path.join(dir, "trace.zip"));
    assert.equal(stopped.videoPath, path.join(dir, "video.webm"));
    assert.equal(stopped.stepCount, 2);
    assert.ok(stopped.sizeBytes > 0, "trace bytes counted");
    assert.ok((await fs.stat(stopped.tracePath)).isFile());

    const types = seen.map((e) => e.type);
    assert.deepEqual(types, ["browser", "browser", "browser", "browser"]);
    assert.match(seen[0]!.summary, /recording started/);
    assert.match(seen[0]!.summary, /example\.com/);
    assert.equal(seen[1]!.summary, "Clicked 'Sign in'");
    assert.equal(seen[1]!.payload!.step, 1);
    assert.equal(seen[2]!.payload!.step, 2);
    assert.match(seen[3]!.summary, /recording stopped — 2 step\(s\)/);
    assert.equal(_activeRecordingCountForTests(), 0, "slot released on stop");
  });

  it("fails fast with RecorderBusyError when a recording is already active", async () => {
    const seen: AgentRunEventInput[] = [];
    const mk = (runId: string) =>
      new AgentRunRecorder({
        runId,
        artifactDir: tmpDir(`rec-busy-${runId}`),
        launcher: makeStubLauncher(() => tmpDir("x")),
        onTimelineEvent: (e) => void seen.push(e),
      });
    const first = mk("run-a");
    await first.start();
    assert.equal(_activeRecordingCountForTests(), 1);

    const second = mk("run-b");
    await assert.rejects(second.start(), RecorderBusyError);

    await first.stop();
    assert.equal(_activeRecordingCountForTests(), 0);
    // After release, a new recording can start.
    const third = mk("run-c");
    await third.start();
    await third.stop();
  });

  it("releases the slot when start() fails partway", async () => {
    const failing: BrowserLauncher = {
      launch: async () => {
        throw new Error("chromium exploded");
      },
    };
    const rec = new AgentRunRecorder({
      runId: "run-fail",
      artifactDir: tmpDir("rec-failstart"),
      launcher: failing,
    });
    await assert.rejects(rec.start(), /chromium exploded/);
    assert.equal(_activeRecordingCountForTests(), 0, "slot released after failed start");
  });

  it("rejects misuse: double start, action before start, action after stop", async () => {
    const rec = new AgentRunRecorder({
      runId: "run-misuse",
      artifactDir: tmpDir("rec-misuse"),
      launcher: makeStubLauncher(() => tmpDir("y")),
    });
    await assert.rejects(rec.recordAction("too early"), /not started/);
    await rec.start();
    await assert.rejects(rec.start(), /already started/);
    await rec.stop();
    await assert.rejects(rec.recordAction("too late"), /already stopped/);
    // stop() is idempotent — second call returns without error.
    const again = await rec.stop();
    assert.equal(again.stepCount, 0);
  });

  it("stop() tolerates a missing video (null path, zero contribution)", async () => {
    const dir = tmpDir("rec-novideo");
    const rec = new AgentRunRecorder({
      runId: "run-novideo",
      artifactDir: dir,
      launcher: makeStubLauncher(() => dir), // videoPath() → null
    });
    await rec.start();
    const stopped = await rec.stop();
    assert.equal(stopped.videoPath, null);
    assert.ok(stopped.sizeBytes > 0, "trace still counted");
  });

  it("recordingRetentionUntil is 30 days out (decision c)", async () => {
    const from = new Date("2026-09-29T12:00:00Z");
    const until = recordingRetentionUntil(from);
    const days = (until.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
    assert.equal(days, RECORDING_RETENTION_DAYS);
    assert.equal(RECORDING_RETENTION_DAYS, 30);
  });
});
