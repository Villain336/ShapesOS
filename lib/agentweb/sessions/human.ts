// ShapesOS — Phase 21A round 2 (WS=agentweb): a person drives one step (take over / approve).
//
// The step goes through the SAME tool and the SAME page-aware gate the agent uses
// (executeTool, with the person confirming): a person cannot use Agent sessions to do what the
// kernel refuses everybody (pay, remove, sign in with a password): those stay the person's
// own act, in their own browser. What the person's step skips is only the session gate (a
// paused or review-each-step session), via ctx.humanStep, which only this server code sets.
//
// The browsing state lives in this process (lib/agentweb/tasks.ts), so a step can only be sent
// from the process that holds the task. If the agent loop runs in another worker process, the
// error says so instead of pretending.

import { prisma } from "@/lib/prisma";
import { executeTool, type ChatToolCall } from "@/lib/chat/tool-exec";
import type { ToolContext } from "@/lib/chat/tools";
import { webTasks } from "../tasks";
import { takeProposalArgs } from "./gate";
import { loadSession, SessionError, takePending } from "./store";

export const HUMAN_TOOLS = new Set(["browser_navigate", "browser_click", "browser_type", "browser_snapshot"]);

export interface HumanActor {
  userId: string;
  role: string;
}

export interface HumanStepResult {
  ok: boolean;
  summary: string;
  status: string;
}

function ctxFor(workspaceId: string, runId: string, taskKey: string, actor: HumanActor, projectId: string): ToolContext & { threadId?: string } {
  return {
    projectId,
    workspaceId,
    userId: actor.userId,
    role: actor.role as never,
    confirmed: true,
    humanStep: true,
    agentKey: "lead",
    grant: null,
    runId,
    ...(taskKey.startsWith("t:") ? { threadId: taskKey.slice(2) } : {}),
  };
}

export async function runHumanStep(workspaceId: string, runId: string, actor: HumanActor, step: { tool: string; args: Record<string, unknown> }, opts: { requireControl: boolean }): Promise<HumanStepResult> {
  if (!HUMAN_TOOLS.has(step.tool)) throw new SessionError("bad_state", "A person can send browser_navigate, browser_click, browser_type or browser_snapshot.");
  const loaded = await loadSession(workspaceId, runId);
  if (!loaded) throw new SessionError("not_found", "That session was not found.");
  if (opts.requireControl && loaded.row.control !== "human") throw new SessionError("bad_state", "Take over the session before sending steps.");
  const taskKey = loaded.row.taskKey;
  if (!webTasks.get(taskKey)) {
    throw new SessionError("bad_state", "This session's browser is not in this process (the agent may be running in a separate worker, or the task went idle). Steps can only be sent from the process that holds it.");
  }
  const project = await prisma.project.findFirst({ where: { workspaceId }, select: { id: true }, orderBy: { createdAt: "asc" } });
  const call: ChatToolCall = { tool: step.tool, args: step.args, status: "executed" };
  await executeTool(ctxFor(workspaceId, runId, taskKey, actor, project?.id ?? ""), step.tool, step.args, call);
  return { ok: call.status === "executed", summary: String(call.resultSummary ?? "").slice(0, 4000), status: call.status as string };
}

/** The person approves the step the agent proposed: it runs now, as theirs; the agent is told not to repeat it. */
export async function approveProposal(workspaceId: string, runId: string, proposalId: string, actor: HumanActor): Promise<HumanStepResult> {
  const args = takeProposalArgs(proposalId);
  const pending = await takePending(workspaceId, runId, proposalId, { note: "" }).catch((e) => {
    throw e;
  });
  if (!args) throw new SessionError("bad_state", "That proposal can no longer be run (the server restarted since it was proposed). Reject it; the agent will propose it again.");
  const result = await runHumanStep(workspaceId, runId, actor, { tool: pending.tool, args }, { requireControl: false });
  await annotate(workspaceId, runId, `The person ran your proposed step (${pending.summary}) themselves${result.ok ? "" : ", but it did not go through"}. Take a new browser_snapshot; do not repeat it.`);
  return result;
}

export async function rejectProposal(workspaceId: string, runId: string, proposalId: string): Promise<void> {
  takeProposalArgs(proposalId);
  await takePending(workspaceId, runId, proposalId, { note: "The person rejected your proposed step. Do not repeat it; take a browser_snapshot and ask them what to do instead." });
}

async function annotate(workspaceId: string, runId: string, note: string): Promise<void> {
  const { withWorkspaceScope } = await import("@/lib/substrate/memory/rls");
  await withWorkspaceScope(workspaceId, (tx) => tx.agentwebSession.updateMany({ where: { runId, workspaceId }, data: { lastNote: note } }));
}

export { takePending };
