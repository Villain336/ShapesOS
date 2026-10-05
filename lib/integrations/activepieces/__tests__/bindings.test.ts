// ShapesOS — Phase 1 (H6) tests: Activepieces flows/runs are bound to the
// workspace. Pure: in-memory binding store + stub engine.
// Run: npx tsx --test lib/integrations/activepieces/__tests__/bindings.test.ts

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  bindFlowToWorkspace,
  FlowBindingConflictError,
  FlowNotBoundError,
  workspaceFlows,
  type FlowBindingStore,
  type FlowEngine,
} from "../bindings";
import type { ActivepiecesFlow, ActivepiecesFlowRun } from "../types";

const A = "ws_a";
const B = "ws_b";

function memStore(): FlowBindingStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>(); // flowId → workspaceId
  return {
    rows,
    async isBound(ws, flowId) { return rows.get(flowId) === ws; },
    async listFlowIds(ws) { return [...rows].filter(([, w]) => w === ws).map(([f]) => f); },
    async ownerOf(flowId) { return rows.get(flowId) ?? null; },
    async bind(ws, flowId) {
      if (rows.has(flowId)) throw Object.assign(new Error("unique"), { code: "P2002" });
      rows.set(flowId, ws);
    },
    async unbind(ws, flowId) { return rows.get(flowId) === ws ? rows.delete(flowId) : false; },
  };
}

function flow(id: string): ActivepiecesFlow {
  return {
    id, displayName: id, status: "ENABLED", triggerPiece: null, triggerName: null,
    published: true, triggerableViaWebhook: true, webhookUrl: `http://ap/v1/webhooks/${id}`,
    createdAt: null, updatedAt: null,
  };
}

function run(id: string, flowId: string): ActivepiecesFlowRun {
  return { id, flowId, projectId: null, status: "SUCCEEDED", terminal: true, succeeded: true, startTime: null, finishTime: null, failure: null };
}

function stubEngine() {
  const triggered: string[] = [];
  const runsRead: string[] = [];
  const engine: FlowEngine = {
    listFlows: async () => ({ flows: [flow("flow_a"), flow("flow_b"), flow("flow_free")], nextCursor: null, configured: true }),
    triggerFlow: async (flowId) => {
      triggered.push(flowId);
      return { accepted: true, runId: `run_${flowId}`, flowId, response: {} };
    },
    latestFlowRun: async (flowId) => run(`latest_${flowId}`, flowId),
    getFlowRun: async (runId) => {
      runsRead.push(runId);
      return run(runId, runId === "run_b" ? "flow_b" : "flow_a");
    },
  };
  return { engine, triggered, runsRead };
}

const notBound = (e: unknown) => e instanceof FlowNotBoundError && e.status === 404;

describe("workspaceFlows gate (H6)", () => {
  let store: ReturnType<typeof memStore>;
  let eng: ReturnType<typeof stubEngine>;
  beforeEach(async () => {
    store = memStore();
    eng = stubEngine();
    await bindFlowToWorkspace(A, "flow_a", "op", store);
    await bindFlowToWorkspace(B, "flow_b", "op", store);
  });

  it("lists only the caller's bound flows", async () => {
    const page = await workspaceFlows(A, { store, engine: eng.engine }).list();
    assert.deepEqual(page.flows.map((f) => f.id), ["flow_a"]);
  });

  it("refuses to trigger another tenant's flow — the engine is never called", async () => {
    await assert.rejects(() => workspaceFlows(A, { store, engine: eng.engine }).trigger("flow_b", { x: 1 }), notBound);
    await assert.rejects(() => workspaceFlows(A, { store, engine: eng.engine }).trigger("flow_free"), notBound);
    assert.deepEqual(eng.triggered, []);
  });

  it("triggers the caller's own flow", async () => {
    const res = await workspaceFlows(A, { store, engine: eng.engine }).trigger("flow_a", {});
    assert.equal(res.runId, "run_flow_a");
    assert.deepEqual(eng.triggered, ["flow_a"]);
  });

  it("hides another tenant's runs (by runId and by flowId)", async () => {
    const gate = workspaceFlows(A, { store, engine: eng.engine });
    await assert.rejects(() => gate.run("run_b"), notBound);
    await assert.rejects(() => gate.latestRun("flow_b"), notBound);
    assert.equal((await gate.run("run_a")).flowId, "flow_a");
  });

  it("a flow belongs to one workspace: re-binding elsewhere conflicts, same owner is idempotent", async () => {
    await bindFlowToWorkspace(A, "flow_a", "op", store);
    await assert.rejects(() => bindFlowToWorkspace(A, "flow_b", "op", store), (e: unknown) => e instanceof FlowBindingConflictError);
    assert.equal(store.rows.get("flow_b"), B);
  });
});
