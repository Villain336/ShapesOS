// Marketr — automation canvas: execution engine (redesign §2).
//
// Model:
//   - A run walks edges from the trigger node that started it. v1 is
//     sequential: each node executes, its JSON output merges into the run
//     context, then the walk follows the single outgoing edge (conditions
//     pick the edge labeled "true"/"false").
//   - Every visited node gets a WorkflowRunStep row (pending → running →
//     succeeded | failed | skipped | waiting_approval).
//   - Fail-closed: the first action failure marks the run failed, records
//     the error, audit-logs it, and stops — no further nodes execute.
//   - Approval gates pause the run (status waiting_approval) and resume via
//     resumeWorkflowRun, which is called from the autopilot approve/reject
//     hooks (see lib/seo/autopilot-service.ts).
//   - The autopilot kill switch is checked before any run starts; while
//     killed, startWorkflowRun throws a 423-tagged error.

import type { PrismaClient } from "@prisma/client";
import type { FileChangeAction } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isAutopilotKilled } from "@/lib/seo/autopilot-service";
import { runActionNode } from "./actions";
import {
  createWorkflowAutopilotItem,
  ensureWorkflowApprovalsRule,
  gateSourceRef,
} from "./approvals";
import { CONDITION_LABELS } from "./catalog";

type Db = PrismaClient;

type NodeRow = {
  id: string;
  kind: string;
  type: string;
  label: string;
  config: unknown;
};

type EdgeRow = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  label: string | null;
};

export type RunContext = Record<string, unknown>;

/** Thrown when a run cannot start because the kill switch is engaged. */
export class WorkflowKilledError extends Error {
  status = 423;
  constructor() {
    super("Autopilot is killed — release the kill switch before running workflows");
  }
}

function configOf(node: NodeRow): Record<string, unknown> {
  return (node.config ?? {}) as Record<string, unknown>;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type WorkflowAuditAction =
  | "workflow_run_started"
  | "workflow_run_succeeded"
  | "workflow_run_failed"
  | "workflow_waiting_approval"
  | "workflow_approved"
  | "workflow_rejected";

/**
 * The schema's FileChangeAction enum is frozen (migration owned elsewhere),
 * so workflow lifecycle events map to the closest existing actions; the
 * workflow context always travels in the summary text.
 */
const ACTION_MAP: Record<WorkflowAuditAction, FileChangeAction> = {
  workflow_run_started: "autopilot_run_started",
  workflow_run_succeeded: "autopilot_run_finished",
  workflow_run_failed: "autopilot_run_finished",
  workflow_waiting_approval: "autopilot_item_generated",
  workflow_approved: "autopilot_item_approved",
  workflow_rejected: "autopilot_item_rejected",
};

async function auditWorkflow(
  workspaceId: string,
  projectId: string,
  action: WorkflowAuditAction,
  summary: string,
  actor: "user" | "system" = "system",
): Promise<void> {
  await prisma.fileChangeLog.create({
    data: {
      workspaceId,
      projectId,
      connectionId: null,
      filePath: "",
      actor,
      action: ACTION_MAP[action],
      summary: summary.slice(0, 280),
    },
  });
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function recordStep(
  runId: string,
  node: NodeRow,
  status: "pending" | "running" | "waiting_approval" | "succeeded" | "failed" | "skipped",
  patch: { input?: unknown; output?: unknown; error?: string | null } = {},
) {
  const existing = await prisma.workflowRunStep.findFirst({
    where: { runId, nodeId: node.id },
    orderBy: { startedAt: "desc" },
  });
  const data = {
    input: (patch.input ?? undefined) as never,
    output: (patch.output ?? undefined) as never,
    error: patch.error ?? undefined,
    status,
    ...(status === "succeeded" || status === "failed" || status === "skipped"
      ? { finishedAt: new Date() }
      : {}),
  };
  if (existing) {
    return prisma.workflowRunStep.update({ where: { id: existing.id }, data });
  }
  return prisma.workflowRunStep.create({
    data: {
      runId,
      nodeId: node.id,
      nodeKind: node.kind,
      nodeLabel: node.label,
      status,
      input: (patch.input ?? undefined) as never,
      output: (patch.output ?? undefined) as never,
      error: patch.error ?? null,
    },
  });
}

/** Rebuild run context from the outputs of succeeded steps, in visit order. */
async function rebuildContext(runId: string): Promise<RunContext> {
  const steps = await prisma.workflowRunStep.findMany({
    where: { runId, status: "succeeded" },
    orderBy: { startedAt: "asc" },
    select: { output: true, nodeLabel: true, nodeKind: true },
  });
  const ctx: RunContext = {};
  for (const s of steps) {
    const out = s.output as Record<string, unknown> | null;
    if (out && typeof out === "object") {
      Object.assign(ctx, out);
      // Also namespace by node kind for condition fields like "audit.errorIssues".
      if (s.nodeKind === "action" && s.nodeLabel) {
        // Namespaced access is best-effort; flat merge above is primary.
      }
    }
    const approved = (out as { itemId?: string } | null)?.itemId;
    if (approved && s.nodeKind === "approval") ctx.approvedItemId = approved;
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Node execution
// ---------------------------------------------------------------------------

function getByPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function evalCondition(field: string, operator: string, value: string, ctx: RunContext): boolean {
  const actual = getByPath(ctx, field);
  const numA = Number(actual);
  const numB = Number(value);
  const numeric = Number.isFinite(numA) && Number.isFinite(numB) && value.trim() !== "";
  switch (operator) {
    case "eq":
      return numeric ? numA === numB : String(actual ?? "") === value;
    case "neq":
      return numeric ? numA !== numB : String(actual ?? "") !== value;
    case "gt":
      return numeric ? numA > numB : String(actual ?? "") > value;
    case "gte":
      return numeric ? numA >= numB : String(actual ?? "") >= value;
    case "lt":
      return numeric ? numA < numB : String(actual ?? "") < value;
    case "lte":
      return numeric ? numA <= numB : String(actual ?? "") <= value;
    case "contains":
      return String(actual ?? "").includes(value);
    default:
      throw new Error(`condition: unknown operator "${operator}"`);
  }
}

export const MAX_DELAY_SECONDS = 300;

async function executeGate(
  run: { id: string; projectId: string },
  workflow: { id: string; name: string },
  workspaceId: string,
  node: NodeRow,
): Promise<{ paused: true }> {
  const cfg = configOf(node);
  const message = str(cfg.message);
  const rule = await ensureWorkflowApprovalsRule(prisma, workspaceId, run.projectId);
  const sourceRef = gateSourceRef(run.id, node.id);
  const item = await createWorkflowAutopilotItem(prisma, rule, {
    projectId: run.projectId,
    kind: "keyword_brief",
    sourceRef,
    title: `Workflow approval: ${workflow.name} — ${node.label}`,
    summary:
      message ||
      `A workflow run is waiting for a human decision at "${node.label}". Approve to continue the automation, or reject to cancel the run.`,
  });
  await recordStep(run.id, node, "waiting_approval", {
    input: { message },
    output: { itemId: item.id, sourceRef, decision: "pending" },
  });
  await prisma.workflowRun.update({
    where: { id: run.id },
    data: { status: "waiting_approval", pendingApprovalItemId: item.id },
  });
  await auditWorkflow(
    workspaceId,
    run.projectId,
    "workflow_waiting_approval",
    `Workflow "${workflow.name}" paused at approval gate "${node.label}" (queue item ${item.id})`,
  );
  return { paused: true };
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

interface WalkArgs {
  run: { id: string; projectId: string };
  workflow: { id: string; name: string; nodes: NodeRow[]; edges: EdgeRow[] };
  workspaceId: string;
  /** User id, or "cron"/"system". */
  actor: string;
  fromNodeId: string;
  context: RunContext;
  /** Trigger nodes already treated as the run start (don't re-run them). */
  startNodeIds?: Set<string>;
  /**
   * Data the trigger carried (the inbound webhook's JSON body). Recorded on
   * the trigger step's output as `trigger`, so it is in the run context —
   * conditions read it as "trigger.<field>" — and survives a resume.
   */
  triggerPayload?: unknown;
}

const MAX_VISITS = 100;

async function walk(args: WalkArgs): Promise<void> {
  const { run, workflow, workspaceId, actor } = args;
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, EdgeRow[]>();
  for (const e of workflow.edges) {
    const list = outgoing.get(e.sourceNodeId) ?? [];
    list.push(e);
    outgoing.set(e.sourceNodeId, list);
  }

  const visited = new Set<string>();
  let current: NodeRow | undefined = byId.get(args.fromNodeId);
  let ctx = args.context;
  const startNodeIds = args.startNodeIds ?? new Set([args.fromNodeId]);
  let visits = 0;

  while (current) {
    if (++visits > MAX_VISITS || visited.has(current.id)) {
      await recordStep(run.id, current, "skipped", {
        error: "Cycle detected — branch ended to avoid an infinite loop",
      });
      return;
    }
    visited.add(current.id);
    const node = current;
    const cfg = configOf(node);

    await recordStep(run.id, node, "running", { input: cfg });

    if (node.kind === "trigger") {
      if (startNodeIds.has(node.id)) {
        const output: Record<string, unknown> = { triggerKind: node.type };
        if (args.triggerPayload !== undefined && node.id === args.fromNodeId) {
          output.trigger = args.triggerPayload;
          ctx = { ...ctx, trigger: args.triggerPayload };
        }
        await recordStep(run.id, node, "succeeded", { output });
      } else {
        await recordStep(run.id, node, "skipped", {
          error: "Trigger nodes only fire at run start",
        });
      }
    } else if (node.kind === "action") {
      let output: Record<string, unknown>;
      try {
        output = await runActionNode(node.type, cfg, {
          workspaceId,
          projectId: run.projectId,
          runId: run.id,
          nodeId: node.id,
          actor,
          context: ctx,
        });
      } catch (err) {
        // Fail-closed: record the failing step before the error propagates
        // and marks the run failed — no step is left stuck at "running".
        await recordStep(run.id, node, "failed", {
          error: err instanceof Error ? err.message.slice(0, 500) : String(err),
        });
        throw err;
      }
      ctx = { ...ctx, ...output };
      await recordStep(run.id, node, "succeeded", { output });
    } else if (node.kind === "approval") {
      if (node.type !== "approval_gate") throw new Error(`Unknown approval type "${node.type}"`);
      await executeGate(run, workflow, workspaceId, node);
      return; // paused — resumeWorkflowRun continues from here
    } else if (node.kind === "logic") {
      if (node.type === "condition") {
        const field = str(cfg.field);
        const operator = str(cfg.operator) || "eq";
        const value = str(cfg.value);
        if (!field) throw new Error("condition: config.field is required");
        const result = evalCondition(field, operator, value, ctx);
        const edges = outgoing.get(node.id) ?? [];
        const pick = edges.find((e) => e.label === String(result));
        const fallback = edges.find((e) => !e.label || !CONDITION_LABELS.includes(e.label as never));
        const chosen = pick ?? (result ? fallback : undefined);
        await recordStep(run.id, node, "succeeded", {
          output: { field, operator, value, result, takenEdge: chosen?.id ?? null },
        });
        current = chosen ? byId.get(chosen.targetNodeId) : undefined;
        continue;
      }
      if (node.type === "delay") {
        const seconds = Math.floor(Number(cfg.seconds));
        if (!Number.isFinite(seconds) || seconds < 0) {
          throw new Error("delay: config.seconds must be a non-negative number");
        }
        if (seconds > MAX_DELAY_SECONDS) {
          throw new Error(
            `delay: ${seconds}s exceeds the v1 cap of ${MAX_DELAY_SECONDS}s — split the workflow or run it on a schedule`,
          );
        }
        if (seconds > 0) await sleep(seconds * 1000);
        await recordStep(run.id, node, "succeeded", { output: { seconds } });
      } else {
        throw new Error(`Unknown logic type "${node.type}"`);
      }
    } else {
      throw new Error(`Unknown node kind "${node.kind}"`);
    }

    // Follow the (single) default outgoing edge for non-condition nodes.
    const edges = outgoing.get(node.id) ?? [];
    const next = edges.find((e) => !e.label) ?? edges[0];
    current = next ? byId.get(next.targetNodeId) : undefined;
  }
}

function pickStartNode(
  nodes: NodeRow[],
  triggerKind: string,
  triggerNodeId?: string,
): NodeRow {
  if (triggerNodeId) {
    const n = nodes.find((x) => x.id === triggerNodeId);
    if (n) return n;
  }
  const triggers = nodes.filter((n) => n.kind === "trigger");
  if (triggers.length === 0) throw new Error("Workflow has no trigger node");
  // Prefer the trigger matching how the run was started.
  const match = triggers.find((n) => n.type === triggerKind);
  if (match) return match;
  if (triggerKind === "schedule") {
    const s = triggers.find((n) => n.type === "schedule");
    if (s) return s;
  }
  const manual = triggers.find((n) => n.type === "manual");
  return match ?? manual ?? triggers[0];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface StartRunArgs {
  workspaceId: string;
  projectId: string;
  workflowId: string;
  triggerKind: string;
  /** User id, or "cron"/"system". */
  createdBy: string | null;
  /** Defaults to createdBy. */
  actorUserId?: string | null;
  triggerNodeId?: string;
  /** Trigger data (webhook JSON body), exposed to nodes as `trigger`. */
  payload?: unknown;
}

/** Non-user creators: audit entries for their runs use the system actor. */
const SYSTEM_CREATORS = new Set(["system", "cron", "webhook"]);

/**
 * Start a workflow run: kill-switch check, 5-minute dedupe, then inline
 * execution. Returns the finished run (or the waiting run when paused at
 * a gate) plus whether it was deduplicated.
 */
export async function startWorkflowRun(
  args: StartRunArgs,
): Promise<{ run: Awaited<ReturnType<typeof prisma.workflowRun.findUniqueOrThrow>>; deduped: boolean }> {
  const workflow = await prisma.workflow.findFirst({
    where: { id: args.workflowId, projectId: args.projectId },
    include: { nodes: true, edges: true },
  });
  if (!workflow) throw new Error("Workflow not found");
  if (!workflow.enabled || workflow.status !== "active") {
    throw new Error(`Workflow is not active (status: ${workflow.status})`);
  }
  if (await isAutopilotKilled(prisma, args.workspaceId, args.projectId)) {
    throw new WorkflowKilledError();
  }
  if (workflow.nodes.length === 0) throw new Error("Workflow has no nodes — add nodes on the canvas first");

  const fiveMinAgo = new Date(Date.now() - 5 * 60_000);
  const existing = await prisma.workflowRun.findFirst({
    where: {
      workflowId: workflow.id,
      status: { in: ["queued", "running", "waiting_approval"] },
      startedAt: { gt: fiveMinAgo },
    },
    orderBy: { startedAt: "desc" },
  });
  if (existing) return { run: existing, deduped: true };

  const actor = args.actorUserId ?? args.createdBy ?? "system";
  const run = await prisma.workflowRun.create({
    data: {
      workflowId: workflow.id,
      projectId: args.projectId,
      status: "running",
      triggerKind: args.triggerKind,
      createdBy: args.createdBy,
    },
  });
  await auditWorkflow(
    args.workspaceId,
    args.projectId,
    "workflow_run_started",
    `Workflow "${workflow.name}" run started (${args.triggerKind})`,
    args.createdBy && !SYSTEM_CREATORS.has(args.createdBy) ? "user" : "system",
  );

  try {
    const startNode = pickStartNode(
      workflow.nodes as NodeRow[],
      args.triggerKind,
      args.triggerNodeId,
    );
    await walk({
      run: { id: run.id, projectId: run.projectId },
      workflow: {
        id: workflow.id,
        name: workflow.name,
        nodes: workflow.nodes as NodeRow[],
        edges: workflow.edges as EdgeRow[],
      },
      workspaceId: args.workspaceId,
      actor,
      fromNodeId: startNode.id,
      context: {},
      triggerPayload: args.payload,
    });
    await finishRunIfRunning(run.id, args.workspaceId, args.projectId, workflow.name);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { status: "failed", error: message.slice(0, 500), finishedAt: new Date() },
    });
    await auditWorkflow(
      args.workspaceId,
      args.projectId,
      "workflow_run_failed",
      `Workflow "${workflow.name}" run failed: ${message}`.slice(0, 280),
    );
  }

  await prisma.workflow.update({ where: { id: workflow.id }, data: { lastRunAt: new Date() } });
  return { run: await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } }), deduped: false };
}

async function finishRunIfRunning(runId: string, workspaceId: string, projectId: string, workflowName: string) {
  const fresh = await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } });
  if (fresh.status === "running") {
    await prisma.workflowRun.update({
      where: { id: runId },
      data: { status: "succeeded", finishedAt: new Date() },
    });
    await auditWorkflow(
      workspaceId,
      projectId,
      "workflow_run_succeeded",
      `Workflow "${workflowName}" run succeeded`,
    );
  }
}

export interface ResumeArgs {
  runId: string;
  nodeId: string;
  decision: "approved" | "rejected";
  itemId: string;
  workspaceId: string;
  actor: string;
}

/**
 * Resume a run paused at an approval gate. Called from the autopilot
 * approve/reject hooks. Approved → mark the gate succeeded and continue
 * execution after it. Rejected → cancel the run (fail-closed, nothing
 * after the gate executes).
 */
export async function resumeWorkflowRun(args: ResumeArgs): Promise<void> {
  const run = await prisma.workflowRun.findUnique({
    where: { id: args.runId },
    include: { workflow: { include: { nodes: true, edges: true } } },
  });
  if (!run) throw new Error(`Workflow run ${args.runId} not found`);
  if (run.status !== "waiting_approval") {
    // Idempotent: the run already moved on (e.g. double approval click).
    return;
  }
  const node = (run.workflow.nodes as NodeRow[]).find((n) => n.id === args.nodeId);
  if (!node) throw new Error(`Gate node ${args.nodeId} not found on workflow`);

  if (args.decision === "rejected") {
    await recordStep(run.id, node, "skipped", {
      output: { decision: "rejected", itemId: args.itemId },
    });
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { status: "cancelled", pendingApprovalItemId: null, finishedAt: new Date() },
    });
    await auditWorkflow(
      args.workspaceId,
      run.projectId,
      "workflow_rejected",
      `Workflow "${run.workflow.name}" run cancelled — approval gate "${node.label}" was rejected`,
      args.actor === "system" ? "system" : "user",
    );
    return;
  }

  await recordStep(run.id, node, "succeeded", {
    output: { decision: "approved", itemId: args.itemId },
  });
  const ctx = await rebuildContext(run.id);
  ctx.approvedItemId = args.itemId;
  await prisma.workflowRun.update({
    where: { id: run.id },
    data: { status: "running", pendingApprovalItemId: null },
  });
  await auditWorkflow(
    args.workspaceId,
    run.projectId,
    "workflow_approved",
    `Workflow "${run.workflow.name}" resumed — approval gate "${node.label}" approved`,
    args.actor === "system" ? "system" : "user",
  );

  try {
    const byId = new Map((run.workflow.nodes as NodeRow[]).map((n) => [n.id, n]));
    const outgoing = new Map<string, EdgeRow[]>();
    for (const e of run.workflow.edges as EdgeRow[]) {
      const list = outgoing.get(e.sourceNodeId) ?? [];
      list.push(e);
      outgoing.set(e.sourceNodeId, list);
    }
    const edges = outgoing.get(node.id) ?? [];
    const next = edges.find((e) => !e.label) ?? edges[0];
    if (next && byId.get(next.targetNodeId)) {
      await walk({
        run: { id: run.id, projectId: run.projectId },
        workflow: {
          id: run.workflow.id,
          name: run.workflow.name,
          nodes: run.workflow.nodes as NodeRow[],
          edges: run.workflow.edges as EdgeRow[],
        },
        workspaceId: args.workspaceId,
        actor: args.actor,
        fromNodeId: next.targetNodeId,
        context: ctx,
        startNodeIds: new Set([node.id]),
      });
    }
    await finishRunIfRunning(run.id, args.workspaceId, run.projectId, run.workflow.name);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { status: "failed", error: message.slice(0, 500), finishedAt: new Date() },
    });
    await auditWorkflow(
      args.workspaceId,
      run.projectId,
      "workflow_run_failed",
      `Workflow "${run.workflow.name}" run failed after approval: ${message}`.slice(0, 280),
    );
    throw err;
  }
}

/** Find runs currently paused at approval gates for a project (cron resume sweep). */
export async function findWaitingRuns(projectIds: string[]) {
  return prisma.workflowRun.findMany({
    where: { projectId: { in: projectIds }, status: "waiting_approval" },
    select: { id: true, workflowId: true, projectId: true, pendingApprovalItemId: true, startedAt: true },
  });
}

/**
 * Execute a run that was created externally in `queued` status (e.g. by the
 * AI chat's run_workflow tool). Claims it atomically so concurrent sweeps
 * can't double-execute, then runs the same walk as startWorkflowRun.
 * No-op when the run is missing or no longer queued.
 */
export async function executeQueuedRun(args: {
  runId: string;
  workspaceId: string;
  actor?: string;
}): Promise<void> {
  const claimed = await prisma.workflowRun.updateMany({
    where: { id: args.runId, status: "queued" },
    data: { status: "running" },
  });
  if (claimed.count === 0) return;

  const run = await prisma.workflowRun.findUniqueOrThrow({
    where: { id: args.runId },
    include: { workflow: { include: { nodes: true, edges: true } } },
  });
  const workflow = run.workflow;
  const actor = args.actor ?? run.createdBy ?? "system";

  const fail = async (message: string) => {
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { status: "failed", error: message.slice(0, 500), finishedAt: new Date() },
    });
    await auditWorkflow(args.workspaceId, run.projectId, "workflow_run_failed",
      `Workflow "${workflow.name}" run failed: ${message}`.slice(0, 280));
  };

  if (!workflow.enabled || workflow.status !== "active") {
    await fail(`Workflow is not active (status: ${workflow.status})`);
    return;
  }
  if (await isAutopilotKilled(prisma, args.workspaceId, run.projectId)) {
    await fail("Autopilot is killed — release the kill switch before running workflows");
    return;
  }
  if (workflow.nodes.length === 0) {
    await fail("Workflow has no nodes — add nodes on the canvas first");
    return;
  }

  try {
    const startNode = pickStartNode(workflow.nodes as NodeRow[], run.triggerKind, undefined);
    await walk({
      run: { id: run.id, projectId: run.projectId },
      workflow: {
        id: workflow.id,
        name: workflow.name,
        nodes: workflow.nodes as NodeRow[],
        edges: workflow.edges as EdgeRow[],
      },
      workspaceId: args.workspaceId,
      actor,
      fromNodeId: startNode.id,
      context: {},
    });
    await finishRunIfRunning(run.id, args.workspaceId, run.projectId, workflow.name);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await fail(message);
  }

  await prisma.workflow.update({ where: { id: workflow.id }, data: { lastRunAt: new Date() } });
}
