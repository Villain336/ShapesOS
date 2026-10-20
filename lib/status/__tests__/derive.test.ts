// ShapesOS — public status page (WS=legal): component health is DERIVED from
// the live signals /api/health and the agent queue already expose, by pure
// rules with stated thresholds; an operator's manual state overrides the
// derived one and says why. Pure (no DB).
// Run: npx tsx --test lib/status/__tests__/derive.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_COMPONENTS,
  HEARTBEAT_STALE_MS,
  QUEUE_DEGRADED_MS,
  QUEUE_OUTAGE_MS,
  deriveComponents,
  overallStatus,
  type LiveSignals,
} from "../derive";

const healthy: LiveSignals = {
  readiness: { status: "ok", checks: { database: { status: "ok", latencyMs: 4 }, migrations: { status: "ok", pending: 0, failed: 0 } } },
  worker: { mode: "external", runningJobs: 2, lastHeartbeatMs: 3_000 },
  queue: { depth: 1, oldestQueuedMs: 10_000, deadJobs24h: 0 },
};

const states = (s: LiveSignals, overrides = {}) => Object.fromEntries(deriveComponents(s, overrides).map((c) => [c.key, c.state]));

describe("status derivation", () => {
  it("names the four components the brief asks for, in order", () => {
    assert.deepEqual(DEFAULT_COMPONENTS.map((c) => c.key), ["web", "database", "worker", "queue"]);
  });

  it("a healthy install is operational everywhere", () => {
    assert.deepEqual(states(healthy), { web: "operational", database: "operational", worker: "operational", queue: "operational" });
    assert.equal(overallStatus(deriveComponents(healthy, {})), "operational");
  });

  it("database down is a major outage of the database and degrades the web", () => {
    const s: LiveSignals = { ...healthy, readiness: { status: "unavailable", checks: { database: { status: "fail", latencyMs: null }, migrations: { status: "unknown", pending: null, failed: null } } } };
    const st = states(s);
    assert.equal(st.database, "major_outage");
    assert.equal(st.web, "degraded");
    assert.equal(overallStatus(deriveComponents(s, {})), "major_outage");
  });

  it("pending or failed migrations degrade the database; draining degrades the web", () => {
    const mig: LiveSignals = { ...healthy, readiness: { status: "unavailable", checks: { database: { status: "ok", latencyMs: 3 }, migrations: { status: "fail", pending: 2, failed: 0 } } } };
    assert.equal(states(mig).database, "degraded");
    const drain: LiveSignals = { ...healthy, readiness: { ...healthy.readiness!, status: "unavailable", draining: true } };
    assert.equal(states(drain).web, "degraded");
    assert.equal(states(drain).database, "operational");
  });

  it("the worker: idle with an empty queue is operational; a stale heartbeat while jobs run is degraded; due work with no worker at all is an outage", () => {
    const idle: LiveSignals = { ...healthy, worker: { mode: "external", runningJobs: 0, lastHeartbeatMs: null }, queue: { depth: 0, oldestQueuedMs: null, deadJobs24h: 0 } };
    assert.equal(states(idle).worker, "operational");
    const stale: LiveSignals = { ...healthy, worker: { mode: "external", runningJobs: 1, lastHeartbeatMs: HEARTBEAT_STALE_MS + 1 } };
    assert.equal(states(stale).worker, "degraded");
    const dead: LiveSignals = { ...healthy, worker: { mode: "external", runningJobs: 0, lastHeartbeatMs: null }, queue: { depth: 5, oldestQueuedMs: QUEUE_OUTAGE_MS + 1, deadJobs24h: 0 } };
    assert.equal(states(dead).worker, "major_outage");
    const off: LiveSignals = { ...healthy, worker: { mode: "off", runningJobs: 0, lastHeartbeatMs: null } };
    assert.equal(states(off).worker, "maintenance");
  });

  it("the queue: waits under 2 minutes are fine, under 15 degraded, longer a partial outage", () => {
    assert.equal(QUEUE_DEGRADED_MS, 2 * 60_000);
    assert.equal(QUEUE_OUTAGE_MS, 15 * 60_000);
    const q = (oldestQueuedMs: number | null, depth = 3) => states({ ...healthy, queue: { depth, oldestQueuedMs, deadJobs24h: 0 } }).queue;
    assert.equal(q(null, 0), "operational");
    assert.equal(q(60_000), "operational");
    assert.equal(q(QUEUE_DEGRADED_MS + 1), "degraded");
    assert.equal(q(QUEUE_OUTAGE_MS + 1), "partial_outage");
  });

  it("an operator's manual state overrides the derived one and carries its note", () => {
    const rows = deriveComponents(healthy, { database: { state: "maintenance", note: "Planned failover 02:00 UTC" } });
    const db = rows.find((c) => c.key === "database")!;
    assert.equal(db.state, "maintenance");
    assert.equal(db.manual, true);
    assert.equal(db.note, "Planned failover 02:00 UTC");
    assert.equal(rows.find((c) => c.key === "web")!.manual, false);
    assert.equal(overallStatus(rows), "maintenance");
  });

  it("missing signals are unknown, never operational", () => {
    const st = states({ readiness: null, worker: null, queue: null });
    assert.deepEqual(st, { web: "unknown", database: "unknown", worker: "unknown", queue: "unknown" });
    assert.equal(overallStatus(deriveComponents({ readiness: null, worker: null, queue: null }, {})), "unknown");
  });

  it("overall is the worst component", () => {
    const rows = deriveComponents({ ...healthy, queue: { depth: 9, oldestQueuedMs: QUEUE_DEGRADED_MS + 1, deadJobs24h: 1 } }, {});
    assert.equal(overallStatus(rows), "degraded");
  });
});
