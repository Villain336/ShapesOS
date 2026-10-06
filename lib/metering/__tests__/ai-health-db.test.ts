// ShapesOS — Phase 17 (observability, WS=model) against Postgres: the "AI
// cost & speed" numbers come from the llm_tokens ledger rows (written through
// the real meter()), and the cache-health alert notifies the workspace's
// admins once per day when the 24 h cache-read share is under 60%.
// Run: DATABASE_URL=… npx tsx --test lib/metering/__tests__/ai-health-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { meter } from "@/lib/metering/service";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { cacheAlertDue, cacheReadShare, getAiCostSpeed, sweepCacheHealth, workspacesWithLlmCalls } from "../ai-health";

const RUN = `p17h-${Date.now().toString(36)}`;
const WS = `${RUN}-ws`;
const OWNER = `${RUN}-owner`;
let seq = 0;

async function call(opts: { cost: number; input: number; read: number; write?: number; ttft?: number | null; dur?: number; model?: string; runId?: string }) {
  const r = await meter({
    workspaceId: WS,
    action: "llm_tokens",
    credits: 0,
    afterTheFact: true,
    idempotencyKey: `llm:test:${RUN}:${++seq}`,
    evidenceRef: opts.runId ? `agent_run:${opts.runId}` : null,
    llm: {
      provider: "anthropic",
      model: opts.model ?? "claude-opus-5-5",
      workload: "lead",
      inputTokens: opts.input,
      outputTokens: 100,
      cacheReadTokens: opts.read,
      cacheWriteTokens: opts.write ?? 0,
      costMicroUsd: opts.cost,
      ttftMs: opts.ttft === undefined ? 400 : opts.ttft,
      durationMs: opts.dur ?? 2000,
      effort: "medium",
      cacheHit: opts.read > 0,
      serviceTier: "standard",
    },
  });
  assert.equal(r.ok, true);
}

before(async () => {
  await prisma.workspace.create({ data: { id: WS, name: `P17 health ${RUN}`, ownerUserId: OWNER } });
});

// usage_events is append-only (T5 trigger): like the other ledger suites,
// the rows stay, under a workspace id unique to this run.
after(async () => {
  await prisma.$disconnect();
});

describe("pure", () => {
  it("cache share and the alert threshold (60%, with a traffic floor)", () => {
    assert.equal(cacheReadShare({ input: 0, cacheRead: 0, cacheWrite: 0 }), null);
    assert.equal(cacheReadShare({ input: 20, cacheRead: 80, cacheWrite: 0 }), 0.8);
    assert.equal(cacheAlertDue({ calls: 50, input: 60_000, cacheRead: 30_000, cacheWrite: 10_000 }), true);
    assert.equal(cacheAlertDue({ calls: 50, input: 20_000, cacheRead: 80_000, cacheWrite: 0 }), false, "80% is healthy");
    assert.equal(cacheAlertDue({ calls: 3, input: 60_000, cacheRead: 0, cacheWrite: 0 }), false, "too few calls to judge");
    assert.equal(cacheAlertDue({ calls: 50, input: 1000, cacheRead: 0, cacheWrite: 0 }), false, "too few tokens to judge");
  });
});

describe("AI cost & speed (DB)", () => {
  it("sums cost per day, cache hits, p50/p95 first token, by model and the top runs from the ledger", async () => {
    const run = await withWorkspaceScope(WS, (tx) =>
      tx.agentRun.create({ data: { workspaceId: WS, kind: "chat", startedBy: OWNER, agentKey: "lead", agentState: { prompt: "Plan the launch" } } }),
    );
    await call({ cost: 50_000, input: 20_000, read: 0, write: 18_000, ttft: 900, dur: 4000, runId: run.id });
    for (let i = 0; i < 9; i++) await call({ cost: 2_000, input: 300, read: 18_000, ttft: 300 + i * 10, dur: 1500, runId: run.id });
    await call({ cost: 1_000, input: 500, read: 0, ttft: null, dur: 800, model: "claude-haiku-4-5" });

    const d = await getAiCostSpeed(WS, { days: 7 });
    assert.equal(d.calls, 11);
    assert.equal(d.costMicroUsd, 50_000 + 9 * 2_000 + 1_000);
    assert.equal(d.perDay.length, 1, "one UTC day of traffic");
    assert.equal(d.perDay[0].calls, 11);
    assert.equal(Math.round(d.cacheHitPct! * 100), Math.round((9 / 11) * 100));
    assert.equal(d.ttftP50Ms, 345, "the median of the 10 streamed calls (300…380 and 900; the null ttft is excluded)");
    assert.ok(d.ttftP95Ms! >= 380 && d.ttftP95Ms! <= 900);
    assert.equal(d.durationP50Ms, 1500);
    assert.deepEqual(d.byModel.map((m) => m.model), ["claude-opus-5-5", "claude-haiku-4-5"]);
    assert.equal(d.topRuns[0].runId, run.id);
    assert.equal(d.topRuns[0].costMicroUsd, 68_000);
    assert.equal(d.topRuns[0].label, "Plan the launch");
    // 24 h share: 162,000 read of 203,200 input tokens ≈ 80%.
    assert.equal(Math.round(d.cacheReadShare24h! * 100), 80);
    assert.equal(d.cacheReadShare24h, d.cacheReadShare);
    assert.ok((await workspacesWithLlmCalls()).includes(WS));
  });

  it("the cache-health sweep notifies the admins once per day when the 24 h share is under 60%", async () => {
    const healthy = await sweepCacheHealth(WS);
    assert.equal(healthy.alerted, false, "healthy so far");
    for (let i = 0; i < 12; i++) await call({ cost: 30_000, input: 15_000, read: 0, write: 14_000 });
    const low = await sweepCacheHealth(WS);
    assert.ok(low.share24h! < 0.6, String(low.share24h));
    assert.equal(low.alerted, true);
    const notes = await prisma.notification.findMany({ where: { workspaceId: WS, userId: OWNER } });
    assert.equal(notes.length, 1);
    assert.match(notes[0].title, /Model cache reads fell to \d+%/);
    assert.equal(notes[0].href, "/dashboard/settings/usage#ai-cost-speed");
    const again = await sweepCacheHealth(WS);
    assert.equal(again.alerted, false, "once per day (dedup key)");
    assert.equal(await prisma.notification.count({ where: { workspaceId: WS, userId: OWNER } }), 1);
  });
});
