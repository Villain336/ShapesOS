// ShapesOS — Phase 17 (A4, WS=model): the Message Batches path end to end
// against Postgres: llm_batch_jobs (FORCE RLS) + the real agent queue and
// AgentWorker + the real Anthropic adapter, talking HTTP to a scripted FAKE
// Messages/Batches API (lib/llm/__tests__/fake-anthropic.ts — MOCK).
//
//   submit → (worker A) provider batch created → worker A "dies" holding the
//   poll job → (worker B) reclaims it after the lease, polls, reads the
//   results, delivers the nightly learning pass ONCE (a lesson is written),
//   records llm_tokens at the batch tier (50%) — and a second submit of the
//   same night is the same row (no second batch).
// Run: DATABASE_URL=… npx tsx --test lib/llm/__tests__/batch-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { AgentWorker } from "@/lib/agents/queue/worker";
import { submitLlmBatch } from "../batch";
import "../batch-purposes";
import { startFakeAnthropic, type FakeAnthropic } from "./fake-anthropic";

const RUN = `p17b-${Date.now().toString(36)}`;
const WS = `${RUN}-ws`;
let fake: FakeAnthropic;
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

const LESSON = "Posts that lead with a customer number get twice the replies of feature lists.";
const OUTPUT = JSON.stringify({ lessons: [{ hypothesis: LESSON, confidence: 0.8, result: "worked", evidence: [] }], voiceProposal: null, knowledge: [], styleRules: [] });

before(async () => {
  // Anthropic-only: single-key mode routes the background workload to claude-haiku-4-5.
  fake = await startFakeAnthropic({ agentWorker: "external" });
  await prisma.workspace.create({ data: { id: WS, name: `P17 batch ${RUN}`, ownerUserId: `${RUN}-user` } });
});

after(async () => {
  await fake.close();
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

const jobs = () => withWorkspaceScope(WS, (tx) => tx.agentJob.findMany({ where: { workspaceId: WS, kind: "llm_batch" }, orderBy: { createdAt: "asc" } }));
const row = (id: string) => withWorkspaceScope(WS, (tx) => tx.llmBatchJob.findFirst({ where: { id, workspaceId: WS } }));

describe("Message Batches through the real queue (fake Anthropic API)", () => {
  it("submit → worker restart mid-way → delivered once, metered at the batch tier, idempotent per night", async () => {
    fake.batchEndsAfterPolls = 1;
    fake.script = (body) => {
      assert.equal(body.model, "claude-haiku-4-5");
      return { text: OUTPUT, usage: { input_tokens: 2000, output_tokens: 400 } };
    };
    const key = `learning_pass:${RUN}`;
    const s = await submitLlmBatch({
      workspaceId: WS,
      purpose: "learning_pass",
      idempotencyKey: key,
      workload: "background",
      requests: [{ customId: "pass", prompt: "Extract lessons from these episodes …", maxTokens: 2048 }],
      context: { dateLabel: "2026-10-06" },
    });
    assert.equal(s.created, true);

    // Worker A: submits the batch, queues the first poll (60 s out).
    const a = new AgentWorker({ log: quiet, leaseMs: 60_000, heartbeatMs: 10_000, concurrency: 2, kinds: ["llm_batch"] });
    await a.tick();
    await a.drain();
    const afterSubmit = await row(s.id);
    assert.equal(afterSubmit?.status, "submitted");
    assert.match(afterSubmit?.providerBatchId ?? "", /^msgbatch_fake_/);
    assert.equal(fake.batches.size, 1);

    // Worker A "dies" while holding the poll job: running, lease expired.
    const poll = (await jobs()).find((j) => j.status === "queued");
    assert.ok(poll, "the poll job is queued");
    await withWorkspaceScope(WS, (tx) =>
      tx.agentJob.update({ where: { id: poll!.id }, data: { status: "running", lockedBy: "dead-worker", leaseUntil: new Date(Date.now() - 1000), runAfter: new Date(Date.now() - 1000), attempts: 1 } }),
    );

    // Worker B (a fresh process): reclaims the orphaned job, polls, delivers.
    const b = new AgentWorker({ log: quiet, leaseMs: 60_000, heartbeatMs: 10_000, concurrency: 2, kinds: ["llm_batch"] });
    for (let i = 0; i < 5; i++) {
      await b.tick();
      await b.drain();
      if ((await row(s.id))?.status === "delivered") break;
    }
    const done = await row(s.id);
    assert.equal(done?.status, "delivered", done?.lastError ?? "");
    assert.equal(fake.batches.size, 1, "never resubmitted");
    assert.deepEqual(done?.results, { pass: { text: OUTPUT } });

    // Delivered once: exactly one lesson from the pass.
    const lessons = await withWorkspaceScope(WS, (tx) => tx.memoryLearning.findMany({ where: { workspaceId: WS } }));
    assert.equal(lessons.filter((l) => l.hypothesis === LESSON).length, 1);

    // Metered at the batch tier: Haiku 2000×1 + 400×5 = 4000 µ$ → 2000 at 50%.
    const ev = await prisma.usageEvent.findMany({ where: { workspaceId: WS, action: "llm_tokens" } });
    assert.equal(ev.length, 1);
    assert.equal(ev[0].llmServiceTier, "batch");
    assert.equal(Number(ev[0].llmCostMicroUsd), 2000);
    assert.equal(ev[0].llmWorkload, "background");

    // Same night again: the same row, no new job, no new batch.
    const again = await submitLlmBatch({ workspaceId: WS, purpose: "learning_pass", idempotencyKey: key, workload: "background", requests: [{ customId: "pass", prompt: "x", maxTokens: 10 }] });
    assert.equal(again.id, s.id);
    assert.equal(again.created, false);
    assert.equal(fake.batches.size, 1);
  });

  it("RLS: another workspace's scope sees no batch rows", async () => {
    const seen = await withWorkspaceScope(`${RUN}-other`, (tx) => tx.llmBatchJob.findMany({ where: {} }));
    assert.equal(seen.length, 0);
  });
});
