// ShapesOS — Phase 9 (repos): GitHub webhook events → agent PR feedback (PURE).
//
// What the receiver (lib/ship/github-webhook.ts) needs to decide about one
// delivery before it touches the database:
//
//   verifyGitHubSignature  X-Hub-Signature-256 = "sha256=" + hex HMAC-SHA256
//                          of the raw body with GITHUB_WEBHOOK_SECRET — the
//                          same scheme as Meta's, so the existing constant-time
//                          verifier (lib/substrate/graph/connectors/hmac.ts)
//                          is reused.
//   classifyGitHubEvent    which PR it is about (repository + head branch, or
//                          the PR number for conversation comments) and what
//                          it means:
//                            feedback — a person asks for work: a review that
//                              requests changes or comments, a line comment, a
//                              conversation comment, a failed check;
//                            info     — recorded only: an approval, passing
//                              checks, the PR closed / merged / reopened;
//                            ignore   — everything else, and always: bots
//                              (including our own GitHub App), people who are
//                              not repository collaborators (a public repo's
//                              drive-by comment must not steer an agent),
//                              branches that are not shapes/<runId>, forks.
//
// Nothing here trusts the payload beyond routing: the mapping is confirmed
// against the agent_pull_requests row (written from the run's ship state).

import { verifyMetaSignature } from "@/lib/substrate/graph/connectors/hmac";
import { isShipBranch } from "./git";
import type { ChecksState, FeedbackItem, FeedbackUpdate } from "./pull-requests";

export const GITHUB_EVENT_HEADER = "x-github-event";
export const GITHUB_DELIVERY_HEADER = "x-github-delivery";
export const GITHUB_SIGNATURE_HEADER = "x-hub-signature-256";

/** The events the receiver acts on (anything else is acknowledged and ignored). */
export const HANDLED_EVENTS = [
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
  "check_suite",
  "check_run",
  "pull_request",
] as const;

/** author_association values whose feedback may steer an agent. */
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function isTrustedAssociation(association: string | null | undefined): boolean {
  return !!association && TRUSTED_ASSOCIATIONS.has(association.toUpperCase());
}

/** GitHub bot accounts (Apps, Actions, Dependabot …) log in as "<name>[bot]". */
export function isBotLogin(login: string | null | undefined): boolean {
  return typeof login === "string" && /\[bot\]$/i.test(login.trim());
}

export function verifyGitHubSignature(secret: string, rawBody: string, header: string | null): { ok: boolean; reason?: string } {
  if (!header || !header.startsWith("sha256=")) return { ok: false, reason: "missing or malformed X-Hub-Signature-256" };
  return verifyMetaSignature(secret, rawBody, header);
}

/** A delivery id GitHub would send (a GUID); anything else is refused. */
export function validDeliveryId(id: string | null): id is string {
  return typeof id === "string" && /^[A-Za-z0-9-]{8,80}$/.test(id);
}

export type ClassifiedEvent =
  | { action: "ignore"; reason: string }
  | {
      action: "route";
      repoFullName: string;
      /** Head branch (shapes/<runId>), when the event names it. */
      branch: string | null;
      prNumber: number | null;
      item: Omit<FeedbackItem, "deliveryId">;
      update: FeedbackUpdate;
    };

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}
function n(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}
function quote(body: string | null, max = 600): string {
  const t = (body ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
function at(v: unknown): Date | undefined {
  const t = s(v);
  if (!t) return undefined;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "action_required", "startup_failure"]);
const PASSED_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/** Who sent it: bots are never feedback. */
function senderIsBot(p: Obj): boolean {
  const sender = obj(p.sender);
  return s(sender?.type) === "Bot" || isBotLogin(s(sender?.login));
}

/** The PR's head must be an agent branch in the same repository (not a fork). */
function headOf(pr: Obj | null, repoFullName: string): { branch: string } | { reason: string } {
  const head = obj(pr?.head);
  const branch = s(head?.ref);
  if (!branch) return { reason: "no head branch" };
  if (!isShipBranch(branch)) return { reason: "not an agent branch" };
  const headRepo = s(obj(head?.repo)?.full_name);
  if (headRepo && headRepo.toLowerCase() !== repoFullName.toLowerCase()) return { reason: "head branch is in a fork" };
  return { branch };
}

function route(
  repoFullName: string,
  branch: string | null,
  prNumber: number | null,
  item: Omit<FeedbackItem, "deliveryId">,
  update: FeedbackUpdate = {},
): ClassifiedEvent {
  return { action: "route", repoFullName, branch, prNumber, item, update };
}

/** Decide what one webhook delivery means for agent PRs. PURE. */
export function classifyGitHubEvent(event: string, payload: unknown): ClassifiedEvent {
  const p = obj(payload);
  if (!p) return { action: "ignore", reason: "payload is not an object" };
  if (event === "ping") return { action: "ignore", reason: "ping" };
  if (!(HANDLED_EVENTS as readonly string[]).includes(event)) return { action: "ignore", reason: `event ${event} is not used` };
  const repoFullName = s(obj(p.repository)?.full_name);
  if (!repoFullName) return { action: "ignore", reason: "no repository" };
  const act = s(p.action);

  if (event === "pull_request_review") {
    if (act !== "submitted") return { action: "ignore", reason: `review ${act ?? "event"}` };
    if (senderIsBot(p)) return { action: "ignore", reason: "sent by a bot" };
    const pr = obj(p.pull_request);
    const review = obj(p.review);
    const head = headOf(pr, repoFullName);
    if ("reason" in head) return { action: "ignore", reason: head.reason };
    if (!isTrustedAssociation(s(review?.author_association))) return { action: "ignore", reason: "reviewer is not a repository collaborator" };
    const who = s(obj(review?.user)?.login) ?? "a reviewer";
    const state = (s(review?.state) ?? "").toLowerCase();
    const body = quote(s(review?.body));
    const base = { event, action: act, author: who, url: s(review?.html_url), at: at(review?.submitted_at) };
    const prInfo = { prNumber: n(pr?.number), prUrl: s(pr?.html_url) };
    if (state === "approved") return route(repoFullName, head.branch, n(pr?.number), { ...base, kind: "info", summary: `${who} approved${body ? `: ${body}` : ""}` }, prInfo);
    if (state === "changes_requested") {
      return route(repoFullName, head.branch, n(pr?.number), { ...base, kind: "feedback", summary: `${who} requested changes${body ? `: ${body}` : ""}` }, prInfo);
    }
    if (state === "commented") {
      return route(repoFullName, head.branch, n(pr?.number), { ...base, kind: "feedback", summary: body ? `${who} reviewed: ${body}` : `${who} left review comments` }, prInfo);
    }
    return { action: "ignore", reason: `review state ${state || "unknown"}` };
  }

  if (event === "pull_request_review_comment") {
    if (act !== "created") return { action: "ignore", reason: `review comment ${act ?? "event"}` };
    if (senderIsBot(p)) return { action: "ignore", reason: "sent by a bot" };
    const pr = obj(p.pull_request);
    const c = obj(p.comment);
    const head = headOf(pr, repoFullName);
    if ("reason" in head) return { action: "ignore", reason: head.reason };
    if (!isTrustedAssociation(s(c?.author_association))) return { action: "ignore", reason: "commenter is not a repository collaborator" };
    const who = s(obj(c?.user)?.login) ?? "a reviewer";
    const where = `${s(c?.path) ?? "a file"}${n(c?.line) ?? n(c?.original_line) ? `:${n(c?.line) ?? n(c?.original_line)}` : ""}`;
    return route(
      repoFullName,
      head.branch,
      n(pr?.number),
      { event, action: act, kind: "feedback", author: who, url: s(c?.html_url), at: at(c?.created_at), summary: `${who} on ${where}: ${quote(s(c?.body))}` },
      { prNumber: n(pr?.number), prUrl: s(pr?.html_url) },
    );
  }

  if (event === "issue_comment") {
    if (act !== "created") return { action: "ignore", reason: `comment ${act ?? "event"}` };
    const issue = obj(p.issue);
    if (!obj(issue?.pull_request)) return { action: "ignore", reason: "comment on an issue, not a pull request" };
    if (senderIsBot(p)) return { action: "ignore", reason: "sent by a bot" };
    const c = obj(p.comment);
    if (!isTrustedAssociation(s(c?.author_association))) return { action: "ignore", reason: "commenter is not a repository collaborator" };
    const prNumber = n(issue?.number);
    if (!prNumber) return { action: "ignore", reason: "no pull request number" };
    const who = s(obj(c?.user)?.login) ?? "someone";
    return route(repoFullName, null, prNumber, {
      event,
      action: act,
      kind: "feedback",
      author: who,
      url: s(c?.html_url),
      at: at(c?.created_at),
      summary: `${who} commented: ${quote(s(c?.body))}`,
    });
  }

  if (event === "check_suite" || event === "check_run") {
    if (act !== "completed") return { action: "ignore", reason: `${event} ${act ?? "event"}` };
    const run = event === "check_run" ? obj(p.check_run) : null;
    const suite = event === "check_suite" ? obj(p.check_suite) : obj(run?.check_suite);
    const branch = s(suite?.head_branch);
    if (!branch || !isShipBranch(branch)) return { action: "ignore", reason: "not an agent branch" };
    const conclusion = (s(run ? run.conclusion : suite?.conclusion) ?? "").toLowerCase();
    const prs = Array.isArray(suite?.pull_requests) ? (suite!.pull_requests as unknown[]) : [];
    const prNumber = n(obj(prs[0])?.number);
    const sha = (s(suite?.head_sha) ?? "").slice(0, 7);
    const name = run ? s(run.name) ?? "a check" : s(obj(obj(suite?.app))?.name) ?? "Checks";
    const url = s(run?.html_url) ?? s(run?.details_url) ?? null;
    if (FAILED_CONCLUSIONS.has(conclusion)) {
      const title = quote(s(obj(run?.output)?.title), 200);
      const checks: ChecksState = "failure";
      return route(
        repoFullName,
        branch,
        prNumber,
        { event, action: act, kind: "feedback", author: null, url, summary: `${name} ${conclusion.replace(/_/g, " ")}${sha ? ` on ${sha}` : ""}${title ? `: ${title}` : ""}` },
        { checks },
      );
    }
    if (PASSED_CONCLUSIONS.has(conclusion) && event === "check_suite") {
      const checks: ChecksState = "success";
      return route(repoFullName, branch, prNumber, { event, action: act, kind: "info", author: null, url, summary: `${name} passed${sha ? ` on ${sha}` : ""}` }, { checks });
    }
    return { action: "ignore", reason: `${event} ${conclusion || "without a conclusion"}` };
  }

  // pull_request: keep the PR's state in step (never starts work).
  const pr = obj(p.pull_request);
  const head = headOf(pr, repoFullName);
  if ("reason" in head) return { action: "ignore", reason: head.reason };
  const prNumber = n(pr?.number);
  const prUrl = s(pr?.html_url);
  const who = s(obj(p.sender)?.login);
  if (act === "closed") {
    const merged = pr?.merged === true;
    return route(
      repoFullName,
      head.branch,
      prNumber,
      { event, action: act, kind: "info", author: who, url: prUrl, summary: merged ? `Pull request merged${who ? ` by ${who}` : ""}` : `Pull request closed${who ? ` by ${who}` : ""}` },
      { prNumber, prUrl, state: merged ? "merged" : "closed" },
    );
  }
  if (act === "reopened" || act === "opened" || act === "ready_for_review") {
    return route(
      repoFullName,
      head.branch,
      prNumber,
      { event, action: act, kind: "info", author: who, url: prUrl, summary: `Pull request ${act.replace(/_/g, " ")}` },
      { prNumber, prUrl, state: "open" },
    );
  }
  return { action: "ignore", reason: `pull_request ${act ?? "event"}` };
}
