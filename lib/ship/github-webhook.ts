// ShapesOS — Phase 9 (repos): the GitHub webhook receiver.
//
// POST /api/hooks/github (app/api/hooks/github/route.ts) hands the raw body
// and three headers here. In order, before any write:
//   1. GITHUB_WEBHOOK_SECRET must be set (else 503: the receiver is off);
//   2. X-Hub-Signature-256 must verify over the exact raw bytes (else 401);
//   3. X-GitHub-Delivery must look like a delivery id (else 400);
//   4. the event is classified (lib/ship/github-events.ts) — bots, people who
//      are not collaborators, non-agent branches and unused events are
//      acknowledged and ignored (200);
//   5. (repository, branch | PR number) is routed to the agent PR it is about
//      (agent_pull_requests, the one cross-workspace SELECT) — unknown → 200
//      ignored, so a repository with other PRs never errors;
//   6. recordPrFeedback stores the delivery under the PR's workspace (its id
//      is the primary key: a redelivery is a duplicate and does nothing) and,
//      for feedback on an open PR, queues ONE `pr_feedback` agent job; the
//      job continues the work in the same chat thread, on the same branch.
//
// Responses carry counts and reasons only — never workspace or run data.

import {
  classifyGitHubEvent,
  validDeliveryId,
  verifyGitHubSignature,
} from "./github-events";
import {
  recordPrFeedback,
  routePullRequest,
  type FeedbackItem,
  type FeedbackUpdate,
  type PullRequestRoute,
  type RecordFeedbackResult,
} from "./pull-requests";

export interface GitHubWebhookInput {
  event: string | null;
  deliveryId: string | null;
  signature: string | null;
  rawBody: string;
}

export interface GitHubWebhookResult {
  status: number;
  body: Record<string, unknown>;
}

export interface GitHubWebhookDeps {
  secret: () => string;
  route: (q: { repoFullName: string; branch: string | null; prNumber: number | null }) => Promise<PullRequestRoute | null>;
  record: (workspaceId: string, pullRequestId: string, items: FeedbackItem[], update: FeedbackUpdate) => Promise<RecordFeedbackResult>;
}

export const defaultGitHubWebhookDeps: GitHubWebhookDeps = {
  secret: () => (process.env.GITHUB_WEBHOOK_SECRET ?? "").trim(),
  route: routePullRequest,
  record: (ws, id, items, update) => recordPrFeedback(ws, id, items, update),
};

/** Most GitHub deliveries are a few KB; a PR payload with a big body stays well under this. */
export const GITHUB_WEBHOOK_MAX_BYTES = 1024 * 1024;

export async function receiveGitHubWebhook(
  input: GitHubWebhookInput,
  deps: GitHubWebhookDeps = defaultGitHubWebhookDeps,
): Promise<GitHubWebhookResult> {
  const secret = deps.secret();
  if (!secret) return { status: 503, body: { error: "GitHub webhooks are not configured (GITHUB_WEBHOOK_SECRET is unset)." } };
  const sig = verifyGitHubSignature(secret, input.rawBody, input.signature);
  if (!sig.ok) return { status: 401, body: { error: "Invalid signature." } };
  if (!validDeliveryId(input.deliveryId)) return { status: 400, body: { error: "Missing X-GitHub-Delivery." } };
  const event = (input.event ?? "").trim();
  if (!event) return { status: 400, body: { error: "Missing X-GitHub-Event." } };

  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return { status: 400, body: { error: "The body is not JSON." } };
  }

  const c = classifyGitHubEvent(event, payload);
  if (c.action === "ignore") return { status: 200, body: { ignored: c.reason } };

  const pr = await deps.route({ repoFullName: c.repoFullName, branch: c.branch, prNumber: c.prNumber });
  if (!pr) return { status: 200, body: { ignored: "not an agent pull request" } };

  const res = await deps.record(pr.workspaceId, pr.id, [{ ...c.item, deliveryId: input.deliveryId }], c.update);
  if (res.duplicates > 0 && res.recorded === 0) return { status: 200, body: { duplicate: true } };
  return {
    status: 202,
    body: {
      recorded: res.recorded,
      kind: c.item.kind,
      queued: res.queued,
      coalesced: res.coalesced,
      ...(res.skipped ? { skipped: res.skipped } : {}),
    },
  };
}
