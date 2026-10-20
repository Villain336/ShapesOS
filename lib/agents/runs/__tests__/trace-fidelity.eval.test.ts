// Marketr — Phase 16 slice 11 evals: trace fidelity.
// Run: DATABASE_URL=postgresql://postgres@localhost:5434/marketr_16s8_test
//        npx tsx --test lib/agents/runs/__tests__/trace-fidelity.eval.test.ts
// Requires the phase-16 migrations on the scratch DB (agent_runs,
// agent_run_events, agent_run_recordings).
//
// Fidelity chain under test (slice 5 → slice 6 seams, stubbed browser):
//   recorder timeline events  →  appendAgentRunEvent (seq)  →
//   listAgentRunEvents (viewer order)  →  resolveRecordingAsset (artifacts)
//
// The eval proves: what the recorder emitted is what the timeline stores,
// in the same order, with contiguous seqs — and every timeline that claims
// artifacts can actually serve them from disk.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { prisma } from "@/lib/prisma";
import {
  AgentRunRecorder,
  ARTIFACT_ROOT,
  _activeRecordingCountForTests,
  type BrowserLauncher,
  type RecorderContext,
  type RecorderPage,
} from "../recorder";
import {
  createAgentRun,
  appendAgentRunEvent,
  attachAgentRunRecording,
  getAgentRun,
  listAgentRunEvents,
} from "../service";
import { resolveRecordingAsset } from "../artifacts";
import type { AgentRunEventInput } from "../types";

const WS = "16s11-trace-ws";

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

/** Stub launcher that leaves REAL trace + video files on disk. */
function stubLauncher(dir: string): BrowserLauncher {
  return {
    launch: async () => ({
      newContext: async () =>
        stubContext({
          tracingStop: async (tracePath: string) => {
            await fs.writeFile(tracePath, "fake-trace-bytes-16s11");
          },
          videoPath: async () => {
            const vp = path.join(dir, "video.webm");
            await fs.writeFile(vp, "fake-webm-bytes-16s11");
            return vp;
          },
        }),
      close: async () => undefined,
    }),
  };
}

const runIds: string[] = [];
const artifactDirs: string[] = [];

before(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({
    data: { id: WS, name: "16s11 trace fidelity", ownerUserId: "16s11-owner" },
  });
});

after(async () => {
  for (const id of runIds) {
    await fs.rm(path.join(ARTIFACT_ROOT, id), { recursive: true, force: true });
  }
  for (const d of artifactDirs) {
    await fs.rm(d, { recursive: true, force: true });
  }
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

/** Run the stubbed recorder and return its timeline + artifacts. */
async function recordTimeline(runId: string): Promise<{
  events: AgentRunEventInput[];
  tracePath: string;
  videoPath: string | null;
}> {
  const dir = path.join(ARTIFACT_ROOT, runId);
  const events: AgentRunEventInput[] = [];
  const rec = new AgentRunRecorder({
    runId,
    artifactDir: dir,
    launcher: stubLauncher(dir),
    onTimelineEvent: (e) => void events.push(e),
  });
  await rec.start("https://example.com/pricing");
  await rec.recordAction("Clicked pricing link", { selector: "#pricing" });
  await rec.recordAction("Scrolled to footer", { selector: "footer" });
  const stopped = await rec.stop();
  assert.equal(_activeRecordingCountForTests(), 0, "slot leaked");
  return { events, tracePath: stopped.tracePath, videoPath: stopped.videoPath };
}

describe("trace fidelity: recorded events ↔ timeline ordering", () => {
  it("recorder emission order is the timeline order (contiguous seqs)", async () => {
    const run = await createAgentRun({
      workspaceId: WS,
      kind: "browser",
      startedBy: "agent:eval-fidelity",
    });
    runIds.push(run.id);

    const { events } = await recordTimeline(run.id);
    assert.ok(events.length >= 4, `expected ≥4 timeline events, got ${events.length}`);

    // Persist exactly what the recorder emitted, in emission order.
    for (const e of events) {
      await appendAgentRunEvent(WS, run.id, e);
    }

    const timeline = await listAgentRunEvents(WS, run.id);
    assert.equal(timeline.length, events.length);

    // Seqs are contiguous from 0 and follow emission order.
    const seqs = timeline.map((t) => t.seq);
    assert.deepEqual(seqs, events.map((_, i) => i));

    // Every persisted event matches what the recorder emitted.
    for (let i = 0; i < events.length; i++) {
      assert.equal(timeline[i]!.summary, events[i]!.summary, `event ${i} summary drifted`);
      assert.equal(timeline[i]!.type, events[i]!.type, `event ${i} type drifted`);
    }

    // Browser action steps kept their step numbers through the chain. The
    // recorder emits start + 2 actions + stop, all type "browser"; only the
    // recordAction events carry a step number.
    const actions = timeline.filter(
      (t) => t.type === "browser" && (t.payload as { step?: number } | null)?.step !== undefined,
    );
    assert.equal(actions.length, 2);
    assert.equal((actions[0]!.payload as { step: number }).step, 1);
    assert.equal((actions[1]!.payload as { step: number }).step, 2);
  });

  it("concurrent appends still get contiguous seqs (atomic increment)", async () => {
    const run = await createAgentRun({
      workspaceId: WS,
      kind: "browser",
      startedBy: "agent:eval-fidelity",
    });
    runIds.push(run.id);

    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        appendAgentRunEvent(WS, run.id, { type: "note", summary: `concurrent-${i}` }),
      ),
    );
    const timeline = await listAgentRunEvents(WS, run.id);
    assert.equal(timeline.length, 5);
    assert.deepEqual(
      timeline.map((t) => t.seq).sort((a, b) => a - b),
      [0, 1, 2, 3, 4],
      "seqs must be a contiguous 0..4 even under concurrency",
    );
    assert.deepEqual(
      new Set(timeline.map((t) => t.summary)),
      new Set(["concurrent-0", "concurrent-1", "concurrent-2", "concurrent-3", "concurrent-4"]),
    );
  });

  it("appendAgentRunEvent refuses an empty summary (no silent timeline holes)", async () => {
    const run = await createAgentRun({
      workspaceId: WS,
      kind: "browser",
      startedBy: "agent:eval-fidelity",
    });
    runIds.push(run.id);
    await assert.rejects(
      appendAgentRunEvent(WS, run.id, { type: "note", summary: "   " }),
      /summary is required/,
    );
    const timeline = await listAgentRunEvents(WS, run.id);
    assert.equal(timeline.length, 0);
  });
});

describe("trace fidelity: timeline ↔ artifact existence", () => {
  it("a recording row's artifacts resolve to real files (trace + video)", async () => {
    const run = await createAgentRun({
      workspaceId: WS,
      kind: "browser",
      startedBy: "agent:eval-fidelity",
    });
    runIds.push(run.id);

    const { events, tracePath, videoPath } = await recordTimeline(run.id);
    assert.ok(videoPath, "stub launcher must produce a video path");
    for (const e of events) await appendAgentRunEvent(WS, run.id, e);

    await attachAgentRunRecording(WS, run.id, {
      videoPath,
      tracePath,
      stepCount: 2,
      sizeBytes: 100,
      retentionUntil: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    });

    const loaded = await getAgentRun(WS, run.id);
    assert.ok(loaded?.recording, "recording row must exist");
    assert.equal(loaded._count.events, events.length, "event count matches the timeline");

    const trace = await resolveRecordingAsset(WS, run.id, "trace");
    assert.ok(trace, "trace asset must resolve");
    assert.ok((trace.location.kind === "legacy" ? trace.location.absPath : trace.location.path).endsWith("trace.zip"));
    assert.ok(trace.sizeBytes > 0);
    assert.equal(trace.contentType, "application/zip");

    const video = await resolveRecordingAsset(WS, run.id, "video");
    assert.ok(video, "video asset must resolve");
    assert.equal(video.contentType, "video/webm");
  });

  it("a deleted artifact fails closed: the row stays, the asset 404s", async () => {
    const run = await createAgentRun({
      workspaceId: WS,
      kind: "browser",
      startedBy: "agent:eval-fidelity",
    });
    runIds.push(run.id);

    const { tracePath, videoPath } = await recordTimeline(run.id);
    await attachAgentRunRecording(WS, run.id, {
      videoPath,
      tracePath,
      stepCount: 2,
      sizeBytes: 100,
      retentionUntil: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    });

    // Disk truth changes (operator deleted the trace); the row still claims it.
    await fs.unlink(tracePath);
    const trace = await resolveRecordingAsset(WS, run.id, "trace");
    assert.equal(trace, null, "missing trace file must resolve to null (route → 404)");

    // The video still resolves — fidelity is per-asset, not all-or-nothing.
    const video = await resolveRecordingAsset(WS, run.id, "video");
    assert.ok(video, "video must still resolve when only the trace is gone");
  });

  it("a run with events but no recording has no artifacts (no phantom links)", async () => {
    const run = await createAgentRun({
      workspaceId: WS,
      kind: "mission",
      startedBy: "agent:eval-fidelity",
    });
    runIds.push(run.id);
    await appendAgentRunEvent(WS, run.id, { type: "agui", summary: "mission started" });

    const loaded = await getAgentRun(WS, run.id);
    assert.equal(loaded?.recording, null);
    assert.equal(await resolveRecordingAsset(WS, run.id, "trace"), null);
    assert.equal(await resolveRecordingAsset(WS, run.id, "video"), null);
  });
});
