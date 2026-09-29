// Marketr — Phase 16 slice 7 tests: live watch (CDP screencast → registry → SSE).
// Run: npx tsx --test lib/agents/runs/__tests__/watch.test.ts
//
// Three layers:
//   A. Watch registry (no DB, no browser): one-stream-per-run fail-fast,
//      frame fan-out, latest-wins, timeout, teardown semantics.
//   B. Recorder integration (stub CDP page, no real Chromium): the slice-5
//      recorder attaches the stream on start when watch:true, publishes
//      real JPEG-magic frames through it, and ends it on stop(). A page
//      without the screencast seam is skipped silently — the run proceeds
//      unwatched instead of failing.
//   C. Watch access (Postgres): getWatchStreamAccess denies cross-workspace subscribers,
//      grants same-workspace while the stream is active, and denies once
//      the stream has ended. This is the exact check the SSE route makes.
//      Hits a scratch Postgres DB (marketr_16s7_test on :5434) carrying all
//      repo migrations — same pattern as the slice-5 runs-rls battery.
// Run: DATABASE_URL=postgresql://postgres:postgres@localhost:5434/marketr_16s7_test
//        npx tsx --test lib/agents/runs/__tests__/watch.test.ts

import "dotenv/config";
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { prisma } from "@/lib/prisma";
import {
  AgentRunRecorder,
  type BrowserLauncher,
  type RecorderContext,
  type RecorderPage,
} from "../recorder";
import {
  WatchBusyError,
  attachWatch,
  endWatchStream,
  getWatchStreamAccess,
  isWatchStreamActive,
  publishWatchFrame,
  startWatchStream,
  subscribeWatchStream,
  _resetWatchRegistryForTests,
} from "../watch";
import { createAgentRun } from "../service";

/** Minimal fake JPEG (magic bytes only — the pipeline never decodes). */
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xff, 0xd9]);
const FAKE_JPEG_2 = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x4a, 0x46, 0xff, 0xd9]);

function isJpeg(buf: Buffer): boolean {
  return buf[0] === 0xff && buf[1] === 0xd8;
}

function stubContext(page: RecorderPage, artifactDir: string): RecorderContext {
  return {
    tracingStart: async () => undefined,
    tracingStop: async (tracePath: string) => {
      await fs.writeFile(tracePath, "fake-trace-bytes");
    },
    newPage: async () => page,
    close: async () => undefined,
    videoPath: async () => null,
  };
}

function stubLauncher(page: RecorderPage, artifactDir: string): BrowserLauncher {
  return {
    launch: async () => ({
      newContext: async () => stubContext(page, artifactDir),
      close: async () => undefined,
    }),
  };
}

/** Stub page that emits the given frames on a 10ms interval until stopped. */
function screencastPage(frames: Buffer[]): RecorderPage & { stopCalls: () => number } {
  let stops = 0;
  const page: RecorderPage = {
    goto: async () => undefined,
    startScreencast: async (_opts, onFrame) => {
      let i = 0;
      const timer = setInterval(() => {
        if (i < frames.length) {
          const f = frames[i]!;
          i += 1;
          void onFrame(f);
        }
      }, 10);
      let stopped = false;
      return async () => {
        if (stopped) return;
        stopped = true;
        stops += 1;
        clearInterval(timer);
      };
    },
  };
  return Object.assign(page, { stopCalls: () => stops });
}

beforeEach(() => {
  _resetWatchRegistryForTests();
});

// ---------- A. registry ----------

describe("watch registry", () => {
  it("publishes frames to subscribers", async () => {
    startWatchStream("run-a1");
    const sub = subscribeWatchStream("run-a1");
    publishWatchFrame("run-a1", FAKE_JPEG);
    const next = await sub.nextFrame(500);
    assert.ok(next && !("ended" in next) && next !== null);
    assert.ok(isJpeg(next.jpeg));
    assert.equal(next.seq, 1);
  });

  it("fails fast when a stream is already active for the run", () => {
    startWatchStream("run-a2");
    assert.throws(() => startWatchStream("run-a2"), (err: unknown) => {
      assert.ok(err instanceof WatchBusyError);
      assert.equal(err.name, "WatchBusyError");
      return true;
    });
  });

  it("allows a new stream after the previous one ended", () => {
    startWatchStream("run-a3");
    endWatchStream("run-a3");
    assert.doesNotThrow(() => startWatchStream("run-a3"));
    assert.ok(isWatchStreamActive("run-a3"));
  });

  it("publishing to an unknown run is a silent no-op", () => {
    assert.doesNotThrow(() => publishWatchFrame("run-unknown", FAKE_JPEG));
  });

  it("late subscribers observe ended immediately", async () => {
    startWatchStream("run-a5");
    endWatchStream("run-a5");
    const sub = subscribeWatchStream("run-a5");
    const next = await sub.nextFrame(500);
    assert.deepEqual(next, { ended: true });
    assert.ok(!isWatchStreamActive("run-a5"));
  });

  it("subscriber timeout resolves null when no frames arrive", async () => {
    startWatchStream("run-a6");
    const sub = subscribeWatchStream("run-a6");
    const next = await sub.nextFrame(50);
    assert.equal(next, null);
    sub.close();
    const afterClose = await sub.nextFrame(50);
    assert.deepEqual(afterClose, { ended: true });
  });

  it("latest-wins: a subscriber sees the newest frame, not a queue", async () => {
    startWatchStream("run-a7");
    publishWatchFrame("run-a7", FAKE_JPEG);
    publishWatchFrame("run-a7", FAKE_JPEG_2);
    const sub = subscribeWatchStream("run-a7");
    const next = await sub.nextFrame(500);
    assert.ok(next && !("ended" in next) && next !== null);
    assert.equal(next.seq, 2);
    assert.ok(next.jpeg.equals(FAKE_JPEG_2));
  });

  it("fans out to multiple subscribers", async () => {
    startWatchStream("run-a8");
    const s1 = subscribeWatchStream("run-a8");
    const s2 = subscribeWatchStream("run-a8");
    publishWatchFrame("run-a8", FAKE_JPEG);
    const [n1, n2] = await Promise.all([s1.nextFrame(500), s2.nextFrame(500)]);
    assert.ok(n1 && !("ended" in n1) && n1 !== null && isJpeg(n1.jpeg));
    assert.ok(n2 && !("ended" in n2) && n2 !== null && isJpeg(n2.jpeg));
  });

  it("attachWatch returns null when the page cannot screencast", async () => {
    const detach = await attachWatch({ goto: async () => undefined }, "run-a9");
    assert.equal(detach, null);
    assert.ok(!isWatchStreamActive("run-a9"));
  });

  it("attachWatch claims the slot and detach ends the stream", async () => {
    const page = screencastPage([FAKE_JPEG]);
    const detach = await attachWatch(page, "run-a10");
    assert.ok(detach);
    assert.ok(isWatchStreamActive("run-a10"));
    await detach!();
    assert.ok(!isWatchStreamActive("run-a10"));
    assert.equal(page.stopCalls(), 1);
  });
});

// ---------- B. recorder integration ----------

describe("recorder watch integration", () => {
  async function tmpDir(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), "watch-test-"));
  }

  it("streams JPEG frames while the run executes and ends on stop", async () => {
    const dir = await tmpDir();
    const runId = "watch-b1";
    const page = screencastPage([FAKE_JPEG, FAKE_JPEG_2]);
    const rec = new AgentRunRecorder({
      runId,
      artifactDir: dir,
      launcher: stubLauncher(page, dir),
      headless: true,
      watch: true,
    });
    await rec.start("https://example.com");
    assert.ok(isWatchStreamActive(runId));

    const sub = subscribeWatchStream(runId);
    const first = await sub.nextFrame(2000);
    assert.ok(first && !("ended" in first) && first !== null, "expected a live frame");
    assert.ok(isJpeg(first.jpeg));

    // The timeline keeps working alongside the watch stream.
    await rec.recordAction("clicked something", { selector: "#x" });

    const stopped = await rec.stop();
    assert.equal(stopped.stepCount, 1);
    assert.ok(!isWatchStreamActive(runId));
    assert.equal(page.stopCalls(), 1);

    const afterEnd = await sub.nextFrame(500);
    assert.deepEqual(afterEnd, { ended: true });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("skips the stream silently when the page has no screencast seam", async () => {
    const dir = await tmpDir();
    const runId = "watch-b2";
    const rec = new AgentRunRecorder({
      runId,
      artifactDir: dir,
      launcher: stubLauncher({ goto: async () => undefined }, dir),
      watch: true,
    });
    await rec.start();
    assert.ok(!isWatchStreamActive(runId));
    const stopped = await rec.stop();
    assert.equal(stopped.stepCount, 0);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("does not attach a stream when watch is not requested", async () => {
    const dir = await tmpDir();
    const runId = "watch-b3";
    const rec = new AgentRunRecorder({
      runId,
      artifactDir: dir,
      launcher: stubLauncher(screencastPage([FAKE_JPEG]), dir),
    });
    await rec.start();
    assert.ok(!isWatchStreamActive(runId));
    await rec.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });
});

// ---------- C. workspace-scoped access (Postgres) ----------

describe("watch stream access", () => {
  const WS_A = "16s7-ws-a";
  const WS_B = "16s7-ws-b";
  let runId = "";

  beforeEach(async () => {
    _resetWatchRegistryForTests();
  });

  // node:test describe-level before/after via closure
  const setup = async () => {
    for (const id of [WS_A, WS_B]) {
      await prisma.workspace.deleteMany({ where: { id } });
      await prisma.workspace.create({ data: { id, name: `16s7 ${id}`, ownerUserId: "16s7-owner" } });
    }
    const run = await createAgentRun({
      workspaceId: WS_A,
      kind: "browser",
      startedBy: "agent:test-watch",
    });
    runId = run.id;
  };
  const teardown = async () => {
    await prisma.agentRunEvent.deleteMany({ where: { workspaceId: { in: [WS_A, WS_B] } } });
    await prisma.agentRunRecording.deleteMany({ where: { workspaceId: { in: [WS_A, WS_B] } } });
    await prisma.agentRun.deleteMany({ where: { workspaceId: { in: [WS_A, WS_B] } } });
    await prisma.workspace.deleteMany({ where: { id: { in: [WS_A, WS_B] } } });
  };

  it("denies cross-workspace watch access", async () => {
    await setup();
    try {
      startWatchStream(runId);
      const denied = await getWatchStreamAccess(WS_B, runId);
      assert.equal(denied, null);
    } finally {
      endWatchStream(runId);
      await teardown();
    }
  });

  it("grants same-workspace access while the stream is active", async () => {
    await setup();
    try {
      startWatchStream(runId);
      const access = await getWatchStreamAccess(WS_A, runId);
      assert.ok(access);
      assert.equal(access.status, "queued");
    } finally {
      endWatchStream(runId);
      await teardown();
    }
  });

  it("denies access once the stream has ended", async () => {
    await setup();
    try {
      startWatchStream(runId);
      endWatchStream(runId);
      const access = await getWatchStreamAccess(WS_A, runId);
      assert.equal(access, null);
    } finally {
      await teardown();
    }
  });
});

after(async () => {
  _resetWatchRegistryForTests();
  await prisma.$disconnect();
});
