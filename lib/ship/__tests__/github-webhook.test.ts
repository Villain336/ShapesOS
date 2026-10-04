// ShapesOS — Phase 9 (repos): GitHub webhook signature, event classification,
// routing and dedupe (fake deps, no database), the poller's item mapping and
// the continuation message. The database path is lib/ship/__tests__/
// pr-feedback-db.test.ts.
// Run: env -u DATABASE_URL npx tsx --test lib/ship/__tests__/github-webhook.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  classifyGitHubEvent,
  isBotLogin,
  isTrustedAssociation,
  validDeliveryId,
  verifyGitHubSignature,
} from "../github-events";
import { receiveGitHubWebhook, type GitHubWebhookDeps } from "../github-webhook";
import { feedbackFromPoll, prPollEnabled } from "../poll";
import { deferralDelayMs, feedbackMessage, PR_FEEDBACK_PREFIX } from "../continue";
import type { FeedbackItem, FeedbackUpdate } from "../pull-requests";
import type { GitHubPrStatus } from "@/lib/connectors/types";

const SECRET = "whsec-test-0123456789";
const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
const REPO = { full_name: "acme/site" };
const BRANCH = "shapes/run_abc123";
const prPayload = (over: Record<string, unknown> = {}) => ({
  number: 12,
  html_url: "https://github.com/acme/site/pull/12",
  head: { ref: BRANCH, repo: REPO },
  ...over,
});
const human = { login: "alice", type: "User" };

function review(state: string, over: Record<string, unknown> = {}) {
  return {
    action: "submitted",
    repository: REPO,
    sender: human,
    pull_request: prPayload(),
    review: { state, body: "Please rename foo", user: { login: "alice" }, author_association: "MEMBER", html_url: "u", submitted_at: "2026-10-04T10:00:00Z", ...over },
  };
}

describe("signature and headers", () => {
  it("verifies X-Hub-Signature-256 over the exact raw body", () => {
    const body = '{"a":1}';
    assert.equal(verifyGitHubSignature(SECRET, body, sign(body)).ok, true);
    assert.equal(verifyGitHubSignature(SECRET, body + " ", sign(body)).ok, false, "one byte changed");
    assert.equal(verifyGitHubSignature(SECRET, body, sign(body, "other")).ok, false, "wrong secret");
    assert.equal(verifyGitHubSignature(SECRET, body, sign(body).replace("sha256=", "sha1=")).ok, false);
    assert.equal(verifyGitHubSignature(SECRET, body, null).ok, false);
  });
  it("delivery ids, bots, associations", () => {
    assert.ok(validDeliveryId("72d3162e-cc78-11e3-81ab-4c9367dc0958"));
    assert.ok(!validDeliveryId("x"));
    assert.ok(!validDeliveryId("../etc"));
    assert.ok(!validDeliveryId(null));
    assert.ok(isBotLogin("github-actions[bot]") && isBotLogin("shapesos[bot]") && !isBotLogin("bot-fan"));
    assert.ok(isTrustedAssociation("OWNER") && isTrustedAssociation("member") && isTrustedAssociation("COLLABORATOR"));
    assert.ok(!isTrustedAssociation("CONTRIBUTOR") && !isTrustedAssociation("NONE") && !isTrustedAssociation(undefined));
  });
});

describe("classifyGitHubEvent", () => {
  it("reviews: changes requested / commented are feedback, approved is info", () => {
    const c = classifyGitHubEvent("pull_request_review", review("changes_requested"));
    assert.equal(c.action, "route");
    if (c.action !== "route") return;
    assert.equal(c.repoFullName, "acme/site");
    assert.equal(c.branch, BRANCH);
    assert.equal(c.prNumber, 12);
    assert.equal(c.item.kind, "feedback");
    assert.equal(c.item.summary, "alice requested changes: Please rename foo");
    assert.deepEqual(c.update, { prNumber: 12, prUrl: "https://github.com/acme/site/pull/12" });
    const a = classifyGitHubEvent("pull_request_review", review("approved", { body: "" }));
    assert.equal(a.action === "route" && a.item.kind, "info");
    const cm = classifyGitHubEvent("pull_request_review", review("commented", { body: null }));
    assert.equal(cm.action === "route" && cm.item.summary, "alice left review comments");
  });

  it("ignores bots, non-collaborators, other branches, forks and edits", () => {
    const why = (event: string, p: unknown) => {
      const c = classifyGitHubEvent(event, p);
      return c.action === "ignore" ? c.reason : "routed";
    };
    assert.equal(why("pull_request_review", { ...review("commented"), sender: { login: "shapesos[bot]", type: "Bot" } }), "sent by a bot");
    assert.equal(why("pull_request_review", review("commented", { author_association: "CONTRIBUTOR" })), "reviewer is not a repository collaborator");
    assert.equal(why("pull_request_review", { ...review("commented"), pull_request: prPayload({ head: { ref: "feature/x", repo: REPO } }) }), "not an agent branch");
    assert.equal(why("pull_request_review", { ...review("commented"), pull_request: prPayload({ head: { ref: BRANCH, repo: { full_name: "mallory/site" } } }) }), "head branch is in a fork");
    assert.equal(why("pull_request_review", { ...review("commented"), action: "edited" }), "review edited");
    assert.equal(why("push", { repository: REPO }), "event push is not used");
    assert.equal(why("ping", { zen: "x" }), "ping");
    assert.equal(why("issue_comment", { action: "created", repository: REPO, sender: human, issue: { number: 3 }, comment: { author_association: "OWNER" } }), "comment on an issue, not a pull request");
  });

  it("line comments and conversation comments", () => {
    const lc = classifyGitHubEvent("pull_request_review_comment", {
      action: "created",
      repository: REPO,
      sender: human,
      pull_request: prPayload(),
      comment: { path: "src/a.ts", line: 4, body: "off by one", user: { login: "bob" }, author_association: "COLLABORATOR", html_url: "u2" },
    });
    assert.equal(lc.action === "route" && lc.item.summary, "bob on src/a.ts:4: off by one");
    const ic = classifyGitHubEvent("issue_comment", {
      action: "created",
      repository: REPO,
      sender: human,
      issue: { number: 12, pull_request: { url: "x" } },
      comment: { body: "also the README", user: { login: "carol" }, author_association: "OWNER" },
    });
    assert.equal(ic.action, "route");
    if (ic.action !== "route") return;
    assert.equal(ic.branch, null, "routed by PR number");
    assert.equal(ic.prNumber, 12);
    assert.equal(ic.item.kind, "feedback");
  });

  it("checks: failures are feedback, a passing suite is info, check_run successes are ignored", () => {
    const suite = (conclusion: string) => ({
      action: "completed",
      repository: REPO,
      sender: { login: "github-actions[bot]", type: "Bot" },
      check_suite: { head_branch: BRANCH, head_sha: "abcdef1234", conclusion, pull_requests: [{ number: 12 }], app: { name: "GitHub Actions" } },
    });
    const f = classifyGitHubEvent("check_suite", suite("failure"));
    assert.equal(f.action, "route", "bot-sent check events still count");
    if (f.action === "route") {
      assert.equal(f.item.kind, "feedback");
      assert.deepEqual(f.update, { checks: "failure" });
      assert.equal(f.item.summary, "GitHub Actions failure on abcdef1");
    }
    const ok = classifyGitHubEvent("check_suite", suite("success"));
    assert.equal(ok.action === "route" && ok.item.kind, "info");
    const run = (conclusion: string) => ({
      action: "completed",
      repository: REPO,
      check_run: { name: "unit", conclusion, html_url: "c", output: { title: "3 failed" }, check_suite: { head_branch: BRANCH, head_sha: "abc" } },
    });
    const rf = classifyGitHubEvent("check_run", run("timed_out"));
    assert.equal(rf.action === "route" && rf.item.summary, "unit timed out on abc: 3 failed");
    assert.equal(classifyGitHubEvent("check_run", run("success")).action, "ignore");
  });

  it("pull_request state changes are info", () => {
    const merged = classifyGitHubEvent("pull_request", { action: "closed", repository: REPO, sender: human, pull_request: prPayload({ merged: true }) });
    assert.equal(merged.action === "route" && merged.update.state, "merged");
    assert.equal(merged.action === "route" && merged.item.kind, "info");
    assert.equal(classifyGitHubEvent("pull_request", { action: "synchronize", repository: REPO, pull_request: prPayload() }).action, "ignore");
  });
});

describe("receiveGitHubWebhook (fake deps)", () => {
  function harness(opts: { routeTo?: { id: string; workspaceId: string } | null; secret?: string } = {}) {
    const seen = new Set<string>();
    const calls: Array<{ ws: string; id: string; items: FeedbackItem[]; update: FeedbackUpdate }> = [];
    const routes: unknown[] = [];
    const deps: GitHubWebhookDeps = {
      secret: () => opts.secret ?? SECRET,
      route: async (q) => {
        routes.push(q);
        return opts.routeTo === undefined ? { id: "pr1", workspaceId: "ws-a" } : opts.routeTo;
      },
      record: async (ws, id, items, update) => {
        calls.push({ ws, id, items, update });
        const fresh = items.filter((i) => !seen.has(i.deliveryId));
        for (const i of fresh) seen.add(i.deliveryId);
        return { recorded: fresh.length, duplicates: items.length - fresh.length, queued: fresh.some((i) => i.kind === "feedback"), coalesced: false };
      },
    };
    return { deps, calls, routes };
  }
  const body = JSON.stringify(review("changes_requested"));
  const input = (over: Partial<Parameters<typeof receiveGitHubWebhook>[0]> = {}) => ({
    event: "pull_request_review",
    deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    signature: sign(body),
    rawBody: body,
    ...over,
  });

  it("verified feedback is routed to its PR and queued; a redelivery is a duplicate", async () => {
    const h = harness();
    const r = await receiveGitHubWebhook(input(), h.deps);
    assert.equal(r.status, 202);
    assert.deepEqual(r.body, { recorded: 1, kind: "feedback", queued: true, coalesced: false });
    assert.deepEqual(h.routes, [{ repoFullName: "acme/site", branch: BRANCH, prNumber: 12 }]);
    assert.equal(h.calls[0]!.ws, "ws-a");
    assert.equal(h.calls[0]!.items[0]!.deliveryId, "72d3162e-cc78-11e3-81ab-4c9367dc0958");
    const again = await receiveGitHubWebhook(input(), h.deps);
    assert.deepEqual(again, { status: 200, body: { duplicate: true } });
  });

  it("refuses before any routing: no secret 503, bad signature 401, bad delivery id 400, non-JSON 400", async () => {
    const h = harness();
    assert.equal((await receiveGitHubWebhook(input(), harness({ secret: "" }).deps)).status, 503);
    assert.equal((await receiveGitHubWebhook(input({ signature: sign(body, "nope") }), h.deps)).status, 401);
    assert.equal((await receiveGitHubWebhook(input({ signature: null }), h.deps)).status, 401);
    assert.equal((await receiveGitHubWebhook(input({ deliveryId: "" }), h.deps)).status, 400);
    assert.equal((await receiveGitHubWebhook(input({ rawBody: "nope", signature: sign("nope") }), h.deps)).status, 400);
    assert.equal(h.routes.length, 0, "nothing was routed");
    assert.equal(h.calls.length, 0, "nothing was recorded");
  });

  it("ignored events and unknown PRs are acknowledged with 200, nothing recorded", async () => {
    const h = harness({ routeTo: null });
    const bot = JSON.stringify({ ...review("commented"), sender: { login: "x[bot]", type: "Bot" } });
    assert.deepEqual(await receiveGitHubWebhook(input({ rawBody: bot, signature: sign(bot) }), h.deps), { status: 200, body: { ignored: "sent by a bot" } });
    assert.deepEqual(await receiveGitHubWebhook(input(), h.deps), { status: 200, body: { ignored: "not an agent pull request" } });
    assert.equal(h.calls.length, 0);
  });
});

describe("poller mapping and the continuation message", () => {
  const status = (state: GitHubPrStatus["state"], over: Partial<GitHubPrStatus["pr"]> = {}): GitHubPrStatus => ({
    pr: { number: 12, url: "pr-url", title: "t", body: "", state: "open", merged: false, draft: false, head: BRANCH, base: "main", headSha: "abcdef1234567890", mergeable: true, ...over },
    state,
    checks: [],
    failing: state === "failure" ? [{ name: "unit", source: "check_run", status: "completed", conclusion: "failure", url: "ci", summary: "2 failed" }] : [],
  });
  const cursor = new Date("2026-10-04T10:00:00Z");

  it("only new, human, collaborator feedback; failing checks once per head commit", () => {
    const { items, update } = feedbackFromPoll(
      { lastFeedbackAt: cursor, checks: "pending", state: "open" },
      {
        status: status("failure"),
        reviews: [
          { id: 1, author: "alice", state: "CHANGES_REQUESTED", body: "rename", url: "r1", submittedAt: "2026-10-04T11:00:00Z", authorAssociation: "MEMBER" },
          { id: 2, author: "alice", state: "COMMENTED", body: "old", url: "r2", submittedAt: "2026-10-04T09:00:00Z", authorAssociation: "MEMBER" },
          { id: 3, author: "drive-by", state: "COMMENTED", body: "pls", url: "r3", submittedAt: "2026-10-04T11:00:00Z", authorAssociation: "NONE" },
        ],
        comments: [{ id: 5, path: "a.ts", line: 2, body: "nit", author: "bob", url: "c5", createdAt: "2026-10-04T11:05:00Z", inReplyTo: null, authorAssociation: "COLLABORATOR" }],
        conversation: [
          { id: 6, body: "deployed", author: "vercel[bot]", url: "i6", createdAt: "2026-10-04T11:06:00Z", authorAssociation: "NONE" },
          { id: 7, body: "and docs", author: "carol", url: "i7", createdAt: "2026-10-04T11:07:00Z", authorAssociation: "OWNER" },
        ],
      },
    );
    assert.deepEqual(
      items.map((i) => [i.deliveryId, i.kind]),
      [
        ["poll:review:1", "feedback"],
        ["poll:review-comment:5", "feedback"],
        ["poll:comment:7", "feedback"],
        ["poll:checks:abcdef123456", "feedback"],
      ],
    );
    assert.deepEqual(update, { prNumber: 12, prUrl: "pr-url", state: "open", checks: "failure" });
    const again = feedbackFromPoll({ lastFeedbackAt: new Date("2026-10-04T12:00:00Z"), checks: "failure", state: "open" }, { status: status("failure"), reviews: [], comments: [], conversation: [] });
    assert.equal(again.items.length, 0, "already-known failing checks are not re-reported");
    const merged = feedbackFromPoll({ lastFeedbackAt: cursor, checks: null, state: "open" }, { status: status("success", { state: "closed", merged: true }), reviews: [], comments: [], conversation: [] });
    assert.equal(merged.update.state, "merged");
    assert.deepEqual(merged.items.map((i) => i.kind), ["info"]);
  });

  it("the poller is opt-in", () => {
    assert.equal(prPollEnabled({}), false);
    assert.equal(prPollEnabled({ GITHUB_PR_POLL: "off" }), false);
    assert.equal(prPollEnabled({ GITHUB_PR_POLL: "on" }), true);
    assert.equal(prPollEnabled({ GITHUB_PR_POLL: "1" }), true);
  });

  it("the continuation message names the PR, quotes feedback and keeps the branch and the gates", () => {
    const m = feedbackMessage({
      repoFullName: "acme/site",
      branch: BRANCH,
      prNumber: 12,
      prUrl: "https://github.com/acme/site/pull/12",
      items: [{ summary: "alice requested changes:\nrename", url: "u" }],
      more: 2,
    });
    assert.ok(m.startsWith(`${PR_FEEDBACK_PREFIX} #12 (acme/site, branch ${BRANCH})`));
    assert.match(m, /> alice requested changes: rename \(u\)/);
    assert.match(m, /and 2 more/);
    assert.match(m, /read_pr_feedback/);
    assert.match(m, /run_checks/);
    assert.match(m, /git_push_branch \(it waits for approval\)/);
    assert.equal(deferralDelayMs(0), 30_000);
    assert.equal(deferralDelayMs(1), 60_000);
    assert.equal(deferralDelayMs(10), 600_000);
  });
});
