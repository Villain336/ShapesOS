// ShapesOS — Phase 9 (repos): the agent pull-request registry.
//
// One agent_pull_requests row per branch an agent pushed (shapes/<runId>)
// and its PR. It is written from the run's ship state (saveShipState calls
// syncPullRequestFromShip inside its own tenant transaction), so the source
// of truth stays AgentRun.agentState.ship; this row is the index over it
// that a GitHub delivery needs — which workspace / run / thread owns
// (repository, branch) — plus the PR's latest status for the Repositories
// view and the continuation bookkeeping:
//
//   recordPrFeedback — store feedback items (webhook deliveries or poller
//     items; the delivery id is the primary key, so a redelivery is a no-op),
//     update the PR's checks / state / last feedback and, when new feedback
//     asks for work on an open PR, queue ONE `pr_feedback` agent job. Later
//     feedback coalesces into the queued job (pending_since) instead of
//     starting another turn.
//
// Cross-workspace reads happen in exactly one place, routePullRequest(): it
// sets app.github_route = 'lookup' (a SELECT-only RLS policy on this table)
// to map a delivery to its workspace. Every write runs under the row's own
// tenant GUC (withWorkspaceScope).

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { agentWorkerMode } from "@/lib/agents/queue/config";
import type { ShipState } from "./state";

export type PullRequestState = "pushed" | "open" | "closed" | "merged";
export type ChecksState = "success" | "failure" | "pending" | "none";

/** Debounce before a queued continuation runs (a review's comments arrive as a burst). */
export const FEEDBACK_DEBOUNCE_MS = 20_000;
/** Longest summary kept per feedback item / on the PR row. */
const SUMMARY_MAX = 2000;
const LAST_FEEDBACK_MAX = 500;

export function normalizeRepo(fullName: string): string {
  return fullName.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Ship state → registry
// ---------------------------------------------------------------------------

/**
 * Keep the PR row in step with a run's ship state. Called by saveShipState
 * inside its tenant transaction. Only pushed work is registered (a clone that
 * never left the sandbox has nothing on GitHub to receive feedback about).
 */
export async function syncPullRequestFromShip(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  threadId: string | null,
  state: ShipState,
): Promise<void> {
  if (!state.pushedSha && !state.prNumber) return;
  const repoFullName = normalizeRepo(state.repo);
  const pr = state.prNumber ? { prNumber: state.prNumber, prUrl: state.prUrl ?? null } : {};
  const existing = await tx.agentPullRequest.findFirst({
    where: { workspaceId, repoFullName, branch: state.branch },
    select: { id: true, state: true },
  });
  if (existing) {
    await tx.agentPullRequest.update({
      where: { id: existing.id },
      data: {
        ...pr,
        ...(threadId ? { threadId } : {}),
        // A PR opened (or re-opened through open_pull_request) is open again.
        ...(state.prNumber && existing.state === "pushed" ? { state: "open" } : {}),
      },
    });
    return;
  }
  await tx.agentPullRequest.create({
    data: {
      workspaceId,
      repoFullName,
      branch: state.branch,
      runId: state.cloneRunId,
      threadId,
      state: state.prNumber ? "open" : "pushed",
      ...pr,
    },
  });
}

// ---------------------------------------------------------------------------
// Routing (the one cross-workspace read)
// ---------------------------------------------------------------------------

export interface PullRequestRoute {
  id: string;
  workspaceId: string;
}

/**
 * Which workspace owns this repository's branch (or PR number)? Read-only,
 * through the app.github_route SELECT policy; returns ids only.
 */
export async function routePullRequest(q: { repoFullName: string; branch?: string | null; prNumber?: number | null }): Promise<PullRequestRoute | null> {
  const repoFullName = normalizeRepo(q.repoFullName);
  if (!q.branch && !q.prNumber) return null;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.github_route = 'lookup'`);
    return tx.agentPullRequest.findFirst({
      where: q.branch ? { repoFullName, branch: q.branch } : { repoFullName, prNumber: q.prNumber! },
      orderBy: { createdAt: "desc" },
      select: { id: true, workspaceId: true },
    });
  });
}

/** Open agent PRs in every workspace (the poller's discovery; ids only). */
export async function discoverOpenPullRequests(limit = 500): Promise<PullRequestRoute[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.github_route = 'lookup'`);
    return tx.agentPullRequest.findMany({
      where: { state: { in: ["pushed", "open"] } },
      orderBy: { updatedAt: "asc" },
      take: Math.max(1, limit),
      select: { id: true, workspaceId: true },
    });
  });
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export interface FeedbackItem {
  /** X-GitHub-Delivery, or "poll:<kind>:<id>" — the dedupe key. */
  deliveryId: string;
  event: string;
  action?: string | null;
  /** feedback = asks for work (continues the run); info = recorded only. */
  kind: "feedback" | "info";
  author?: string | null;
  summary: string;
  url?: string | null;
  at?: Date;
}

export interface FeedbackUpdate {
  prNumber?: number | null;
  prUrl?: string | null;
  state?: PullRequestState;
  checks?: ChecksState;
}

export interface RecordFeedbackResult {
  /** Items stored now (duplicates excluded). */
  recorded: number;
  duplicates: number;
  /** A continuation job was queued by this call. */
  queued: boolean;
  /** New feedback joined a continuation that was already queued. */
  coalesced: boolean;
  /** Why nothing was queued for new feedback (closed PR, worker off, …). */
  skipped?: string;
  jobId?: string;
}

export interface RecordFeedbackDeps {
  enqueue: (input: { workspaceId: string; payload: PrFeedbackJobPayload; runAfter: Date }) => Promise<{ id: string }>;
  /** False when nothing would run a queued job (AGENT_WORKER=off). */
  workerAvailable: () => boolean;
  now: () => Date;
}

/** Payload of a `pr_feedback` agent job (lib/agents/queue/handlers.ts). */
export interface PrFeedbackJobPayload {
  workspaceId: string;
  pullRequestId: string;
  /** How many times the job waited for a busy thread. */
  deferrals?: number;
}

export const defaultRecordFeedbackDeps: RecordFeedbackDeps = {
  enqueue: async ({ workspaceId, payload, runAfter }) => {
    const { enqueueAgentJob } = await import("@/lib/agents/queue/store");
    return enqueueAgentJob({ workspaceId, kind: "pr_feedback", payload, runAfter });
  },
  workerAvailable: () => agentWorkerMode() !== "off",
  now: () => new Date(),
};

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown })?.code === "P2002";
}

/**
 * Store feedback for one agent PR and, when it asks for work, queue the
 * continuation (once — later items coalesce into the queued job).
 */
export async function recordPrFeedback(
  workspaceId: string,
  pullRequestId: string,
  items: readonly FeedbackItem[],
  update: FeedbackUpdate = {},
  deps: RecordFeedbackDeps = defaultRecordFeedbackDeps,
): Promise<RecordFeedbackResult> {
  const out: RecordFeedbackResult = { recorded: 0, duplicates: 0, queued: false, coalesced: false };
  const fresh: FeedbackItem[] = [];
  // Each item in its own statement: a duplicate (unique violation) must not
  // abort the others' transaction.
  for (const item of items) {
    try {
      await withWorkspaceScope(workspaceId, (tx) =>
        tx.gitHubWebhookDelivery.create({
          data: {
            deliveryId: item.deliveryId.slice(0, 200),
            workspaceId,
            pullRequestId,
            event: item.event.slice(0, 64),
            action: item.action ? item.action.slice(0, 64) : null,
            kind: item.kind,
            author: item.author ? item.author.slice(0, 120) : null,
            summary: clip(item.summary, SUMMARY_MAX),
            url: item.url ? item.url.slice(0, 1000) : null,
            ...(item.at ? { receivedAt: item.at } : {}),
          },
        }),
      );
      out.recorded++;
      fresh.push(item);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      out.duplicates++;
    }
  }

  const wantsWork = fresh.some((i) => i.kind === "feedback");
  const now = deps.now();
  const result = await withWorkspaceScope(workspaceId, async (tx) => {
    const pr = await tx.agentPullRequest.findFirst({
      where: { id: pullRequestId, workspaceId },
      select: { id: true, state: true, pendingSince: true },
    });
    if (!pr) return { skipped: "unknown pull request" as string | undefined, claim: false };
    const latest = [...fresh].reverse().find((i) => i.kind === "feedback") ?? fresh[fresh.length - 1];
    const nextState = update.state ?? (update.prNumber && pr.state === "pushed" ? "open" : undefined);
    await tx.agentPullRequest.update({
      where: { id: pr.id },
      data: {
        ...(update.prNumber ? { prNumber: update.prNumber } : {}),
        ...(update.prUrl ? { prUrl: update.prUrl } : {}),
        ...(nextState ? { state: nextState } : {}),
        ...(update.checks ? { checks: update.checks } : {}),
        ...(latest
          ? { lastFeedbackAt: latest.at ?? now, lastFeedback: clip(latest.summary, LAST_FEEDBACK_MAX), lastFeedbackUrl: latest.url ?? null }
          : {}),
      },
    });
    if (!wantsWork) return { skipped: undefined, claim: false };
    const state = nextState ?? pr.state;
    if (state === "closed" || state === "merged") return { skipped: `the pull request is ${state}`, claim: false };
    if (!deps.workerAvailable()) return { skipped: "AGENT_WORKER=off: no worker runs queued agent work", claim: false };
    // Claim the "continuation queued" slot; a concurrent delivery that loses
    // the race (or one arriving while the job waits) coalesces into it.
    const claimed = await tx.agentPullRequest.updateMany({
      where: { id: pr.id, workspaceId, pendingSince: null },
      data: { pendingSince: now },
    });
    return { skipped: undefined, claim: claimed.count === 1 };
  });
  if (result.skipped) out.skipped = result.skipped;
  if (!wantsWork || result.skipped) return out;
  if (!result.claim) {
    out.coalesced = true;
    return out;
  }
  try {
    const job = await deps.enqueue({
      workspaceId,
      payload: { workspaceId, pullRequestId },
      runAfter: new Date(now.getTime() + FEEDBACK_DEBOUNCE_MS),
    });
    out.queued = true;
    out.jobId = job.id;
  } catch (err) {
    // Release the slot so the next delivery can queue it again.
    await withWorkspaceScope(workspaceId, (tx) =>
      tx.agentPullRequest.updateMany({ where: { id: pullRequestId, workspaceId }, data: { pendingSince: null } }),
    ).catch(() => undefined);
    throw err;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reads (Repositories view, continuation)
// ---------------------------------------------------------------------------

export interface AgentPullRequestRow {
  id: string;
  repoFullName: string;
  branch: string;
  runId: string;
  threadId: string | null;
  prNumber: number | null;
  prUrl: string | null;
  state: PullRequestState;
  checks: ChecksState | null;
  lastFeedbackAt: Date | null;
  lastFeedback: string | null;
  lastFeedbackUrl: string | null;
  pendingSince: Date | null;
  continuations: number;
  lastContinuedAt: Date | null;
  lastContinuedRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const ROW_SELECT = {
  id: true,
  repoFullName: true,
  branch: true,
  runId: true,
  threadId: true,
  prNumber: true,
  prUrl: true,
  state: true,
  checks: true,
  lastFeedbackAt: true,
  lastFeedback: true,
  lastFeedbackUrl: true,
  pendingSince: true,
  continuations: true,
  lastContinuedAt: true,
  lastContinuedRunId: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** The workspace's agent PRs, newest activity first. */
export async function listAgentPullRequests(workspaceId: string, limit = 100): Promise<AgentPullRequestRow[]> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.agentPullRequest.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: "desc" },
      take: limit,
      select: ROW_SELECT,
    }),
  );
  return rows as AgentPullRequestRow[];
}

export async function getAgentPullRequest(workspaceId: string, id: string): Promise<AgentPullRequestRow | null> {
  const row = await withWorkspaceScope(workspaceId, (tx) =>
    tx.agentPullRequest.findFirst({ where: { id, workspaceId }, select: ROW_SELECT }),
  );
  return (row as AgentPullRequestRow | null) ?? null;
}
