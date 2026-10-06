// Marketr — Phase 16 slice 5 tests: agent run persistence + RLS battery.
// Integration: hits a scratch Postgres DB (slice5_scratch) that carries the
// phase-16 migration, exercising the same withWorkspaceScope code paths the
// service uses. Mirrors lib/intelligence/company/__tests__/knowledge-rls.test.ts.
// Run: DATABASE_URL="postgresql://<user>:<pw>@localhost:5433/slice5_scratch" \
//        npx tsx --test lib/agents/runs/__tests__/runs-rls.test.ts
// Requires the 20260929120703_phase16_agent_runs migration applied to the DB.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope, countWithoutScope } from "@/lib/substrate/memory/rls";
import {
  createAgentRun,
  markAgentRunRunning,
  appendAgentRunEvent,
  attachAgentRunRecording,
  finishAgentRun,
  getAgentRun,
  listAgentRunEvents,
} from "../service";
import { executeBrowserRun } from "../lifecycle";
import type { BrowserLauncher } from "../recorder";

const WS_A = "16s5-ws-a";
const WS_B = "16s5-ws-b";

before(async () => {
  for (const id of [WS_A, WS_B]) {
    await prisma.workspace.deleteMany({ where: { id } });
    await prisma.workspace.create({
      data: { id, name: `16s5 ${id}`, ownerUserId: "16s5-owner" },
    });
  }
});

after(async () => {
  for (const id of [WS_A, WS_B]) {
    await prisma.workspace.deleteMany({ where: { id } });
  }
  await prisma.$disconnect();
});

/** Stub launcher: no browser, no files — lifecycle still persists everything. */
const stubLauncher: BrowserLauncher = {
  launch: async () => ({
    newContext: async () => ({
      tracingStart: async () => undefined,
      // Like Playwright: stopping the trace writes trace.zip (deploy PR: the
      // lifecycle then publishes it to shared storage).
      tracingStop: async (tracePath: string) => {
        const { promises: fs } = await import("node:fs");
        await fs.writeFile(tracePath, "fake-trace-bytes");
      },
      newPage: async () => ({ goto: async () => undefined }),
      close: async () => undefined,
      videoPath: async () => null,
    }),
    close: async () => undefined,
  }),
};

describe("agent run persistence + RLS (scratch DB)", () => {
  it("creates a run linked to thread/mission inside its own scope", async () => {
    const run = await createAgentRun({
      workspaceId: WS_A,
      kind: "browser",
      startedBy: "agent:test",
      threadId: "thread-1",
      missionId: "mission-1",
    });
    assert.ok(run.id);
    assert.equal(run.status, "queued");
    assert.equal(run.threadId, "thread-1");
    assert.equal(run.missionId, "mission-1");

    const seen = await getAgentRun(WS_A, run.id);
    assert.ok(seen);
    assert.equal(seen!.kind, "browser");

    const seenFromB = await getAgentRun(WS_B, run.id);
    assert.equal(seenFromB, null, "workspace B must not see A's run");
  });

  it("assigns strictly ordered seq numbers to the timeline", async () => {
    const run = await createAgentRun({
      workspaceId: WS_A,
      kind: "mission",
      startedBy: "agent:test",
    });
    await appendAgentRunEvent(WS_A, run.id, { type: "agui", summary: "RUN_STARTED" });
    await appendAgentRunEvent(WS_A, run.id, { type: "browser", summary: "navigated", payload: { step: 1 } });
    await appendAgentRunEvent(WS_A, run.id, { type: "gate", summary: "approval requested" });
    await appendAgentRunEvent(WS_A, run.id, { type: "note", summary: "operator note" });

    const events = await listAgentRunEvents(WS_A, run.id);
    assert.deepEqual(events.map((e) => e.seq), [0, 1, 2, 3]);
    assert.deepEqual(events.map((e) => e.type), ["agui", "browser", "gate", "note"]);
    assert.equal(events[1]!.summary, "navigated");

    const fromB = await listAgentRunEvents(WS_B, run.id);
    assert.equal(fromB.length, 0, "workspace B must not see A's timeline");
  });

  it("is invisible without the GUC (fail-closed) on all three tables", async () => {
    assert.equal(await countWithoutScope("agent_runs"), 0);
    assert.equal(await countWithoutScope("agent_run_recordings"), 0);
    assert.equal(await countWithoutScope("agent_run_events"), 0);
  });

  it("blocks cross-workspace INSERT (RLS WITH CHECK)", async () => {
    await assert.rejects(
      withWorkspaceScope(WS_A, (tx) =>
        tx.agentRun.create({
          data: {
            workspaceId: WS_B, // lying about the tenant
            kind: "browser",
            startedBy: "agent:smuggle",
          },
        }),
      ),
      "cross-workspace run INSERT must be rejected by RLS",
    );
    await assert.rejects(
      withWorkspaceScope(WS_A, (tx) =>
        tx.agentRunEvent.create({
          data: {
            workspaceId: WS_B,
            runId: "nope",
            seq: 0,
            type: "note",
            summary: "smuggled",
          },
        }),
      ),
      "cross-workspace event INSERT must be rejected by RLS",
    );
  });

  it("makes unscoped UPDATE a no-op under FORCE RLS", async () => {
    const run = await createAgentRun({ workspaceId: WS_A, kind: "playbook", startedBy: "agent:test" });
    const touched = await prisma.agentRun.updateMany({
      where: { id: run.id },
      data: { status: "cancelled" },
    });
    assert.equal(touched.count, 0, "unscoped UPDATE must touch zero rows");
    const still = await getAgentRun(WS_A, run.id);
    assert.equal(still!.status, "queued");
  });

  it("rejects events on another workspace's run (P2025, fail-closed)", async () => {
    const run = await createAgentRun({ workspaceId: WS_A, kind: "browser", startedBy: "agent:test" });
    await assert.rejects(
      appendAgentRunEvent(WS_B, run.id, { type: "note", summary: "injection" }),
      "appending to another workspace's run must fail",
    );
  });

  it("finishAgentRun only accepts terminal statuses", async () => {
    const run = await createAgentRun({ workspaceId: WS_A, kind: "browser", startedBy: "agent:test" });
    await assert.rejects(finishAgentRun(WS_A, run.id, "running"), /not a terminal status/);
    const done = await finishAgentRun(WS_A, run.id, "succeeded");
    assert.equal(done.status, "succeeded");
    assert.ok(done.endedAt);
  });

  it("executeBrowserRun wires the full lifecycle: run → events → recording → finish", async () => {
    const result = await executeBrowserRun(
      {
        workspaceId: WS_A,
        startedBy: "agent:turn-7",
        threadId: "thread-7",
        startUrl: "https://example.com",
      },
      {
        launcher: stubLauncher,
        execute: async ({ recordAction }) => {
          await recordAction("Clicked 'Sign in'", { selector: "#signin" });
          return { result: { ok: true } };
        },
      },
    );
    assert.equal(result.status, "succeeded");
    assert.equal(result.stepCount, 1);
    assert.ok(result.tracePath?.endsWith("trace.zip"));

    const run = await getAgentRun(WS_A, result.runId);
    assert.ok(run);
    assert.equal(run!.status, "succeeded");
    assert.equal(run!.threadId, "thread-7");
    assert.ok(run!.endedAt);
    assert.ok(run!.recording);
    assert.equal(run!.recording!.tracePath, result.tracePath);
    assert.equal(run!.recording!.stepCount, 1);
    assert.ok(run!.recording!.retentionUntil.getTime() > Date.now(), "retention set in the future");

    const events = await listAgentRunEvents(WS_A, result.runId);
    const seqs = events.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "timeline strictly ordered");
    assert.equal(new Set(seqs).size, seqs.length, "seq unique per run");
    const summaries = events.map((e) => e.summary).join("\n");
    assert.match(summaries, /Browser run requested/);
    assert.match(summaries, /recording started/);
    assert.match(summaries, /Clicked 'Sign in'/);
    assert.match(summaries, /recording stopped/);
    assert.match(summaries, /Browser run finished/);
    assert.ok(events.some((e) => e.type === "agui"), "agui events present");
    assert.ok(events.some((e) => e.type === "browser"), "browser events present");
  });

  it("executeBrowserRun finishes failed, keeps the trace, and rethrows", async () => {
    let capturedRunId = "";
    await assert.rejects(
      executeBrowserRun(
        { workspaceId: WS_A, startedBy: "agent:turn-8", threadId: "thread-8" },
        {
          launcher: stubLauncher,
          execute: async () => {
            throw new Error("page crashed");
          },
        },
      ).then((r) => {
        capturedRunId = r.runId;
        return r;
      }),
      /page crashed/,
    );

    // Recover the run id via the thread linkage.
    const runs = await withWorkspaceScope(WS_A, (tx) =>
      tx.agentRun.findMany({ where: { workspaceId: WS_A, threadId: "thread-8" } }),
    );
    assert.equal(runs.length, 1);
    capturedRunId = runs[0]!.id;

    const run = await getAgentRun(WS_A, capturedRunId);
    assert.equal(run!.status, "failed");
    const events = await listAgentRunEvents(WS_A, capturedRunId);
    assert.ok(events.some((e) => e.type === "note" && /page crashed/.test(e.summary)));
    assert.ok(run!.recording, "failed run keeps its recording row");
  });

  it("attachAgentRunRecording upserts (idempotent re-attach)", async () => {
    const run = await createAgentRun({ workspaceId: WS_A, kind: "browser", startedBy: "agent:test" });
    await markAgentRunRunning(WS_A, run.id);
    const first = await attachAgentRunRecording(WS_A, run.id, {
      videoPath: null,
      tracePath: "/tmp/a/trace.zip",
      stepCount: 3,
      sizeBytes: 100,
      retentionUntil: new Date(Date.now() + 30 * 86400_000),
    });
    const second = await attachAgentRunRecording(WS_A, run.id, {
      videoPath: "/tmp/a/video.webm",
      tracePath: "/tmp/a/trace.zip",
      stepCount: 5,
      sizeBytes: 500,
      retentionUntil: first.retentionUntil,
    });
    assert.equal(first.id, second.id, "same recording row, updated");
    assert.equal(second.stepCount, 5);
    assert.equal(second.videoPath, "/tmp/a/video.webm");
  });
});
