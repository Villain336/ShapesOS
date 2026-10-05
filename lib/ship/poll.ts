// ShapesOS — Phase 9 (repos): poll agent PRs for feedback (webhook fallback).
//
// For installs that reach GitHub with a personal access token and have no
// webhook pointed at /api/hooks/github: every few minutes the cron job
// `github-prs` (lib/cron/jobs.ts) reads each open agent PR — reviews, line
// comments, conversation comments and the rolled-up checks — and feeds what
// is new into the same recordPrFeedback path the webhook uses. Opt-in:
// GITHUB_PR_POLL=on (off by default, so nothing calls GitHub on a schedule
// unless asked). Items are keyed "poll:<kind>:<id>", so a comment is recorded
// once however often it is seen; the same rules as the webhook apply (bots
// and non-collaborators are ignored; approvals and passing checks are
// recorded, not acted on).

import type {
  GitHubIssueComment,
  GitHubPrStatus,
  GitHubReview,
  GitHubReviewComment,
} from "@/lib/connectors/types";
import { resolveRepoAccess, type RepoAccess } from "./access";
import { isBotLogin, isTrustedAssociation } from "./github-events";
import {
  discoverOpenPullRequests,
  getAgentPullRequest,
  listAgentPullRequests,
  recordPrFeedback,
  type AgentPullRequestRow,
  type FeedbackItem,
  type FeedbackUpdate,
  type PullRequestRoute,
  type RecordFeedbackResult,
} from "./pull-requests";

type EnvLike = Record<string, string | undefined>;

/** GITHUB_PR_POLL=on|1|true turns the poller on (default off). */
export function prPollEnabled(env: EnvLike = process.env): boolean {
  return /^(1|true|on|yes)$/i.test((env.GITHUB_PR_POLL ?? "").trim());
}

/** PRs one pass reads (oldest-updated first, so every PR gets its turn). */
export const POLL_BATCH = 50;

function after(iso: string | null | undefined, cursor: Date): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) || d.getTime() <= cursor.getTime() ? null : d;
}

function oneLine(s: string, max = 600): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Turn what the API returned into feedback items newer than the PR's cursor. PURE. */
export function feedbackFromPoll(
  row: Pick<AgentPullRequestRow, "lastFeedbackAt" | "checks" | "state"> & { createdAt?: Date },
  data: {
    status: GitHubPrStatus;
    reviews: readonly GitHubReview[];
    comments: readonly GitHubReviewComment[];
    conversation: readonly GitHubIssueComment[];
  },
): { items: FeedbackItem[]; update: FeedbackUpdate } {
  const cursor = row.lastFeedbackAt ?? row.createdAt ?? new Date(0);
  const items: FeedbackItem[] = [];
  const pr = data.status.pr;
  const trusted = (author: string, assoc: string | undefined) => !isBotLogin(author) && isTrustedAssociation(assoc);

  for (const r of data.reviews) {
    const at = after(r.submittedAt, cursor);
    if (!at || !trusted(r.author, r.authorAssociation)) continue;
    const body = oneLine(r.body);
    const state = r.state.toUpperCase();
    if (state === "APPROVED") {
      items.push({ deliveryId: `poll:review:${r.id}`, event: "poll", action: "review", kind: "info", author: r.author, url: r.url, at, summary: `${r.author} approved${body ? `: ${body}` : ""}` });
    } else if (state === "CHANGES_REQUESTED" || state === "COMMENTED") {
      const summary = state === "CHANGES_REQUESTED" ? `${r.author} requested changes${body ? `: ${body}` : ""}` : body ? `${r.author} reviewed: ${body}` : `${r.author} left review comments`;
      items.push({ deliveryId: `poll:review:${r.id}`, event: "poll", action: "review", kind: "feedback", author: r.author, url: r.url, at, summary });
    }
  }
  for (const c of data.comments) {
    const at = after(c.createdAt, cursor);
    if (!at || !trusted(c.author, c.authorAssociation)) continue;
    items.push({
      deliveryId: `poll:review-comment:${c.id}`,
      event: "poll",
      action: "review_comment",
      kind: "feedback",
      author: c.author,
      url: c.url,
      at,
      summary: `${c.author} on ${c.path}${c.line ? `:${c.line}` : ""}: ${oneLine(c.body)}`,
    });
  }
  for (const c of data.conversation) {
    const at = after(c.createdAt, cursor);
    if (!at || !trusted(c.author, c.authorAssociation)) continue;
    items.push({ deliveryId: `poll:comment:${c.id}`, event: "poll", action: "comment", kind: "feedback", author: c.author, url: c.url, at, summary: `${c.author} commented: ${oneLine(c.body)}` });
  }
  const sha = pr.headSha.slice(0, 12);
  if (data.status.state === "failure" && row.checks !== "failure") {
    const names = data.status.failing.map((c) => `${c.name}${c.summary ? ` (${oneLine(c.summary, 120)})` : ""}`).join(", ");
    items.push({ deliveryId: `poll:checks:${sha}`, event: "poll", action: "checks", kind: "feedback", author: null, url: data.status.failing[0]?.url ?? null, summary: `Checks failing on ${sha.slice(0, 7)}: ${names || "see the PR"}` });
  } else if (data.status.state === "success" && row.checks !== "success") {
    items.push({ deliveryId: `poll:checks-ok:${sha}`, event: "poll", action: "checks", kind: "info", author: null, url: pr.url, summary: `Checks passed on ${sha.slice(0, 7)}` });
  }
  items.sort((a, b) => (a.at?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.at?.getTime() ?? Number.MAX_SAFE_INTEGER));
  const state = pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open";
  return { items, update: { prNumber: pr.number, prUrl: pr.url, state, checks: data.status.state } };
}

export interface PollDeps {
  discover: () => Promise<PullRequestRoute[]>;
  listWorkspace: (workspaceId: string) => Promise<AgentPullRequestRow[]>;
  getRow: (workspaceId: string, id: string) => Promise<AgentPullRequestRow | null>;
  access: (workspaceId: string, repoFullName: string) => Promise<RepoAccess>;
  record: (workspaceId: string, id: string, items: FeedbackItem[], update: FeedbackUpdate) => Promise<RecordFeedbackResult>;
}

export const defaultPollDeps: PollDeps = {
  discover: () => discoverOpenPullRequests(POLL_BATCH),
  listWorkspace: (ws) => listAgentPullRequests(ws, POLL_BATCH),
  getRow: getAgentPullRequest,
  access: (ws, repo) => resolveRepoAccess(ws, repo),
  record: (ws, id, items, update) => recordPrFeedback(ws, id, items, update),
};

export interface PollResult {
  checked: number;
  recorded: number;
  queued: number;
  skipped: number;
  errors: Array<{ pullRequestId: string; error: string }>;
}

/**
 * One pass. With a workspaceId (a signed-in editor ran the sweep) only that
 * workspace's PRs are read; the cron service call reads every workspace's.
 */
export async function pollAgentPullRequests(opts: { workspaceId?: string | null } = {}, deps: PollDeps = defaultPollDeps): Promise<PollResult> {
  const out: PollResult = { checked: 0, recorded: 0, queued: 0, skipped: 0, errors: [] };
  const targets: PullRequestRoute[] = opts.workspaceId
    ? (await deps.listWorkspace(opts.workspaceId))
        .filter((r) => r.state === "open" || r.state === "pushed")
        .map((r) => ({ id: r.id, workspaceId: opts.workspaceId! }))
    : await deps.discover();
  for (const t of targets.slice(0, POLL_BATCH)) {
    try {
      const row = await deps.getRow(t.workspaceId, t.id);
      if (!row || (row.state !== "open" && row.state !== "pushed")) continue;
      const access = await deps.access(t.workspaceId, row.repoFullName);
      if (access.mode === "mock") {
        out.skipped++;
        continue;
      }
      let prNumber = row.prNumber;
      if (!prNumber) {
        const found = await access.connector.findPullRequestForBranch(row.branch);
        if (!found) {
          out.skipped++;
          continue;
        }
        prNumber = found.number;
      }
      const [status, reviews, comments, conversation] = await Promise.all([
        access.connector.getPullRequestStatus(prNumber),
        access.connector.listReviews(prNumber),
        access.connector.listReviewComments(prNumber),
        access.connector.listIssueComments(prNumber),
      ]);
      out.checked++;
      const { items, update } = feedbackFromPoll(row, { status, reviews, comments, conversation });
      const res = await deps.record(t.workspaceId, row.id, items, update);
      out.recorded += res.recorded;
      if (res.queued) out.queued++;
    } catch (err) {
      out.errors.push({ pullRequestId: t.id, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    }
  }
  return out;
}
