// ShapesOS — one tool call through every gate (Phase 5 rules, Phase 8 home).
//
// executeTool() is the single path a model-requested tool call takes, from
// the chat turn, a delegated sub-agent and the Phase 8 agent loop alike:
//
//   1. Stop: a stopped run runs nothing more (checked before every call).
//   2. Grant: a tool outside the task's tool groups is refused ("denied"),
//      audited and put on the run timeline — the backstop for a model that
//      names a tool it was never shown. Connector aliases go through the same
//      grant check inside resolveConnectorTool.
//   3. Role: ToolDef.minRole.
//   4. Confirmation gate: a non-safe tool runs only after the user's "yes",
//      or when a per-agent auto-approve rule covers a Tier 0–2 action
//      (Phase 14); Tier 3 and destructive tools always ask.
//   5. Run + audit + run event.
//
// Moved out of lib/chat/agent.ts so lib/agents/loop.ts can use it without an
// import cycle (agent.ts runs the loop; the loop runs tools).

import { prisma } from "@/lib/prisma";
import { roleAtLeast } from "@/lib/authz";
import {
  allTools,
  getTool,
  TOOL_RECORDED_EVENT,
  toolAction,
  toolGranted,
  toolGroup,
  type ToolContext,
  type ToolDef,
  type ToolResult,
} from "./tools";
import { TOOL_GROUP_LABELS, agentDisplayName, isAgentKey } from "@/lib/agents/grants";
import { autoApprovalFor } from "@/lib/automation/policy";
import { appendAgentRunEvent, isAgentRunCancelRequested } from "@/lib/agents/runs/service";
import { abortRun, isRunStopped } from "@/lib/agents/runs/abort";
import { resolveConnectorTool } from "./connector-tools";

export const DELEGATE_TOOL = "delegate_to_subagent";

export interface ChatToolCall {
  tool: string;
  args: Record<string, unknown>;
  resultSummary?: string;
  /**
   * Phase 5 adds "denied" (outside the task's tool grant) and "cancelled"
   * (the run was stopped before it ran, or a pending proposal was dropped).
   */
  status: "executed" | "pending_confirmation" | "error" | "skipped_role" | "denied" | "cancelled";
  confirmed?: boolean;
  /** Phase 5: the agent that made the call (absent = the thread's agent). */
  agentKey?: string;
  /** Phase 5: the grant the call was proposed under (re-checked on "yes"). */
  grant?: string[];
  /** Phase 5: set when a per-agent rule let it run without asking. */
  autoApproved?: string;
  /**
   * Phase 5: on a pending proposal, the automation action a per-agent rule
   * could cover (Phase 14: Tier 0–2) — the chat offers "do this without asking".
   * Absent = this kind of action always asks.
   */
  autoAction?: string;
  /** Phase 5: calls a sub-agent made inside a delegate_to_subagent call. */
  delegated?: ChatToolCall[];
  /** Phase 8: the model's tool_use id and the run whose transcript holds it. */
  toolUseId?: string;
  runId?: string;
}

/** ToolContext plus the thread a delegated sub-agent writes its tool rows to. */
export type LoopContext = ToolContext & {
  threadId?: string;
  /** Phase 8: what is left of the run's budget (a delegated child stays inside it). */
  deadlineAt?: number;
  costLeftMicroUsd?: number;
  /** Phase 8: the tool_use id of the call being executed (delegation resumes by it). */
  toolUseId?: string;
};

export async function auditToolExecution(
  ctx: ToolContext,
  tool: ToolDef,
  summary: string,
  autoReason?: string,
): Promise<void> {
  await prisma.fileChangeLog
    .create({
      data: {
        projectId: ctx.projectId,
        workspaceId: ctx.workspaceId,
        filePath: `chat:${tool.name}:${ctx.projectId}`,
        actor: "ai",
        action: ctx.confirmed || autoReason ? "ai_applied" : "ai_proposal",
        summary: `[${tool.kind}] ${tool.name}: ${summary}${autoReason ? ` (${autoReason})` : ""}`.slice(0, 500),
        // An auto-approved call was not approved by a person.
        approvedBy: ctx.confirmed ? ctx.userId : null,
      },
    })
    .catch(() => {});
}

/** Phase 5: one line on the run's timeline (never fails the turn). */
export async function runEvent(
  ctx: ToolContext,
  summary: string,
  payload?: Record<string, unknown>,
  type: "agui" | "gate" | "note" = "agui",
): Promise<void> {
  if (!ctx.runId) return;
  await appendAgentRunEvent(ctx.workspaceId, ctx.runId, {
    type,
    summary: summary.slice(0, 500) || type,
    payload,
  }).catch(() => undefined);
}

/**
 * Phase 5: has this run been asked to stop? The in-process signal answers at
 * once; otherwise the database is asked (Stop may come from another process),
 * and a stop found there also aborts this process's in-flight work.
 */
export async function stopRequested(ctx: ToolContext): Promise<boolean> {
  if (ctx.signal?.aborted) return true;
  if (!ctx.runId) return false;
  const asked = await isAgentRunCancelRequested(ctx.workspaceId, ctx.runId).catch(() => false);
  if (asked) abortRun(ctx.runId);
  return asked;
}

function recordedOwnEvent(result: ToolResult): boolean {
  const d = result.details as Record<string, unknown> | undefined;
  return !!d && d[TOOL_RECORDED_EVENT] === true;
}

/** Keep the approval a tool raised on the run timeline (so Stop can expire it). */
function approvalRef(result: ToolResult): Record<string, unknown> {
  const d = result.details as { approvalId?: unknown } | undefined;
  return d && typeof d.approvalId === "string" ? { approvalId: d.approvalId } : {};
}

/** delegate_to_subagent returns the sub-agent's own calls; keep them on the call. */
function collectDelegated(call: ChatToolCall, result: ToolResult): void {
  const d = result.details as { calls?: unknown } | undefined;
  if (call.tool === DELEGATE_TOOL && d && Array.isArray(d.calls)) {
    call.delegated = d.calls as ChatToolCall[];
  }
}

/**
 * Run one tool call through every gate. Mutates `call` (status, summary …)
 * and returns the tool's result when it ran (null otherwise), so the agent
 * loop can hand the details back to the model.
 */
export async function executeTool(
  ctx: ToolContext,
  toolName: string,
  args: Record<string, unknown>,
  call: ChatToolCall,
): Promise<ToolResult | null> {
  // Phase 5: a stopped run runs nothing more.
  if (await stopRequested(ctx)) {
    call.status = "cancelled";
    call.resultSummary = `Not run — the task was stopped.`;
    return null;
  }
  if (ctx.agentKey && !call.agentKey) call.agentKey = ctx.agentKey;
  const ids = call.toolUseId ? { toolUseId: call.toolUseId } : {};
  const tool = getTool(toolName);
  if (!tool) {
    // Dynamic connector tools (milestone 21): connector.<key>.<toolName>.
    if (toolName.startsWith("connector.")) {
      const outcome = await resolveConnectorTool(toolName, ctx, args);
      call.status = outcome.status;
      call.resultSummary = outcome.resultSummary;
      if (outcome.status === "pending_confirmation" && ctx.grant) call.grant = [...ctx.grant];
      if (outcome.autoAction) call.autoAction = outcome.autoAction;
      await runEvent(
        ctx,
        `${toolName}: ${outcome.status.replace(/_/g, " ")}`,
        { kind: "tool_result", tool: toolName, status: outcome.status, summary: outcome.resultSummary.slice(0, 500), ...ids },
        outcome.status === "denied" || outcome.status === "pending_confirmation" ? "gate" : "agui",
      );
      return null;
    }
    call.status = "error";
    call.resultSummary = `Unknown tool "${toolName}". Available: ${allTools()
      .filter((t) => toolGranted(t.name, ctx.grant))
      .map((t) => t.name)
      .join(", ")}`;
    return null;
  }
  // Phase 5: the task's tool grant, checked before anything runs. The model
  // only ever sees granted tools, so this is the backstop for a model that
  // names a tool anyway.
  if (!toolGranted(tool.name, ctx.grant)) {
    const group = toolGroup(tool.name);
    call.status = "denied";
    call.resultSummary = `This task isn't allowed to use ${TOOL_GROUP_LABELS[group]} tools (${tool.name}).`;
    await auditToolExecution(ctx, tool, `DENIED (outside the task's tool grant: ${group})`);
    await runEvent(ctx, `Refused ${tool.name}: outside this task's tools`, { kind: "tool_result", tool: tool.name, group, status: "denied", ...ids }, "gate");
    return null;
  }
  if (!roleAtLeast(ctx.role, tool.minRole)) {
    call.status = "skipped_role";
    call.resultSummary = `Tool "${toolName}" needs the ${tool.minRole} role (you have ${ctx.role}).`;
    return null;
  }
  // Confirmation gate: non-safe tools only run after an explicit "yes" —
  // or, Phase 5, when a per-agent auto-approve rule covers the action
  // (Phase 14: Tier 0–2). Tier 3 and destructive tools always ask.
  let autoReason: string | undefined;
  if (tool.kind !== "safe" && !ctx.confirmed) {
    const decision =
      tool.kind === "destructive"
        ? null
        : await autoApprovalFor(ctx.workspaceId, {
            agentKey: ctx.agentKey ?? "lead",
            action: toolAction(tool.name),
            description: `${tool.name}: ${tool.description}`,
          }).catch(() => null);
    if (!decision?.auto) {
      call.status = "pending_confirmation";
      call.resultSummary = `Proposed ${tool.name} (${tool.kind}) — awaiting confirmation`;
      if (ctx.grant) call.grant = [...ctx.grant];
      // Phase 14: offered on every Tier 0–2 call (never Tier 3 / destructive).
      if (decision?.offerAuto) call.autoAction = toolAction(tool.name);
      await runEvent(ctx, `Waiting for your OK: ${tool.name}`, { kind: "tool_result", tool: tool.name, status: "pending_confirmation", toolKind: tool.kind, ...ids }, "gate");
      return null;
    }
    autoReason = decision.reason;
    call.autoApproved = decision.reason;
  }
  try {
    const result = await tool.execute(ctx, args);
    call.status = "executed";
    call.resultSummary = result.summary;
    collectDelegated(call, result);
    await auditToolExecution(ctx, tool, result.summary, autoReason);
    await runEvent(ctx, `${tool.name}: ${result.summary}`, {
      kind: "tool_result",
      tool: tool.name,
      status: "executed",
      ...ids,
      ...(autoReason ? { autoApproved: autoReason } : {}),
      ...approvalRef(result),
      // Phase 8: the tool recorded its own timeline event (ship / browser
      // tools); this one only feeds the live stream (isStreamEvent hides it).
      ...(recordedOwnEvent(result) ? { recorded: true } : {}),
    });
    return result;
  } catch (err) {
    if (isRunStopped(err)) {
      call.status = "cancelled";
      call.resultSummary = "Stopped while running.";
      return null;
    }
    call.status = "error";
    call.resultSummary = err instanceof Error ? err.message : `${toolName} failed`;
    await auditToolExecution(ctx, tool, `FAILED: ${call.resultSummary}`, autoReason);
    await runEvent(ctx, `${tool.name} failed: ${call.resultSummary}`, { kind: "tool_result", tool: tool.name, status: "error", ...ids });
    return null;
  }
}

/** The chat text that asks the user to OK a proposed call. */
export function proposalText(call: ChatToolCall): string {
  const tool = getTool(call.tool);
  const kind = tool?.kind ?? "write";
  const args = Object.entries(call.args)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
  const who =
    call.agentKey && isAgentKey(call.agentKey) && call.agentKey !== "lead"
      ? `The ${agentDisplayName(call.agentKey)} sub-agent would like`
      : "I'd like";
  return [
    `${who} to run **${call.tool}** (${kind} action)${args ? ` with ${args}` : ""}.`,
    `${tool?.description ?? ""}`,
    `Reply **yes** to confirm, or send a new message to cancel.`,
  ].join("\n");
}
