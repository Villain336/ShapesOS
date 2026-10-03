// Marketr — Phase 17 slice 6 tests: the workflow runner + pre-authorized
// rollback.
//
// Unit layer: stub tx (in-memory ops_workflow_run store + audit sink) and a
// stub Phase 14 gate port. Custom WorkflowDefs are passed straight to
// runWorkflow, so no order/payment tables are needed. Covers:
// happy path, mid-run failure with reverse-order compensation,
// compensation failure (status failed, best-effort continues), exactly-one
// approval per run (pre-authorized rollback), missing approvalId,
// binding mismatch on drifted inputs, runKey replay → 409.
// Run: npx tsx --test lib/ops/__tests__/workflows.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildWorkflowPlan,
  proposeWorkflowRun,
  runWorkflow,
  workflowDef,
  workflowRunBindingMutation,
  type WorkflowDef,
  type WorkflowStepDef,
} from "../workflows";
import { OpsError, type OpsActor } from "../doctype";
import { OpsGateError } from "../gate";
import { approvalClaimDelegate } from "./approval-claims";

const actor: OpsActor = { userId: "u_wf", workspaceId: "ws_wf" };

// ---------------------------------------------------------------------------
// Stubs.
// ---------------------------------------------------------------------------

interface ApprovalRec {
  id: string;
  status: string;
  proposedArgs: Record<string, unknown>;
  expiresAt: Date;
}

function makeStubPort() {
  const approvals = new Map<string, ApprovalRec>();
  let seq = 0;
  const port = {
    proposeCalls: 0,
    async propose(input: {
      workspaceId: string;
      appKey: string;
      toolName: string;
      args: Record<string, unknown>;
      proposedBy: string;
      plainSummary: string;
    }) {
      port.proposeCalls += 1;
      const id = `appr_${++seq}`;
      approvals.set(id, {
        id,
        status: "approved",
        proposedArgs: input.args,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      return { id, status: "approved", riskTier: "medium" };
    },
    async getApproval(_workspaceId: string, id: string) {
      const a = approvals.get(id);
      if (!a) throw new Error(`approval ${id} not found`);
      return a;
    },
    _approvals: approvals,
  };
  return port;
}

function makeStubTx() {
  const runs = new Map<string, Record<string, unknown>>();
  const audit: Array<Record<string, unknown>> = [];
  let seq = 0;
  const tx = {
    opsWorkflowRun: {
      findMany: async () => [...runs.values()],
      findFirst: async (q: { where: Record<string, unknown> }) => {
        for (const r of runs.values()) {
          const w = q.where;
          if (w.id != null && r.id !== w.id) continue;
          if (w.workspaceId != null && r.workspaceId !== w.workspaceId) continue;
          if (w.runKey !== undefined && r.runKey !== w.runKey) continue;
          return r;
        }
        return null;
      },
      create: async (q: { data: Record<string, unknown> }) => {
        const row = {
          id: `run_${++seq}`,
          compensationLog: [],
          createdAt: new Date().toISOString(),
          ...q.data,
        };
        runs.set(row.id as string, row);
        return row;
      },
      update: async (q: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = runs.get(q.where.id);
        if (!row) throw new Error("run not found");
        Object.assign(row, q.data);
        return row;
      },
    },
    opsAuditEvent: {
      create: async (q: { data: Record<string, unknown> }) => {
        audit.push(q.data);
        return q.data;
      },
    },
    composioActionApproval: approvalClaimDelegate(),
  };
  return { tx, runs, audit };
}

// ---------------------------------------------------------------------------
// Test workflow definitions (in-memory; no order/payment tables needed).
// ---------------------------------------------------------------------------

interface TestHooks {
  events: string[];
  failAt?: string;
  compFailAt?: string;
}

function makeTestDef(hooks: TestHooks): WorkflowDef {
  const step = (
    name: string,
    opts: { rollback: ((r: Record<string, unknown>) => string) | null } = { rollback: (r) => `undo ${r.orderId} ${name}` },
  ): WorkflowStepDef => ({
    name,
    describe: (r) => `${name} for order ${r.orderId}`,
    rollback: opts.rollback,
    async execute() {
      hooks.events.push(`exec:${name}`);
      if (hooks.failAt === name) throw new Error(`boom at ${name}`);
      return { detail: { step: name } };
    },
    ...(opts.rollback
      ? {
          compensate: async () => {
            hooks.events.push(`comp:${name}`);
            if (hooks.compFailAt === name) throw new Error(`compensation boom at ${name}`);
            return { detail: { undone: name } };
          },
        }
      : {}),
  });
  return {
    name: "test-wf",
    label: "Test workflow",
    async resolve(_tx, _actor, inputs) {
      return { orderId: "ord_1", amountCents: 5000, ...inputs };
    },
    steps: [step("a"), step("b"), step("c")],
  };
}

async function proposeAndApprove(
  port: ReturnType<typeof makeStubPort>,
  tx: ReturnType<typeof makeStubTx>["tx"],
  def: WorkflowDef,
  args: { runKey: string; inputs?: Record<string, unknown> },
) {
  const proposed = await proposeWorkflowRun(
    tx as never,
    actor,
    def,
    { runKey: args.runKey, inputs: args.inputs ?? {} },
    { gatePort: port as never },
  );
  return proposed;
}

describe("workflows: plan derivation", () => {
  it("builds a deterministic plan with a rollback entry per compensable step", () => {
    const hooks: TestHooks = { events: [] };
    const def = makeTestDef(hooks);
    const resolved = { orderId: "ord_1", amountCents: 5000 };
    const plan = buildWorkflowPlan(def, resolved);
    assert.equal(plan.steps.length, 3);
    assert.deepEqual(plan.steps.map((s) => s.name), ["a", "b", "c"]);
    assert.equal(plan.rollbackPlan.length, 3);
    const plan2 = buildWorkflowPlan(def, resolved);
    assert.deepEqual(plan, plan2);
    const mutation = workflowRunBindingMutation("test-wf", "rk1", plan, resolved);
    assert.equal(mutation.workflowName, "test-wf");
    assert.equal(mutation.runKey, "rk1");
    assert.ok(Array.isArray(mutation.steps));
    assert.ok(Array.isArray(mutation.rollbackPlan));
    assert.deepEqual(mutation.resolved, resolved);
  });

  it("workflowDef throws 404 for unknown workflows", () => {
    assert.throws(() => workflowDef("no-such-workflow"), (e: unknown) => {
      assert.ok(e instanceof OpsError);
      assert.equal((e as OpsError).status, 404);
      return true;
    });
  });
});

describe("workflows: happy path", () => {
  it("runs every step, finishes succeeded, no compensations", async () => {
    const hooks: TestHooks = { events: [] };
    const def = makeTestDef(hooks);
    const port = makeStubPort();
    const { tx, runs, audit } = makeStubTx();
    const proposed = await proposeAndApprove(port, tx, def, { runKey: "rk-happy" });
    assert.equal(port.proposeCalls, 1);

    const { run } = await runWorkflow(
      tx as never,
      actor,
      def,
      { runKey: "rk-happy", inputs: {}, approvalId: proposed.approval.id },
      { gatePort: port as never },
    );
    assert.equal(run.status, "succeeded");
    assert.deepEqual(hooks.events, ["exec:a", "exec:b", "exec:c"]);
    assert.deepEqual(run.compensationLog, []);
    const states = run.steps as Array<{ name: string; status: string }>;
    assert.ok(states.every((s) => s.status === "done"));
    // The runner never proposes again — the rollback is pre-authorized.
    assert.equal(port.proposeCalls, 1);
    // Audit names the run and the approval.
    const actions = audit.map((a) => a.action);
    assert.ok(actions.includes("workflow_started"));
    assert.ok(actions.includes("workflow_finished"));
    assert.ok(audit.some((a) => String(a.summary).includes(proposed.approval.id)));
    assert.equal(runs.size, 1);
  });
});

describe("workflows: compensation", () => {
  it("compensates completed steps in REVERSE order, status compensated", async () => {
    const hooks: TestHooks = { events: [], failAt: "c" };
    const def = makeTestDef(hooks);
    const port = makeStubPort();
    const { tx, audit } = makeStubTx();
    const proposed = await proposeAndApprove(port, tx, def, { runKey: "rk-comp" });

    const { run } = await runWorkflow(
      tx as never,
      actor,
      def,
      { runKey: "rk-comp", inputs: {}, approvalId: proposed.approval.id },
      { gatePort: port as never },
    );
    assert.equal(run.status, "compensated");
    assert.deepEqual(hooks.events, ["exec:a", "exec:b", "exec:c", "comp:b", "comp:a"]);
    const log = run.compensationLog as Array<{ step: string; action: string }>;
    assert.equal(log.length, 2);
    assert.equal(log[0]!.step, "b");
    assert.equal(log[1]!.step, "a");
    const states = run.steps as Array<{ name: string; status: string }>;
    assert.equal(states.find((s) => s.name === "c")!.status, "failed");
    assert.equal(states.find((s) => s.name === "b")!.status, "compensated");
    assert.equal(states.find((s) => s.name === "a")!.status, "compensated");
    // No new approval was proposed mid-rollback — pre-authorized.
    assert.equal(port.proposeCalls, 1);
    const actions = audit.map((a) => a.action);
    assert.ok(actions.includes("workflow_compensated"));
    assert.ok(actions.includes("workflow_step_failed"));
  });

  it("a failing compensation marks the run failed but keeps compensating", async () => {
    const hooks: TestHooks = { events: [], failAt: "c", compFailAt: "b" };
    const def = makeTestDef(hooks);
    const port = makeStubPort();
    const { tx, audit } = makeStubTx();
    const proposed = await proposeAndApprove(port, tx, def, { runKey: "rk-compfail" });

    const { run } = await runWorkflow(
      tx as never,
      actor,
      def,
      { runKey: "rk-compfail", inputs: {}, approvalId: proposed.approval.id },
      { gatePort: port as never },
    );
    assert.equal(run.status, "failed");
    // Best-effort: comp:a still ran after comp:b failed.
    assert.deepEqual(hooks.events, ["exec:a", "exec:b", "exec:c", "comp:b", "comp:a"]);
    const log = run.compensationLog as Array<{ step: string; action: string; result?: unknown }>;
    assert.equal(log.length, 2);
    assert.equal(log[0]!.action, "compensation FAILED");
    assert.equal(log[1]!.step, "a");
    const actions = audit.map((a) => a.action);
    assert.ok(actions.includes("workflow_compensation_failed"));
  });
});

describe("workflows: gate fail-closed", () => {
  it("missing approvalId throws approval_required", async () => {
    const hooks: TestHooks = { events: [] };
    const def = makeTestDef(hooks);
    const port = makeStubPort();
    const { tx } = makeStubTx();
    await assert.rejects(
      runWorkflow(tx as never, actor, def, { runKey: "rk-noappr", inputs: {}, approvalId: "" }, { gatePort: port as never }),
      (e: unknown) => {
        assert.ok(e instanceof OpsGateError);
        assert.equal((e as OpsGateError).code, "approval_required");
        return true;
      },
    );
    assert.deepEqual(hooks.events, []);
  });

  it("drifted inputs between propose and execute fail the binding", async () => {
    const hooks: TestHooks = { events: [] };
    const def = makeTestDef(hooks);
    const port = makeStubPort();
    const { tx } = makeStubTx();
    const proposed = await proposeAndApprove(port, tx, def, {
      runKey: "rk-drift",
      inputs: { orderId: "ord_1", amountCents: 5000 },
    });
    await assert.rejects(
      runWorkflow(
        tx as never,
        actor,
        def,
        { runKey: "rk-drift", inputs: { orderId: "ord_1", amountCents: 6000 }, approvalId: proposed.approval.id },
        { gatePort: port as never },
      ),
      (e: unknown) => {
        assert.ok(e instanceof OpsGateError);
        assert.equal((e as OpsGateError).code, "binding_mismatch");
        return true;
      },
    );
    assert.deepEqual(hooks.events, []);
  });

  it("replaying the same runKey throws 409 — no double execution", async () => {
    const hooks: TestHooks = { events: [] };
    const def = makeTestDef(hooks);
    const port = makeStubPort();
    const { tx } = makeStubTx();
    const proposed = await proposeAndApprove(port, tx, def, { runKey: "rk-replay" });
    const args = { runKey: "rk-replay", inputs: {}, approvalId: proposed.approval.id };
    await runWorkflow(tx as never, actor, def, args, { gatePort: port as never });
    await assert.rejects(
      runWorkflow(tx as never, actor, def, args, { gatePort: port as never }),
      (e: unknown) => {
        assert.ok(e instanceof OpsError);
        assert.equal((e as OpsError).status, 409);
        return true;
      },
    );
    // The replay never executed a step.
    assert.deepEqual(hooks.events, ["exec:a", "exec:b", "exec:c"]);
  });
});
