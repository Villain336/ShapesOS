// ShapesOS — Phase 8 (ship): reviewing a run's diff on the Runs page.
//
// The diff always comes from the server's record — the newest patch a git
// tool stored on a run event (git_diff, git_commit, git_push_branch) for this
// run, the run that handed it work, or an earlier run of the same chat
// thread. It is never taken from the client.
//
// Three decisions, each through a path that already exists:
//   approve — the thread's pending push / PR proposal moves forward through
//             the chat confirmation path ("yes" → runTrackedAgentTurn runs
//             the proposed tool as the agent that proposed it, inside its
//             grant). Only ship proposals are approved here.
//   reject  — Stop (stopThreadRuns): the run stops if live, the pending
//             proposal is dropped, the approvals it raised expire.
//   changes — the reviewer's note goes into the run's thread as a new
//             message, so the agent continues from it.

import type { WorkspaceRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { appendAgentRunEvent } from "@/lib/agents/runs/service";
import { pendingProposal, runTrackedAgentTurn, stopThreadRuns } from "@/lib/chat/agent";
import { readShipState, type ShipState } from "./state";
import { parseUnifiedDiff, type DiffFile } from "./diff";

export { parseUnifiedDiff, type DiffFile, type DiffHunk, type DiffLine } from "./diff";

/** Tools whose run events carry a stored patch, newest wins. */
export const PATCH_TOOLS = ["git_diff", "git_commit", "git_push_branch"] as const;
/** Proposals this page may approve. */
export const SHIP_APPROVABLE_TOOLS = new Set(["git_push_branch", "open_pull_request"]);

export interface RunChanges {
  files: DiffFile[];
  truncated: boolean;
  additions: number;
  deletions: number;
  source: { runId: string; tool: string; at: Date };
}

export interface PendingShip {
  tool: string;
  args: Record<string, unknown>;
}

export interface RunReview {
  changes: RunChanges | null;
  ship: ShipState | null;
  pending: PendingShip | null;
  threadId: string | null;
}

/** The thread's pending ship proposal (push / PR), if that is what waits. */
export async function pendingShipProposal(threadId: string): Promise<PendingShip | null> {
  const pending = await pendingProposal(threadId);
  const p = pending?.find((c) => SHIP_APPROVABLE_TOOLS.has(c.tool));
  return p ? { tool: p.tool, args: p.args ?? {} } : null;
}

/** Everything the Changes section needs for one run (server-side, RLS-scoped). */
export async function loadRunReview(workspaceId: string, runId: string): Promise<RunReview | null> {
  const found = await withWorkspaceScope(workspaceId, async (tx) => {
    const run = await tx.agentRun.findFirst({
      where: { id: runId, workspaceId },
      select: { id: true, threadId: true, parentRunId: true, createdAt: true, agentState: true },
    });
    if (!run) return null;
    // Candidate runs: this one, the run that handed it work, earlier runs of its thread.
    const ids = [run.id];
    if (run.parentRunId) ids.push(run.parentRunId);
    let ship = readShipState(run.agentState);
    if (run.threadId) {
      const earlier = await tx.agentRun.findMany({
        where: { workspaceId, threadId: run.threadId, createdAt: { lte: run.createdAt }, id: { not: run.id } },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: { id: true, agentState: true },
      });
      for (const r of earlier) {
        ids.push(r.id);
        ship ??= readShipState(r.agentState);
      }
    }
    // The newest event that carries a patch: the tool's own event. (The
    // loop's live-stream tool_result event for the same call has none.)
    const candidates = await tx.agentRunEvent.findMany({
      where: {
        workspaceId,
        runId: { in: ids },
        OR: PATCH_TOOLS.map((t) => ({ payload: { path: ["tool"], equals: t } })),
      },
      orderBy: [{ createdAt: "desc" }, { seq: "desc" }],
      take: 20,
      select: { runId: true, payload: true, createdAt: true },
    });
    const event = candidates.find((e) => typeof (e.payload as { patch?: unknown } | null)?.patch === "string") ?? null;
    return { run, ship, event };
  });
  if (!found) return null;
  const { run, ship, event } = found;
  let changes: RunChanges | null = null;
  const payload = event?.payload as { patch?: unknown; tool?: unknown; truncated?: unknown } | null | undefined;
  if (event && payload && typeof payload.patch === "string") {
    const files = parseUnifiedDiff(payload.patch);
    changes = {
      files,
      truncated: payload.truncated === true,
      additions: files.reduce((s, f) => s + f.additions, 0),
      deletions: files.reduce((s, f) => s + f.deletions, 0),
      source: { runId: event.runId, tool: String(payload.tool), at: event.createdAt },
    };
  }
  const pending = run.threadId ? await pendingShipProposal(run.threadId) : null;
  return { changes, ship, pending, threadId: run.threadId };
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type ReviewAction = "approve" | "reject" | "changes";

export class ReviewError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ReviewError";
  }
}

export interface ReviewDeps {
  runTurn: (input: {
    projectId: string;
    workspaceId: string;
    userId: string;
    role: WorkspaceRole;
    threadId: string;
    userContent: string;
  }) => Promise<{ runId: string; assistantText: string; cancelled?: boolean }>;
  stop: (input: { workspaceId: string; threadId: string; userId: string; runId?: string }) => Promise<string[]>;
}

const defaultDeps: ReviewDeps = { runTurn: runTrackedAgentTurn, stop: stopThreadRuns };

export const APPROVE_TEXT = "Approved.";
export const CHANGES_PREFIX = "Changes requested on the diff:";

export interface ReviewInput {
  workspaceId: string;
  runId: string;
  userId: string;
  role: WorkspaceRole;
  action: ReviewAction;
  message?: string;
}

export interface ReviewOutcome {
  action: ReviewAction;
  /** The run the follow-up turn recorded (approve / changes). */
  followUpRunId?: string;
  stopped?: string[];
  reply?: string;
}

/**
 * Apply a review decision. The caller (route) has authenticated the user and
 * checked their role; this checks the run, its thread and what is pending.
 */
export async function reviewRun(input: ReviewInput, deps?: ReviewDeps): Promise<ReviewOutcome> {
  const d = deps ?? defaultDeps;
  const run = await withWorkspaceScope(input.workspaceId, (tx) =>
    tx.agentRun.findFirst({
      where: { id: input.runId, workspaceId: input.workspaceId },
      select: { id: true, threadId: true },
    }),
  );
  if (!run) throw new ReviewError("Run not found", 404);
  if (!run.threadId) throw new ReviewError("This run has no chat thread to continue.", 409);
  const thread = await prisma.aiChatThread.findFirst({
    where: { id: run.threadId, project: { workspaceId: input.workspaceId } },
    select: { id: true, userId: true, projectId: true },
  });
  if (!thread) throw new ReviewError("Run not found", 404);
  const note = (summary: string, payload: Record<string, unknown>) =>
    appendAgentRunEvent(input.workspaceId, run.id, { type: "gate", summary, payload }).catch(() => undefined);

  if (input.action === "reject") {
    const stopped = await d.stop({ workspaceId: input.workspaceId, threadId: thread.id, userId: input.userId, runId: run.id });
    await note("Changes rejected — stopped", { review: "reject", by: input.userId, stopped });
    return { action: "reject", stopped };
  }

  // approve / changes post into the thread as the reviewer: it must be theirs.
  if (thread.userId !== input.userId) {
    throw new ReviewError("Only the person who started this chat can approve or ask for changes here.", 403);
  }

  if (input.action === "approve") {
    const pending = await pendingShipProposal(thread.id);
    if (!pending) throw new ReviewError("Nothing from this run is waiting for approval.", 409);
    await note(`Approved ${pending.tool.replace(/_/g, " ")} from the review`, { review: "approve", tool: pending.tool, by: input.userId });
    await prisma.aiChatMessage.create({ data: { threadId: thread.id, role: "user", content: APPROVE_TEXT } });
    const turn = await d.runTurn({
      projectId: thread.projectId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
      threadId: thread.id,
      userContent: APPROVE_TEXT,
    });
    return { action: "approve", followUpRunId: turn.runId, reply: turn.assistantText };
  }

  const message = (input.message ?? "").trim();
  if (!message) throw new ReviewError("Say what should change.", 400);
  const content = `${CHANGES_PREFIX}\n${message.slice(0, 3800)}`;
  await note("Asked for changes", { review: "changes", by: input.userId, chars: message.length });
  await prisma.aiChatMessage.create({ data: { threadId: thread.id, role: "user", content } });
  const turn = await d.runTurn({
    projectId: thread.projectId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    role: input.role,
    threadId: thread.id,
    userContent: content,
  });
  return { action: "changes", followUpRunId: turn.runId, reply: turn.assistantText };
}
