// ShapesOS — Phase 9 (repos), end to end against Postgres (as the app role):
//   1. A pushed branch / opened PR on a run's ship state is registered in
//      agent_pull_requests (FORCE RLS; the routing policy is SELECT-only).
//   2. A signed GitHub delivery → routed to that workspace → stored once (a
//      redelivery is a duplicate) → ONE pr_feedback agent job; more feedback
//      coalesces into it; bots and unknown branches change nothing.
//   3. The pr_feedback job continues in the SAME chat thread on the SAME
//      branch: a user message quoting the feedback, a new tracked run queued
//      as a chat_turn job; while the thread is busy the job defers itself.
//   4. A merged PR never starts work; nothing leaks across workspaces.
// The model is never called (the continuation is queued for the worker).
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… npx tsx --test lib/ship/__tests__/pr-feedback-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { countWithoutScope, withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { createAgentRun } from "@/lib/agents/runs/service";
import { setSandboxProviderForTests } from "@/lib/sandbox/index";
import { defaultAgentJobHandlers } from "@/lib/agents/queue/handlers";
import { loadShipState, saveShipState, type ShipState } from "../state";
import { receiveGitHubWebhook } from "../github-webhook";
import { routePullRequest } from "../pull-requests";
import { PR_FEEDBACK_PREFIX, type ContinueOutcome } from "../continue";

const RUN = `p9r-${Date.now().toString(36)}`;
const WS_A = `${RUN}-a`;
const WS_B = `${RUN}-b`;
const USER = `${RUN}-user`;
const SECRET = "whsec-db-test-0123456789";
const REPO = `acme/site-${RUN}`;
let projectId = "";
let threadId = "";
let cloneRunId = "";
let branch = "";
let prId = "";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["GITHUB_WEBHOOK_SECRET", "AGENT_WORKER"];

function deliver(event: string, payload: unknown, deliveryId = randomUUID()) {
  const rawBody = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", SECRET).update(rawBody, "utf8").digest("hex")}`;
  return receiveGitHubWebhook({ event, deliveryId, signature, rawBody });
}

const review = (state: string, body: string, sender = { login: "alice", type: "User" }) => ({
  action: "submitted",
  repository: { full_name: REPO },
  sender,
  pull_request: { number: 12, html_url: `https://github.com/${REPO}/pull/12`, head: { ref: branch, repo: { full_name: REPO } } },
  review: { state, body, user: { login: sender.login }, author_association: "MEMBER", html_url: "https://github.com/r/1", submitted_at: new Date().toISOString() },
});

const jobs = (ws: string, kind: string) =>
  withWorkspaceScope(ws, (tx) => tx.agentJob.findMany({ where: { workspaceId: ws, kind }, orderBy: { createdAt: "asc" } }));

async function runPrFeedbackJob(job: { id: string; workspaceId: string; payload: unknown; runId: string | null }): Promise<ContinueOutcome> {
  const ac = new AbortController();
  return (await defaultAgentJobHandlers.pr_feedback!(
    { id: job.id, workspaceId: job.workspaceId, kind: "pr_feedback", payload: job.payload, attempts: 1, maxAttempts: 3, runId: job.runId },
    { signal: ac.signal, workerId: "test" },
  )) as ContinueOutcome;
}

before(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  delete process.env.AGENT_WORKER; // internal: queued work has a worker
  // No real sandbox provider, whatever the host has (CI has Docker).
  setSandboxProviderForTests(null);
  for (const id of [WS_A, WS_B]) await prisma.workspace.create({ data: { id, name: `P9 ${id}`, ownerUserId: USER } });
  await prisma.workspaceMember.create({ data: { workspaceId: WS_A, userId: USER, role: "editor", email: `${RUN}@example.com` } });
  projectId = (await prisma.project.create({ data: { workspaceId: WS_A, domain: `${RUN}.example` } })).id;
  threadId = (
    await prisma.aiChatThread.create({ data: { projectId, userId: USER, title: "Fix the site", agentKey: "actor", allowedTools: ["workspace", "code", "ship"] } })
  ).id;
  cloneRunId = (await createAgentRun({ workspaceId: WS_A, kind: "chat", startedBy: USER, threadId, agentKey: "actor", allowedTools: ["workspace", "code", "ship"] })).id;
  branch = `shapes/${cloneRunId}`;
  // The run that cloned and pushed has finished (a live run would make the thread busy).
  await withWorkspaceScope(WS_A, (tx) => tx.agentRun.update({ where: { id: cloneRunId }, data: { status: "succeeded", endedAt: new Date() } }));
});

after(async () => {
  setSandboxProviderForTests(undefined);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const id of [WS_A, WS_B]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

describe("Phase 9: agent PR registry", () => {
  it("a clone alone registers nothing; a push and a PR do", async () => {
    const base: ShipState = { repo: REPO, dir: "/work/site", defaultBranch: "main", baseBranch: "main", baseSha: "a".repeat(40), branch, cloneRunId, mode: "pat" };
    await saveShipState(WS_A, cloneRunId, base);
    assert.equal(await withWorkspaceScope(WS_A, (tx) => tx.agentPullRequest.count({ where: { workspaceId: WS_A } })), 0);
    await saveShipState(WS_A, cloneRunId, { ...base, pushedSha: "b".repeat(40), branchUrl: "u" });
    let row = await withWorkspaceScope(WS_A, (tx) => tx.agentPullRequest.findFirstOrThrow({ where: { workspaceId: WS_A } }));
    assert.equal(row.state, "pushed");
    assert.equal(row.threadId, threadId);
    assert.equal(row.runId, cloneRunId);
    assert.equal(row.repoFullName, REPO.toLowerCase());
    await saveShipState(WS_A, cloneRunId, { ...base, pushedSha: "b".repeat(40), prNumber: 12, prUrl: `https://github.com/${REPO}/pull/12` });
    row = await withWorkspaceScope(WS_A, (tx) => tx.agentPullRequest.findFirstOrThrow({ where: { workspaceId: WS_A } }));
    assert.equal(row.state, "open");
    assert.equal(row.prNumber, 12);
    prId = row.id;
  });

  it("FORCE RLS: invisible without the GUC and to another workspace; the routing policy only reads", async () => {
    assert.equal(await countWithoutScope("agent_pull_requests"), 0);
    assert.equal(await withWorkspaceScope(WS_B, (tx) => tx.agentPullRequest.count()), 0);
    assert.deepEqual(await routePullRequest({ repoFullName: REPO.toUpperCase(), branch }), { id: prId, workspaceId: WS_A });
    assert.deepEqual(await routePullRequest({ repoFullName: REPO, prNumber: 12 }), { id: prId, workspaceId: WS_A });
    assert.equal(await routePullRequest({ repoFullName: REPO, branch: "shapes/nope" }), null);
    const written = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.github_route = 'lookup'`);
      return tx.agentPullRequest.updateMany({ where: { id: prId }, data: { state: "closed" } });
    });
    assert.equal(written.count, 0, "SELECT-only: the routing GUC cannot write");
  });
});

describe("Phase 9: webhook → job → continuation", () => {
  it("bots, non-agent branches and bad signatures change nothing", async () => {
    const bot = await deliver("pull_request_review", review("commented", "LGTM", { login: "ci[bot]", type: "Bot" }));
    assert.deepEqual(bot.body, { ignored: "sent by a bot" });
    const other = await deliver("pull_request_review", { ...review("commented", "x"), pull_request: { number: 9, head: { ref: "shapes/someone-else", repo: { full_name: REPO } } } });
    assert.deepEqual(other.body, { ignored: "not an agent pull request" });
    const forged = await receiveGitHubWebhook({ event: "pull_request_review", deliveryId: randomUUID(), signature: "sha256=00", rawBody: JSON.stringify(review("commented", "x")) });
    assert.equal(forged.status, 401);
    assert.equal(await withWorkspaceScope(WS_A, (tx) => tx.gitHubWebhookDelivery.count({ where: { workspaceId: WS_A } })), 0);
    assert.equal((await jobs(WS_A, "pr_feedback")).length, 0);
  });

  it("review feedback queues ONE job; a redelivery is a duplicate; more feedback coalesces", async () => {
    const id = randomUUID();
    const first = await deliver("pull_request_review", review("changes_requested", "Rename foo to bar"), id);
    assert.equal(first.status, 202);
    assert.deepEqual(first.body, { recorded: 1, kind: "feedback", queued: true, coalesced: false });
    const dup = await deliver("pull_request_review", review("changes_requested", "Rename foo to bar"), id);
    assert.deepEqual(dup.body, { duplicate: true });
    const more = await deliver("pull_request_review_comment", {
      action: "created",
      repository: { full_name: REPO },
      sender: { login: "bob", type: "User" },
      pull_request: { number: 12, head: { ref: branch, repo: { full_name: REPO } } },
      comment: { path: "src/a.ts", line: 3, body: "off by one", user: { login: "bob" }, author_association: "COLLABORATOR", html_url: "c" },
    });
    assert.deepEqual(more.body, { recorded: 1, kind: "feedback", queued: false, coalesced: true });
    const q = await jobs(WS_A, "pr_feedback");
    assert.equal(q.length, 1);
    assert.deepEqual(q[0]!.payload, { workspaceId: WS_A, pullRequestId: prId });
    assert.ok(q[0]!.runAfter.getTime() > Date.now(), "debounced");
    const pr = await withWorkspaceScope(WS_A, (tx) => tx.agentPullRequest.findFirstOrThrow({ where: { id: prId } }));
    assert.ok(pr.pendingSince);
    assert.match(pr.lastFeedback ?? "", /bob on src\/a\.ts:3: off by one/);
    // Nothing of this is visible from workspace B.
    assert.equal(await withWorkspaceScope(WS_B, (tx) => tx.gitHubWebhookDelivery.count()), 0);
    assert.equal((await jobs(WS_B, "pr_feedback")).length, 0);
  });

  it("the job continues the same thread on the same branch (queued chat turn)", async () => {
    const [job] = await jobs(WS_A, "pr_feedback");
    const out = await runPrFeedbackJob(job!);
    assert.equal(out.status, "continued");
    if (out.status !== "continued") return;
    assert.equal(out.items, 2);
    const run = await withWorkspaceScope(WS_A, (tx) => tx.agentRun.findFirstOrThrow({ where: { id: out.runId } }));
    assert.equal(run.threadId, threadId);
    assert.equal(run.startedBy, USER);
    assert.equal(run.agentKey, "actor");
    const turnJobs = await jobs(WS_A, "chat_turn");
    assert.ok(turnJobs.some((j) => j.runId === out.runId), "queued for the agent worker");
    const msg = await prisma.aiChatMessage.findFirstOrThrow({ where: { threadId, role: "user" }, orderBy: { createdAt: "desc" } });
    assert.ok(msg.content.startsWith(`${PR_FEEDBACK_PREFIX} #12`));
    assert.match(msg.content, /alice requested changes: Rename foo to bar/);
    assert.match(msg.content, /bob on src\/a\.ts:3: off by one/);
    // Same branch: the new run resolves the thread's ship state.
    assert.equal((await loadShipState({ workspaceId: WS_A, runId: out.runId }))?.branch, branch);
    const pr = await withWorkspaceScope(WS_A, (tx) => tx.agentPullRequest.findFirstOrThrow({ where: { id: prId } }));
    assert.equal(pr.pendingSince, null);
    assert.equal(pr.continuations, 1);
    assert.equal(pr.lastContinuedRunId, out.runId);
    const consumed = await withWorkspaceScope(WS_A, (tx) => tx.gitHubWebhookDelivery.count({ where: { pullRequestId: prId, continuedRunId: out.runId } }));
    assert.equal(consumed, 2);
  });

  it("while that turn is still live, new feedback waits (the job defers itself)", async () => {
    const res = await deliver("issue_comment", {
      action: "created",
      repository: { full_name: REPO },
      sender: { login: "carol", type: "User" },
      issue: { number: 12, pull_request: { url: "x" } },
      comment: { body: "also the README", user: { login: "carol" }, author_association: "OWNER", html_url: "i" },
    });
    assert.equal((res.body as { queued: boolean }).queued, true);
    const pending = (await jobs(WS_A, "pr_feedback")).filter((j) => j.status === "queued");
    const newest = pending[pending.length - 1]!;
    const out = await runPrFeedbackJob(newest);
    assert.equal(out.status, "deferred");
    const after = (await jobs(WS_A, "pr_feedback")).filter((j) => j.status === "queued");
    assert.ok(after.some((j) => (j.payload as { deferrals?: number }).deferrals === 1), "re-queued with backoff");
  });

  it("a merged PR is recorded and never starts work", async () => {
    const merged = await deliver("pull_request", {
      action: "closed",
      repository: { full_name: REPO },
      sender: { login: "alice", type: "User" },
      pull_request: { number: 12, merged: true, html_url: "p", head: { ref: branch, repo: { full_name: REPO } } },
    });
    assert.equal(merged.status, 202);
    const pr = await withWorkspaceScope(WS_A, (tx) => tx.agentPullRequest.findFirstOrThrow({ where: { id: prId } }));
    assert.equal(pr.state, "merged");
    const late = await deliver("pull_request_review", review("changes_requested", "one more thing"));
    assert.equal((late.body as { queued: boolean }).queued, false);
    assert.equal((late.body as { skipped?: string }).skipped, "the pull request is merged");
    const deferred = (await jobs(WS_A, "pr_feedback")).filter((j) => j.status === "queued" && (j.payload as { deferrals?: number }).deferrals === 1)[0]!;
    assert.deepEqual(await runPrFeedbackJob(deferred), { status: "skipped", reason: "the pull request is merged" });
  });
});
