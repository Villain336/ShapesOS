// ShapesOS — Phase 17 (latency, A6.2): asynchronous usage metering through
// the agent_jobs outbox, against Postgres as the least-privilege app role.
//   * the model call's path writes one outbox row and returns; the ledger
//     row lands in the background (flushUsageRecording awaits it);
//   * a crash between the ledger write and the run's usage event is retried
//     by a worker: ONE ledger row, ONE charge, ONE run usage event;
//   * a writer that died before processing (its claim's lease expired) is
//     finished by a worker — never lost;
//   * replaying the record again changes nothing (idempotent per call id);
//   * a 0-credit event is appended while another transaction holds the
//     balance row lock (no lock for 0-credit events);
//   * the cap check still refuses BEFORE the call (nothing sent, no row).
// No model is called: records are built directly (the adapters' record()
// passes the same shape).
// Run: DATABASE_URL=<app role> npx tsx --test lib/llm/__tests__/usage-outbox-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { createAgentRun, listAgentRunEvents } from "@/lib/agents/runs/service";
import { AgentWorker } from "@/lib/agents/queue/worker";
import { claimAgentJobById } from "@/lib/agents/queue/store";
import {
  LLM_USAGE_JOB_KIND,
  __setUsageAfterMeterHook,
  assertModelSpendAllowed,
  flushUsageRecording,
  llmCallCharge,
  processUsageRecord,
  recordChatUsage,
  usageIdempotencyKey,
  type ChatUsageRecord,
} from "../usage";
import { meter, setSpendCap } from "@/lib/metering/service";
import { LlmProviderError } from "../errors";

const RUN = randomUUID().slice(0, 8);
const WS = `p17uo-${RUN}`;
const WS_CAPPED = `p17uo-cap-${RUN}`;
const OWNER = `p17uo-owner-${RUN}`;
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

function rec(responseId: string, runId: string | null, over: Partial<ChatUsageRecord> = {}): ChatUsageRecord {
  return {
    context: { workspaceId: WS, runId },
    workload: "lead",
    provider: "anthropic",
    model: "claude-opus-5-5",
    usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 400 },
    costMicroUsd: 11_000,
    responseId,
    keySource: "platform",
    ...over,
  };
}

const used = async () => (await prisma.creditBalance.findUnique({ where: { workspaceId: WS } }))?.usedCredits ?? 0;
const ledger = (key: string) => prisma.usageEvent.findMany({ where: { idempotencyKey: key } });
const usageEvents = async (runId: string) => (await listAgentRunEvents(WS, runId)).filter((e) => e.type === "usage");
const outbox = () => withWorkspaceScope(WS, (tx) => tx.agentJob.findMany({ where: { workspaceId: WS, kind: LLM_USAGE_JOB_KIND } }));

async function drainWorker(): Promise<void> {
  const w = new AgentWorker({ log: quiet, leaseMs: 60_000, heartbeatMs: 10_000, concurrency: 4, kinds: [LLM_USAGE_JOB_KIND] });
  for (let i = 0; i < 10; i++) {
    const n = await w.tick();
    await w.drain();
    if (n === 0) return;
  }
}

before(async () => {
  for (const id of [WS, WS_CAPPED]) await prisma.workspace.create({ data: { id, name: id, ownerUserId: OWNER, plan: "starter" } });
});

after(async () => {
  __setUsageAfterMeterHook(null);
  for (const id of [WS, WS_CAPPED]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

describe("asynchronous usage metering (outbox)", () => {
  it("the call returns after the outbox write; the ledger row and the run event land in the background; the outbox row is gone", async () => {
    const run = await createAgentRun({ workspaceId: WS, kind: "chat", startedBy: OWNER });
    const r = rec(`msg_uo_${RUN}_1`, run.id);
    const before = await used();
    await recordChatUsage(r);
    await flushUsageRecording();
    const key = usageIdempotencyKey(r);
    const rows = await ledger(key);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.credits, llmCallCharge(r).credits);
    assert.equal((await used()) - before, llmCallCharge(r).credits);
    const ev = await usageEvents(run.id);
    assert.equal(ev.length, 1);
    assert.equal((ev[0]!.payload as { idempotencyKey?: string }).idempotencyKey, key);
    assert.equal((await outbox()).length, 0, "a processed outbox row is deleted");
  });

  it("a crash between the ledger write and the run event: the worker retries, one ledger row, one charge, one run event", async () => {
    const run = await createAgentRun({ workspaceId: WS, kind: "chat", startedBy: OWNER });
    const r = rec(`msg_uo_${RUN}_2`, run.id);
    const key = usageIdempotencyKey(r);
    const before = await used();
    let crashes = 0;
    __setUsageAfterMeterHook(() => {
      crashes++;
      throw new Error("simulated crash after the ledger write");
    });
    await recordChatUsage(r);
    await flushUsageRecording();
    __setUsageAfterMeterHook(null);
    assert.equal(crashes, 1);
    assert.equal((await ledger(key)).length, 1, "the ledger row was written before the crash");
    assert.equal((await usageEvents(run.id)).length, 0, "the run event was not");
    const jobs = await outbox();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.status, "queued", "re-queued for a worker");
    // The worker picks it up (skip the backoff).
    await withWorkspaceScope(WS, (tx) => tx.agentJob.update({ where: { id: jobs[0]!.id }, data: { runAfter: new Date(Date.now() - 1000) } }));
    await drainWorker();
    assert.equal((await ledger(key)).length, 1, "never double-counted");
    assert.equal((await used()) - before, llmCallCharge(r).credits, "charged exactly once");
    assert.equal((await usageEvents(run.id)).length, 1, "the run event exactly once");
    assert.equal((await outbox())[0]?.status, "succeeded");
    // A replay of the same record (a second worker, a retried job) changes nothing.
    await processUsageRecord(r, key);
    assert.equal((await ledger(key)).length, 1);
    assert.equal((await used()) - before, llmCallCharge(r).credits);
    assert.equal((await usageEvents(run.id)).length, 1);
  });

  it("a writer that died after claiming its row (lease expired) is finished by a worker — the record is never lost", async () => {
    const r = rec(`msg_uo_${RUN}_3`, null);
    const key = usageIdempotencyKey(r);
    const { enqueueAgentJob } = await import("@/lib/agents/queue/store");
    const { id } = await enqueueAgentJob({ workspaceId: WS, kind: LLM_USAGE_JOB_KIND, payload: { record: r, idempotencyKey: key } });
    const claimed = await claimAgentJobById(WS, id, "dead-writer", 60_000);
    assert.ok(claimed, "the writer claimed its row");
    assert.equal(await claimAgentJobById(WS, id, "second-writer", 60_000), null, "a claimed row is claimed once");
    // …and died: its lease passes.
    await withWorkspaceScope(WS, (tx) => tx.agentJob.update({ where: { id }, data: { leaseUntil: new Date(Date.now() - 1000) } }));
    assert.equal((await ledger(key)).length, 0);
    await drainWorker();
    assert.equal((await ledger(key)).length, 1);
    await drainWorker();
    assert.equal((await ledger(key)).length, 1, "processed once");
  });

  it("concurrent replays of one call charge once", async () => {
    const r = rec(`msg_uo_${RUN}_4`, null);
    const key = usageIdempotencyKey(r);
    const before = await used();
    await Promise.all([processUsageRecord(r, key), processUsageRecord(r, key), processUsageRecord(r, key)]);
    assert.equal((await ledger(key)).length, 1);
    assert.equal((await used()) - before, llmCallCharge(r).credits);
  });

  it("a 0-credit event is appended while the balance row is locked (no lock for 0-credit events)", async () => {
    // Make sure the balance row exists, then hold its lock in another transaction.
    await meter({ workspaceId: WS, action: "llm_tokens", credits: 1, idempotencyKey: `uo-seed-${RUN}`, afterTheFact: true });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM credit_balances WHERE workspace_id = ${WS} FOR UPDATE`;
        locked();
        await held;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    await isLocked;
    const t0 = Date.now();
    const free = await meter({ workspaceId: WS, action: "llm_tokens", credits: 0, keySource: "workspace", waivedCredits: 2, idempotencyKey: `uo-byok-${RUN}`, afterTheFact: true });
    const took = Date.now() - t0;
    assert.ok(free.ok && free.charged === 0);
    assert.ok(took < 2_000, `the 0-credit event did not wait for the lock (${took} ms)`);
    // A charged event DOES wait for the lock (serialised, as before).
    let chargedDone = false;
    const charged = meter({ workspaceId: WS, action: "llm_tokens", credits: 3, idempotencyKey: `uo-charged-${RUN}`, afterTheFact: true }).then((r) => ((chargedDone = true), r));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(chargedDone, false, "a charged event serialises on the balance lock");
    release();
    await holder;
    assert.equal((await charged).ok, true);
  });

  it("the cap check still refuses BEFORE the call (nothing recorded)", async () => {
    await setSpendCap(WS_CAPPED, { capCredits: 0, blockAtCap: true });
    await assert.rejects(
      assertModelSpendAllowed({ workspaceId: WS_CAPPED }, "platform", "anthropic"),
      (e: unknown) => e instanceof LlmProviderError && e.kind === "cap_exceeded",
    );
    assert.equal(await prisma.usageEvent.count({ where: { workspaceId: WS_CAPPED } }), 0);
  });
});
