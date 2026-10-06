// ShapesOS — Phase 16: when the app starts its delegation-only worker.
// With AGENT_WORKER=off nothing else would run sub-agents; never in tests,
// builds, the edge runtime, or without a database; never when a real worker
// (internal / external) already runs agent jobs.
// Run: npx tsx --test lib/agents/delegation/__tests__/local-worker.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DELEGATION_JOB_KINDS, localDelegationWorkerDecision } from "../local-worker";

const base = { AGENT_WORKER: "off", DATABASE_URL: "postgres://x" };

describe("localDelegationWorkerDecision", () => {
  it("starts only with AGENT_WORKER=off, a database, on Node, outside tests and builds", () => {
    assert.deepEqual(localDelegationWorkerDecision(base), { start: true });
    assert.equal(localDelegationWorkerDecision({ ...base, AGENT_WORKER: "internal" }).start, false);
    assert.equal(localDelegationWorkerDecision({ ...base, AGENT_WORKER: "external" }).start, false);
    assert.equal(localDelegationWorkerDecision({ DATABASE_URL: "postgres://x" }).start, false, "default is internal");
    assert.equal(localDelegationWorkerDecision({ ...base, DATABASE_URL: "" }).start, false);
    assert.equal(localDelegationWorkerDecision({ ...base, NODE_ENV: "test" }).start, false);
    assert.equal(localDelegationWorkerDecision({ ...base, NODE_TEST_CONTEXT: "child-v8" }).start, false);
    assert.equal(localDelegationWorkerDecision({ ...base, NEXT_PHASE: "phase-production-build" }).start, false);
    assert.equal(localDelegationWorkerDecision({ ...base, NEXT_RUNTIME: "edge" }).start, false);
  });

  it("claims only the delegation job kinds and the usage outbox (never a chat turn or a mission)", () => {
    // Phase 17: llm_usage — metering rows a process wrote but could not finish.
    assert.deepEqual([...DELEGATION_JOB_KINDS], ["subagent_run", "delegation_tick", "delegation_join", "llm_usage"]);
  });
});
