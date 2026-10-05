// ShapesOS — Phase 8: queue / worker settings and the in-app worker decision (PURE).
// Run: env -u DATABASE_URL npx tsx --test lib/agents/queue/__tests__/config.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentWorkerConfig, agentWorkerMode, inAppWorkerDecision, inlineBudgetMs } from "../config";

describe("agent worker config", () => {
  it("defaults: internal worker, 45 s inline budget, 2 jobs, 60 s lease, 10 s heartbeat, 3 attempts", () => {
    assert.equal(agentWorkerMode({}), "internal");
    assert.equal(inlineBudgetMs({}), 45_000);
    assert.deepEqual(agentWorkerConfig({}), { concurrency: 2, pollMs: 1000, leaseMs: 60_000, heartbeatMs: 10_000, maxAttempts: 3 });
  });

  it("AGENT_WORKER=off never hands off; 0 queues every turn", () => {
    assert.equal(inlineBudgetMs({ AGENT_WORKER: "off" }), null);
    assert.equal(inlineBudgetMs({ AGENT_INLINE_BUDGET_SECONDS: "0" }), 0);
    assert.equal(agentWorkerMode({ AGENT_WORKER: "External" }), "external");
    assert.equal(agentWorkerMode({ AGENT_WORKER: "nonsense" }), "internal");
  });

  it("a heartbeat always lands well inside the lease", () => {
    const c = agentWorkerConfig({ AGENT_JOB_LEASE_SECONDS: "9", AGENT_JOB_HEARTBEAT_SECONDS: "30" });
    assert.equal(c.leaseMs, 9_000);
    assert.equal(c.heartbeatMs, 3_000);
  });

  it("in-app worker: not in tests, builds, edge, external/off, or without a database", () => {
    assert.equal(inAppWorkerDecision({ NODE_ENV: "test", DATABASE_URL: "x" }).start, false);
    assert.equal(inAppWorkerDecision({ NEXT_PHASE: "phase-production-build", DATABASE_URL: "x" }).start, false);
    assert.equal(inAppWorkerDecision({ NEXT_RUNTIME: "edge", DATABASE_URL: "x" }).start, false);
    assert.equal(inAppWorkerDecision({ AGENT_WORKER: "external", DATABASE_URL: "x" }).start, false);
    assert.equal(inAppWorkerDecision({}).start, false);
    assert.equal(inAppWorkerDecision({ NODE_ENV: "production", DATABASE_URL: "x" }).start, true);
  });
});
