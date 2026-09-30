// Marketr — Phase 17 slice 6: the Operations workflow runner.
//
// The Medusa-inspired WORKFLOW PATTERN, reimplemented in Marketr's own
// code (commerce/Medusa runtime was deferred to Phase 18 — this is the
// saga pattern, not Medusa's packages): long-running, multi-step
// operations get transactional semantics — steps run in order, and when a
// step fails, the already-completed steps are compensated (rolled back) in
// REVERSE order. No half-charged customers, no hope-based sequencing.
//
// OpsWorkflowRun (a DocType entity since slice 1) is the transactional
// record: workflow name, per-step status, the append-only compensation
// log, and the final status. Workflow DEFINITIONS live in code (the
// registry below), not the DB.
//
// ---------------------------------------------------------------------------
// THE LOAD-BEARING DESIGN DECISION: pre-authorized rollback.
// ---------------------------------------------------------------------------
// Money steps inside a workflow do NOT propose their own Phase 14
// approvals. Instead, starting a money-moving workflow proposes ONE
// approval (OPS_WORKFLOW_RUN) whose binding mutation is the FULL plan:
//
//   { workflowName, runKey, steps: [...], rollbackPlan: [...], resolved: {...} }
//
// The approver reviews every step AND every compensation before anything
// runs — the plain-language summary shows the step plan followed by the
// rollback plan ("if fulfillment fails, we refund the charge and cancel
// the order"). The runner verifies that approval ONCE, fail-closed
// (approved, unexpired, binding matches the exact plan — amounts included,
// resolved at propose time AND re-resolved at execute time, so a drifted
// order total fails the binding instead of charging the wrong amount).
//
// Step execute/compensate functions then run UNDER that approval: they
// write delegate rows directly (never through opsCreate/opsPatch's gate)
// and every step execution + compensation writes an audit row naming the
// run id and the approval id, so the pre-authorization is traceable.
//
// Compensation therefore never stalls waiting for a new approval
// mid-rollback — a rollback that waits on a human is not a rollback.
// `runKey` is an idempotency key (unique per workspace): the same approved
// plan can never execute twice, so a replayed approval cannot double-charge.
// The Phase 14 approval itself is left "approved" (the ops convention from
// slices 1–5); the runKey uniqueness is the replay lock for workflow runs.

import type { Prisma } from "@prisma/client";
import {
  auditOpsEvent,
  opsCreate,
  opsEntityDef,
  opsPatch,
  type OpsActor,
  type OpsServiceOpts,
} from "./doctype";
import {
  OpsGateError,
  phase14GatePort,
  requestOpsApproval,
  verifyOpsApproval,
  type OpsGatePort,
} from "./gate";
import { OpsError } from "./doctype";

/** The DocType def for run records — the runner reads/writes runs through it. */
const WF_DEF = opsEntityDef("workflow-runs");

type Tx = Prisma.TransactionClient;

/** Money facts resolved from inputs at propose AND execute time. */
export type ResolvedInputs = Record<string, unknown> & { orderId?: string; amountCents?: number };

export interface WorkflowStepCtx {
  tx: Tx;
  actor: OpsActor;
  runId: string;
  approvalId: string;
  resolved: ResolvedInputs;
  /** Execute results of earlier steps, keyed by step name. */
  prior: Record<string, unknown>;
}

export interface StepOutcome {
  detail?: Record<string, unknown>;
}

export interface WorkflowStepDef {
  name: string;
  /** One-line description for the approval's step plan. */
  describe: (resolved: ResolvedInputs) => string;
  /** The rollback entry shown in the approval's rollback plan. null = terminal, nothing to undo. */
  rollback: ((resolved: ResolvedInputs) => string) | null;
  /** True when the step moves money (charge, refund, invoice send). */
  money?: boolean;
  execute: (ctx: WorkflowStepCtx) => Promise<StepOutcome>;
  /** Reverse of execute. Absent = nothing to compensate. */
  compensate?: (ctx: WorkflowStepCtx, executeResult: unknown) => Promise<StepOutcome>;
}

export interface WorkflowDef {
  name: string;
  label: string;
  /** Resolve money facts from raw inputs. Runs at propose AND execute time; drift fails the binding. */
  resolve: (tx: Tx, actor: OpsActor, inputs: Record<string, unknown>) => Promise<ResolvedInputs>;
  steps: WorkflowStepDef[];
}

export interface PlanStep {
  name: string;
  description: string;
  money: boolean;
}

export interface RollbackEntry {
  step: string;
  action: string;
}

/** Deterministic plan derivation: same (def, resolved) → same canonical JSON. */
export function buildWorkflowPlan(def: WorkflowDef, resolved: ResolvedInputs): {
  steps: PlanStep[];
  rollbackPlan: RollbackEntry[];
} {
  const steps = def.steps.map((s) => ({
    name: s.name,
    description: s.describe(resolved),
    money: s.money ?? false,
  }));
  const rollbackPlan = def.steps
    .filter((s) => s.rollback)
    .map((s) => ({ step: s.name, action: s.rollback!(resolved) }));
  return { steps, rollbackPlan };
}

/** The exact mutation the OPS_WORKFLOW_RUN approval binds to. */
export function workflowRunBindingMutation(
  workflowName: string,
  runKey: string,
  plan: { steps: PlanStep[]; rollbackPlan: RollbackEntry[] },
  resolved: ResolvedInputs,
): Record<string, unknown> {
  return { workflowName, runKey, steps: plan.steps, rollbackPlan: plan.rollbackPlan, resolved };
}

export function workflowRunSummary(
  def: WorkflowDef,
  plan: { steps: PlanStep[]; rollbackPlan: RollbackEntry[] },
  resolved: ResolvedInputs,
): string {
  const lines = [`Run workflow "${def.label}":`];
  plan.steps.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.description}${s.money ? " [moves money]" : ""}`);
  });
  if (plan.rollbackPlan.length > 0) {
    lines.push("Rollback plan (pre-authorized — runs automatically if a step fails):");
    for (const r of plan.rollbackPlan) lines.push(`- If a later step fails: ${r.action}`);
  } else {
    lines.push("No rollback steps — the workflow has no compensating actions.");
  }
  void resolved;
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The shipped workflow: order → payment → fulfillment (the spec's example).
// ---------------------------------------------------------------------------

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

async function findOrder(tx: Tx, actor: OpsActor, orderId: string) {
  const order = await (tx as unknown as {
    opsOrder: { findFirst(a: unknown): Promise<Record<string, unknown> | null> };
  }).opsOrder.findFirst({ where: { id: orderId, workspaceId: actor.workspaceId } });
  return order;
}

export const orderPaymentFulfillment: WorkflowDef = {
  name: "order-payment-fulfillment",
  label: "Order → payment → fulfillment",
  async resolve(tx, actor, inputs) {
    const orderId = inputs.orderId;
    if (typeof orderId !== "string" || !orderId) {
      throw new OpsError(400, 'Workflow "order-payment-fulfillment" requires inputs.orderId');
    }
    const order = await findOrder(tx, actor, orderId);
    if (!order) throw new OpsError(404, `Order "${orderId}" not found in workspace`);
    if (order.status !== "draft") {
      throw new OpsError(409, `Order "${orderId}" is ${order.status} — the workflow starts from draft`);
    }
    return { orderId, amountCents: order.totalCents as number };
  },
  steps: [
    {
      name: "confirm-order",
      describe: (r) => `Confirm order ${r.orderId} (draft → confirmed)`,
      rollback: (r) => `Cancel order ${r.orderId}`,
      async execute(ctx) {
        const { tx, actor, resolved } = ctx;
        await (tx as unknown as {
          opsOrder: { update(a: unknown): Promise<unknown> };
        }).opsOrder.update({
          where: { id: resolved.orderId, workspaceId: actor.workspaceId },
          data: { status: "confirmed" },
        });
        return { detail: { orderId: resolved.orderId, to: "confirmed" } };
      },
      async compensate(ctx) {
        const { tx, actor, resolved } = ctx;
        await (tx as unknown as {
          opsOrder: { update(a: unknown): Promise<unknown> };
        }).opsOrder.update({
          where: { id: resolved.orderId, workspaceId: actor.workspaceId },
          data: { status: "cancelled" },
        });
        return { detail: { orderId: resolved.orderId, to: "cancelled" } };
      },
    },
    {
      name: "record-charge",
      describe: (r) => `Record ${money(r.amountCents ?? 0)} charge via Stripe for order ${r.orderId}`,
      rollback: (r) => `Record ${money(r.amountCents ?? 0)} refund via Stripe for order ${r.orderId}`,
      money: true,
      // RECORDS ONLY (the ops invariant): the row is the system of record.
      // A live Stripe PaymentIntent call would go here in production; the
      // compensation below would then issue the real refund.
      async execute(ctx) {
        const { tx, actor, resolved } = ctx;
        const charge = await (tx as unknown as {
          opsPayment: { create(a: unknown): Promise<Record<string, unknown>> };
        }).opsPayment.create({
          data: {
            workspaceId: actor.workspaceId,
            orderId: resolved.orderId,
            kind: "charge",
            amountCents: resolved.amountCents,
            provider: "stripe",
            providerRef: `ch_${ctx.runId.slice(-8)}`,
            status: "succeeded",
          },
        });
        return { detail: { paymentId: charge.id, amountCents: resolved.amountCents } };
      },
      async compensate(ctx, executeResult) {
        const { tx, actor, resolved } = ctx;
        const chargeId = (executeResult as { paymentId?: string } | undefined)?.paymentId;
        const refund = await (tx as unknown as {
          opsPayment: { create(a: unknown): Promise<Record<string, unknown>> };
        }).opsPayment.create({
          data: {
            workspaceId: actor.workspaceId,
            orderId: resolved.orderId,
            kind: "refund",
            amountCents: resolved.amountCents,
            provider: "stripe",
            providerRef: chargeId ? `re_${String(chargeId).slice(-8)}` : undefined,
            status: "succeeded",
          },
        });
        return { detail: { refundId: refund.id, amountCents: resolved.amountCents } };
      },
    },
    {
      name: "fulfill-order",
      describe: (r) => `Fulfill order ${r.orderId} (confirmed → fulfilled)`,
      // Terminal step: once fulfilled there is nothing to undo in v1
      // (a real RMA flow would add compensation here).
      rollback: null,
      money: true,
      async execute(ctx) {
        const { tx, actor, resolved } = ctx;
        await (tx as unknown as {
          opsOrder: { update(a: unknown): Promise<unknown> };
        }).opsOrder.update({
          where: { id: resolved.orderId, workspaceId: actor.workspaceId },
          data: { status: "fulfilled" },
        });
        return { detail: { orderId: resolved.orderId, to: "fulfilled" } };
      },
    },
  ],
};

export const WORKFLOW_REGISTRY: Record<string, WorkflowDef> = {
  [orderPaymentFulfillment.name]: orderPaymentFulfillment,
};

export function workflowDef(name: string): WorkflowDef {
  const def = WORKFLOW_REGISTRY[name];
  if (!def) throw new OpsError(404, `Unknown workflow "${name}"`);
  return def;
}

// ---------------------------------------------------------------------------
// The runner.
// ---------------------------------------------------------------------------

export interface RunWorkflowArgs {
  runKey: string;
  inputs: Record<string, unknown>;
  approvalId: string;
}

type StepStatus = "pending" | "running" | "done" | "failed" | "compensated";

interface RunStepState {
  name: string;
  status: StepStatus;
  at?: string;
  detail?: Record<string, unknown>;
}

async function setSteps(
  tx: Tx,
  actor: OpsActor,
  runId: string,
  steps: RunStepState[],
  status?: string,
): Promise<void> {
  const def = WF_DEF;
  const body: Record<string, unknown> = { id: runId, steps };
  if (status) body.status = status;
  await opsPatch(tx, def, actor, body);
}

async function appendCompensation(
  tx: Tx,
  actor: OpsActor,
  runId: string,
  entry: { step: string; action: string; result?: unknown },
): Promise<void> {
  const def = WF_DEF;
  await opsPatch(tx, def, actor, { id: runId, compensationAppend: entry });
}

/**
 * Execute a workflow run under a pre-authorized OPS_WORKFLOW_RUN approval.
 * Fail-closed: the approval must be approved, unexpired, and bound to the
 * exact (workflowName, runKey, plan, resolved) tuple. runKey is the replay
 * lock — a second execution with the same key throws 409.
 */
export async function runWorkflow(
  tx: Tx,
  actor: OpsActor,
  def: WorkflowDef,
  args: RunWorkflowArgs,
  opts: OpsServiceOpts = {},
): Promise<{ run: Record<string, unknown> }> {
  const port: OpsGatePort = opts.gatePort ?? phase14GatePort;
  if (typeof args.runKey !== "string" || !args.runKey) {
    throw new OpsError(400, "runKey is required (idempotency key for the workflow run)");
  }
  const resolved = await def.resolve(tx, actor, args.inputs ?? {});
  const plan = buildWorkflowPlan(def, resolved);
  const mutation = workflowRunBindingMutation(def.name, args.runKey, plan, resolved);

  // The single gate check for the whole run: step executions and
  // compensations below run UNDER this approval (pre-authorized rollback).
  await verifyOpsApproval(port, {
    workspaceId: actor.workspaceId,
    slug: "OPS_WORKFLOW_RUN",
    entity: "workflow-runs",
    mutation,
    approvalId: args.approvalId,
  });

  // Replay lock: one run per (workspace, runKey).
  const existing = await (tx as unknown as {
    opsWorkflowRun: { findFirst(a: unknown): Promise<Record<string, unknown> | null> };
  }).opsWorkflowRun.findFirst({
    where: { workspaceId: actor.workspaceId, runKey: args.runKey },
  });
  if (existing) {
    throw new OpsError(409, `Workflow run "${args.runKey}" already executed — replay blocked`);
  }

  // Create the run record (draft-creator → free, logged).
  const created = await opsCreate(tx, WF_DEF, actor, {
    workflowName: def.name,
    runKey: args.runKey,
    steps: plan.steps.map((s) => ({ name: s.name, status: "pending" as StepStatus })),
    status: "running",
  });
  if (created.outcome !== "done") {
    throw new OpsGateError("unexpected_gate", "Workflow run creation unexpectedly required approval");
  }
  const run = created.row as Record<string, unknown>;
  const runId = String(run.id);
  const states: RunStepState[] = plan.steps.map((s) => ({ name: s.name, status: "pending" as StepStatus }));
  const ctxBase = { tx, actor, runId, approvalId: args.approvalId, resolved, prior: {} as Record<string, unknown> };

  await auditOpsEvent(
    tx, WF_DEF, actor, "workflow_started", runId,
    `Workflow "${def.label}" started (run ${args.runKey}, approval ${args.approvalId}): ${plan.steps.length} steps`,
  );

  const completed: Array<{ def: WorkflowStepDef; result: unknown }> = [];
  let failedStep: string | null = null;
  let failureDetail: string | null = null;

  for (let i = 0; i < def.steps.length; i++) {
    const step = def.steps[i]!;
    states[i]!.status = "running";
    states[i]!.at = new Date().toISOString();
    await setSteps(tx, actor, runId, states);
    try {
      const outcome = await step.execute({ ...ctxBase, prior: { ...ctxBase.prior } });
      states[i]!.status = "done";
      states[i]!.detail = outcome.detail;
      ctxBase.prior[step.name] = outcome.detail ?? {};
      completed.push({ def: step, result: outcome.detail ?? {} });
      await setSteps(tx, actor, runId, states);
      await auditOpsEvent(
        tx, WF_DEF, actor, "workflow_step", runId,
        `Step "${step.name}" done (approval ${args.approvalId})${step.money ? " [money]" : ""}`,
      );
    } catch (err) {
      failedStep = step.name;
      failureDetail = err instanceof Error ? err.message : String(err);
      states[i]!.status = "failed";
      states[i]!.detail = { error: failureDetail };
      await setSteps(tx, actor, runId, states);
      await auditOpsEvent(
        tx, WF_DEF, actor, "workflow_step_failed", runId,
        `Step "${step.name}" FAILED: ${failureDetail} — compensating ${completed.length} completed step(s) in reverse`,
      );
      break;
    }
  }

  // Final status mapping (DB enum: running | succeeded | failed | compensated):
  //   succeeded            = every step done
  //   compensated          = failed, but every completed step was compensated (failed_compensated)
  //   failed               = failed with incomplete compensation (failed_uncompensated)
  let finalStatus = "succeeded";
  if (failedStep) {
    finalStatus = "compensated";
    // Reverse-order compensation of the COMPLETED steps only.
    for (let i = completed.length - 1; i >= 0; i--) {
      const { def: step, result } = completed[i]!;
      const idx = states.findIndex((s) => s.name === step.name);
      if (!step.compensate) {
        await appendCompensation(tx, actor, runId, {
          step: step.name,
          action: "no compensation defined — skipped",
        });
        continue;
      }
      try {
        const cOutcome = await step.compensate({ ...ctxBase, prior: { ...ctxBase.prior } }, result);
        states[idx]!.status = "compensated";
        await setSteps(tx, actor, runId, states);
        await appendCompensation(tx, actor, runId, {
          step: step.name,
          action: step.rollback ? step.rollback(resolved) : "compensated",
          result: cOutcome.detail,
        });
        await auditOpsEvent(
          tx, WF_DEF, actor, "workflow_compensated", runId,
          `Compensated "${step.name}" under pre-authorized approval ${args.approvalId}`,
        );
      } catch (cerr) {
        finalStatus = "failed";
        const msg = cerr instanceof Error ? cerr.message : String(cerr);
        states[idx]!.status = "failed";
        await setSteps(tx, actor, runId, states);
        await appendCompensation(tx, actor, runId, {
          step: step.name,
          action: "compensation FAILED",
          result: { error: msg },
        });
        await auditOpsEvent(
          tx, WF_DEF, actor, "workflow_compensation_failed", runId,
          `Compensation of "${step.name}" FAILED: ${msg} — run needs human attention`,
        );
        // Best-effort: keep compensating the remaining steps.
      }
    }
  }

  await setSteps(tx, actor, runId, states, finalStatus);
  await auditOpsEvent(
    tx, WF_DEF, actor, "workflow_finished", runId,
    `Workflow "${def.label}" finished: ${finalStatus}${failedStep ? ` (failed at "${failedStep}": ${failureDetail})` : ""}`,
  );

  const finalRun = await (tx as unknown as {
    opsWorkflowRun: { findFirst(a: unknown): Promise<Record<string, unknown> | null> };
  }).opsWorkflowRun.findFirst({ where: { id: runId, workspaceId: actor.workspaceId } });
  return { run: finalRun ?? run };
}

/**
 * Propose a workflow run: resolves inputs, derives the deterministic plan,
 * and returns the Phase 14 approval (202-style). The caller shows the
 * step plan + rollback plan, collects approve/deny, then calls runWorkflow
 * with the approvalId.
 */
export async function proposeWorkflowRun(
  tx: Tx,
  actor: OpsActor,
  def: WorkflowDef,
  args: { runKey: string; inputs: Record<string, unknown> },
  opts: OpsServiceOpts = {},
): Promise<{
  approval: { id: string; status: string; riskTier: string };
  plan: { steps: PlanStep[]; rollbackPlan: RollbackEntry[] };
  summary: string;
  runKey: string;
}> {
  const port: OpsGatePort = opts.gatePort ?? phase14GatePort;
  if (typeof args.runKey !== "string" || !args.runKey) {
    throw new OpsError(400, "runKey is required (idempotency key for the workflow run)");
  }
  const resolved = await def.resolve(tx, actor, args.inputs ?? {});
  const plan = buildWorkflowPlan(def, resolved);
  const mutation = workflowRunBindingMutation(def.name, args.runKey, plan, resolved);
  const summary = workflowRunSummary(def, plan, resolved);
  const approval = await requestOpsApproval(port, {
    workspaceId: actor.workspaceId,
    slug: "OPS_WORKFLOW_RUN",
    entity: "workflow-runs",
    mutation,
    actor: actor.userId,
    summary,
  });
  await auditOpsEvent(
    tx, WF_DEF, actor, "workflow_proposed", null,
    `Workflow "${def.label}" proposed with step plan + rollback plan (approval ${approval.id})`,
  );
  return { approval, plan, summary, runKey: args.runKey };
}
