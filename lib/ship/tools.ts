// ShapesOS — Phase 8 (ship): agent tools that take code from a branch to a PR.
//
//   code group (local git work inside the run's sandbox)
//     git_clone   — clone a GitHub repo into the sandbox workdir on the run's
//                   own branch shapes/<runId>; detect + store its repo profile
//     git_status  — branch, ahead/behind, changed files
//     git_diff    — the work so far against the commit it started from
//     git_commit  — commit everything on the run's branch
//   ship group (anything that leaves the sandbox)
//     git_push_branch   — push HEAD to shapes/<runId>; publish, push_branch (Tier 2)
//     open_pull_request — open/update the PR for that branch; publish, open_pr (Tier 2)
//     read_pr_feedback  — failing checks, reviews and review comments
//
// Every tool records one run event (the diff tools carry the patch, which
// the Runs page review reads — never the client). Branch and PR URLs go on
// the run's agentState.ship (./state.ts).
//
// The sandbox comes through the injected getSandbox(ctx) — by default the
// sandbox workstream's sandboxForRun() (lib/sandbox/index.ts), loaded lazily
// so this module works (and typechecks) before that file exists: without a
// provider the tools refuse with "no sandbox provider", they are never faked.

import { posix as path } from "node:path";
import { TOOL_RECORDED_EVENT, registerExtraTool, type ToolContext, type ToolDef, type ToolResult } from "@/lib/chat/tools";
import type { Sandbox, SandboxExecOptions, SandboxExecResult } from "@/lib/sandbox/types";
import type { AgentRunEventInput } from "@/lib/agents/runs/types";
import { appendAgentRunEvent } from "@/lib/agents/runs/service";
import {
  detectRepoProfileInSandbox,
  getRepoProfile,
  saveRepoProfile,
  type DetectedRepoProfile,
  type RepoProfile,
} from "@/lib/sandbox/repo-profile";
import { assertBranchName } from "@/lib/connectors/github";
import { resolveRepoAccess, type RepoAccess } from "./access";
import { loadShipState, saveShipState, type ShipLookup, type ShipState } from "./state";
import {
  GIT_AUTHOR,
  assertPushAllowed,
  authGitConfigArgs,
  authGitEnv,
  capPatch,
  cloneArgs,
  parseNumstat,
  parsePorcelainStatus,
  parseRepoFullName,
  pushArgs,
  repoRemoteUrl,
  scrubSecrets,
  shipBranchName,
  type NumstatEntry,
} from "./git";

export type ShipToolContext = ToolContext & { threadId?: string };
export type GetSandbox = (ctx: ShipToolContext) => Promise<Sandbox>;
type SandboxForRun = (ctx: ShipToolContext) => Promise<Sandbox>;

export class NoSandboxError extends Error {
  constructor(reason = "no sandbox provider is available — code tools are off on this server") {
    super(reason);
    this.name = "NoSandboxError";
  }
}

/** Default getSandbox: the sandbox workstream's sandboxForRun(), loaded lazily. */
export const defaultGetSandbox: GetSandbox = async (ctx) => {
  let sandboxForRun: SandboxForRun | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore -- lib/sandbox/index.ts (sandboxForRun) belongs to the sandbox workstream; absent until it merges.
    const mod = (await import("@/lib/sandbox/index")) as { sandboxForRun?: unknown };
    if (typeof mod.sandboxForRun === "function") sandboxForRun = mod.sandboxForRun as SandboxForRun;
  } catch {
    sandboxForRun = null;
  }
  if (!sandboxForRun) throw new NoSandboxError();
  return sandboxForRun(ctx);
};

export interface ShipDeps {
  getSandbox: GetSandbox;
  resolveAccess: (workspaceId: string, repoFullName: string) => Promise<RepoAccess>;
  loadState: (q: ShipLookup) => Promise<ShipState | null>;
  saveState: (workspaceId: string, runId: string, state: ShipState) => Promise<void>;
  recordEvent: (workspaceId: string, runId: string, event: AgentRunEventInput) => Promise<void>;
  getProfile: (workspaceId: string, repoFullName: string) => Promise<RepoProfile | null>;
  saveProfile: (workspaceId: string, repoFullName: string, profile: DetectedRepoProfile) => Promise<unknown>;
}

export const defaultShipDeps: ShipDeps = {
  getSandbox: defaultGetSandbox,
  resolveAccess: (ws, repo) => resolveRepoAccess(ws, repo),
  loadState: loadShipState,
  saveState: saveShipState,
  recordEvent: async (ws, runId, event) => {
    await appendAgentRunEvent(ws, runId, event);
  },
  getProfile: getRepoProfile,
  saveProfile: saveRepoProfile,
};

/** Tool results whose details carry this flag recorded their own run event. */
export const RECORDED_EVENT = TOOL_RECORDED_EVENT;

const CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const PUSH_TIMEOUT_MS = 5 * 60 * 1000;
const GIT_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** How much of a patch / feedback the model sees in the tool result. */
const SUMMARY_PATCH_CHARS = 12_000;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function threadOf(ctx: ShipToolContext): string | undefined {
  return typeof ctx.threadId === "string" && ctx.threadId ? ctx.threadId : undefined;
}

function needRun(ctx: ShipToolContext): string {
  if (!ctx.runId) throw new Error("Git tools work inside a tracked agent run; start this as a task.");
  return ctx.runId;
}

class GitCommandError extends Error {}

const GIT_VERBS = new Set(["clone", "fetch", "push", "checkout", "commit", "add", "diff", "status", "rev-parse", "rev-list", "config"]);

/** Run one git command in the sandbox; non-zero exit throws (output scrubbed). */
async function git(
  sandbox: Sandbox,
  argv: string[],
  ctx: ShipToolContext,
  opts: Omit<SandboxExecOptions, "signal" | "maxOutputBytes"> & { secrets?: string[]; allowFail?: boolean } = {},
): Promise<SandboxExecResult> {
  const { secrets = [], allowFail = false, ...execOpts } = opts;
  const res = await sandbox.exec(argv, {
    timeoutMs: GIT_TIMEOUT_MS,
    ...execOpts,
    signal: ctx.signal,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
  const clean: SandboxExecResult = {
    ...res,
    stdout: scrubSecrets(res.stdout, secrets),
    stderr: scrubSecrets(res.stderr, secrets),
  };
  const verb = argv.find((a) => GIT_VERBS.has(a)) ?? argv[0] ?? "command";
  if (res.timedOut) throw new GitCommandError(`git ${verb} timed out`);
  if (res.exitCode !== 0 && !allowFail) {
    const msg = (clean.stderr || clean.stdout).trim().split("\n").slice(-6).join("\n");
    throw new GitCommandError(`git ${verb} failed (exit ${res.exitCode}): ${msg.slice(0, 1200)}`);
  }
  return clean;
}

function g(dir: string, ...args: string[]): string[] {
  return ["git", "-C", dir, ...args];
}

async function requireState(deps: ShipDeps, ctx: ShipToolContext): Promise<ShipState> {
  const state = await deps.loadState({ workspaceId: ctx.workspaceId, runId: ctx.runId, threadId: threadOf(ctx) });
  if (!state) throw new Error("Nothing has been cloned in this task yet — call git_clone first.");
  return state;
}

async function record(deps: ShipDeps, ctx: ShipToolContext, summary: string, payload: Record<string, unknown>): Promise<void> {
  if (!ctx.runId) return;
  await deps
    .recordEvent(ctx.workspaceId, ctx.runId, { type: "agui", summary: summary.slice(0, 500), payload })
    .catch(() => undefined);
}

function done(summary: string, details: Record<string, unknown>): ToolResult {
  return { summary, details: { ...details, [RECORDED_EVENT]: true } };
}

interface DiffSnapshot {
  patch: string;
  truncated: boolean;
  files: NumstatEntry[];
  additions: number;
  deletions: number;
}

/** The working tree (or HEAD) against the commit the work started from. */
async function diffSnapshot(
  sandbox: Sandbox,
  ctx: ShipToolContext,
  state: ShipState,
  opts: { to?: "worktree" | "HEAD"; paths?: string[] } = {},
): Promise<DiffSnapshot> {
  const to = opts.to ?? "worktree";
  if (to === "worktree") {
    // Intent-to-add, so new files show up in the diff (nothing is committed).
    await git(sandbox, g(state.dir, "add", "-A", "-N"), ctx);
  }
  const range = to === "HEAD" ? [state.baseSha, "HEAD"] : [state.baseSha];
  const tail = opts.paths?.length ? ["--", ...opts.paths] : [];
  const common = ["diff", "--no-color", "--no-ext-diff", "--find-renames"];
  const [patchRes, numRes] = await Promise.all([
    git(sandbox, g(state.dir, ...common, ...range, ...tail), ctx),
    git(sandbox, g(state.dir, ...common, "--numstat", ...range, ...tail), ctx),
  ]);
  const files = parseNumstat(numRes.stdout);
  const capped = capPatch(patchRes.stdout);
  return {
    ...capped,
    files,
    additions: files.reduce((n, f) => n + (f.additions ?? 0), 0),
    deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
  };
}

function diffHeadline(d: DiffSnapshot): string {
  if (d.files.length === 0) return "No changes";
  return `${d.files.length} ${d.files.length === 1 ? "file" : "files"} changed (+${d.additions} −${d.deletions})`;
}

function forModel(patch: string): string {
  return patch.length > SUMMARY_PATCH_CHARS ? `${patch.slice(0, SUMMARY_PATCH_CHARS)}\n… (diff cut here; ask git_diff for paths)` : patch;
}

async function pathExists(sandbox: Sandbox, ctx: ShipToolContext, p: string): Promise<boolean> {
  const res = await sandbox.exec(["test", "-e", p], { timeoutMs: 15_000, signal: ctx.signal });
  return res.exitCode === 0;
}

/** Build the ship tools against a set of dependencies (tests inject fakes). */
export function createShipTools(deps: ShipDeps = defaultShipDeps): ToolDef[] {
  const git_clone: ToolDef = {
    name: "git_clone",
    description:
      "Clone a GitHub repository into this task's sandbox and start the task's own branch (shapes/<run id>). Detects the stack (package manager; test, lint and build commands) on the first clone. Call this before any other git tool.",
    kind: "safe",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: 'The repository, "owner/name" (required).' },
        base: { type: "string", description: "Branch to start from (default: the repository's default branch)." },
      },
      required: ["repo"],
    },
    async execute(rawCtx, args) {
      const ctx = rawCtx as ShipToolContext;
      const runId = needRun(ctx);
      const { fullName, repo } = parseRepoFullName(args.repo);
      const existing = await deps.loadState({ workspaceId: ctx.workspaceId, runId, threadId: threadOf(ctx) });
      const sandbox = await deps.getSandbox(ctx);

      if (existing && existing.repo.toLowerCase() === fullName.toLowerCase()) {
        const there = await sandbox.exec(g(existing.dir, "rev-parse", "--is-inside-work-tree"), {
          timeoutMs: 15_000,
          signal: ctx.signal,
        });
        if (there.exitCode === 0) {
          await deps.saveState(ctx.workspaceId, runId, existing);
          await record(deps, ctx, `${fullName} is already cloned on ${existing.branch}`, {
            tool: "git_clone",
            repo: fullName,
            branch: existing.branch,
            reused: true,
          });
          return done(`${fullName} is already cloned at ${existing.dir} on branch ${existing.branch}.`, {
            repo: fullName,
            dir: existing.dir,
            branch: existing.branch,
          });
        }
      }

      const access = await deps.resolveAccess(ctx.workspaceId, fullName);
      const info = await access.connector.getRepo();
      const base = str(args.base) ?? existing?.baseBranch ?? info.defaultBranch;
      assertBranchName(base);
      const token = await access.token();
      const secrets = [token];

      let dir = path.join(sandbox.workdir, repo);
      for (let i = 2; (await pathExists(sandbox, ctx, dir)) && i < 50; i++) dir = path.join(sandbox.workdir, `${repo}-${i}`);

      await git(sandbox, cloneArgs(fullName, base, dir), ctx, { env: authGitEnv(token), timeoutMs: CLONE_TIMEOUT_MS, secrets });
      await git(sandbox, g(dir, "config", "user.name", GIT_AUTHOR.name), ctx);
      await git(sandbox, g(dir, "config", "user.email", GIT_AUTHOR.email), ctx);

      // Re-cloning work that already has a branch (a fresh sandbox): resume it.
      const branch = existing && existing.repo.toLowerCase() === fullName.toLowerCase() ? existing.branch : shipBranchName(runId);
      let resumed = false;
      if (existing?.pushedSha && existing.branch === branch) {
        const fetched = await git(
          sandbox,
          ["git", "-C", dir, ...authGitConfigArgs(), "fetch", "--no-tags", "--", repoRemoteUrl(fullName), `refs/heads/${branch}`],
          ctx,
          { env: authGitEnv(token), timeoutMs: CLONE_TIMEOUT_MS, secrets, allowFail: true },
        );
        if (fetched.exitCode === 0) {
          await git(sandbox, g(dir, "checkout", "-B", branch, "FETCH_HEAD"), ctx);
          resumed = true;
        }
      }
      if (!resumed) await git(sandbox, g(dir, "checkout", "-b", branch), ctx);
      const head = (await git(sandbox, g(dir, "rev-parse", "HEAD"), ctx)).stdout.trim();
      const baseSha = existing && existing.repo.toLowerCase() === fullName.toLowerCase() && resumed ? existing.baseSha : head;

      // Repo profile: detected once per repository per workspace.
      let profile: RepoProfile | DetectedRepoProfile | null = null;
      let profileNote = "";
      try {
        profile = await deps.getProfile(ctx.workspaceId, fullName);
        if (!profile) {
          profile = await detectRepoProfileInSandbox(sandbox, dir);
          await deps.saveProfile(ctx.workspaceId, fullName, profile);
          profileNote = " Detected its stack for later runs.";
        }
      } catch {
        profileNote = " (Could not detect its stack.)";
      }

      const state: ShipState = {
        ...(existing && existing.repo.toLowerCase() === fullName.toLowerCase() ? existing : {}),
        repo: fullName,
        dir,
        defaultBranch: info.defaultBranch,
        baseBranch: base,
        baseSha,
        branch,
        cloneRunId: existing && existing.branch === branch ? existing.cloneRunId : runId,
        mode: access.mode,
      };
      await deps.saveState(ctx.workspaceId, runId, state);
      const cmds = profile?.commands ?? {};
      const cmdLine = Object.entries(cmds)
        .map(([k, v]) => `${k}: ${v}`)
        .join("; ");
      await record(deps, ctx, `Cloned ${fullName} (${base}) on ${branch}`, {
        tool: "git_clone",
        repo: fullName,
        base,
        branch,
        baseSha,
        packageManager: profile?.packageManager ?? null,
        commands: cmds,
      });
      return done(
        `Cloned ${fullName} (${base} @ ${baseSha.slice(0, 7)}) into ${dir} on branch ${branch}.${profileNote}${cmdLine ? ` Commands — ${cmdLine}.` : ""}`,
        { repo: fullName, dir, branch, base, baseSha, profile },
      );
    },
  };

  const git_status: ToolDef = {
    name: "git_status",
    description: "Show the cloned repository's branch, commits ahead of the start, and changed files.",
    kind: "safe",
    minRole: "editor",
    argsSchema: { type: "object", properties: {} },
    async execute(rawCtx) {
      const ctx = rawCtx as ShipToolContext;
      needRun(ctx);
      const state = await requireState(deps, ctx);
      const sandbox = await deps.getSandbox(ctx);
      const res = await git(sandbox, g(state.dir, "status", "--porcelain=v1", "-b"), ctx);
      const st = parsePorcelainStatus(res.stdout);
      const ahead = Number((await git(sandbox, g(state.dir, "rev-list", "--count", `${state.baseSha}..HEAD`), ctx)).stdout.trim()) || 0;
      const files = st.files.map((f) => `${(f.index + f.worktree).trim() || "?"} ${f.path}`);
      const summary = `On ${st.branch ?? "a detached HEAD"}: ${ahead} commit${ahead === 1 ? "" : "s"} since the start, ${st.files.length} changed file${st.files.length === 1 ? "" : "s"}${files.length ? ` — ${files.slice(0, 40).join(", ")}` : ""}.`;
      await record(deps, ctx, summary, { tool: "git_status", repo: state.repo, branch: st.branch, ahead, files: st.files.slice(0, 200) });
      return done(summary, { branch: st.branch, ahead, files: st.files });
    },
  };

  const git_diff: ToolDef = {
    name: "git_diff",
    description:
      "Show every change in the cloned repository since the task started (committed or not, new files included) as a unified diff. This is the diff a person reviews before anything is pushed.",
    kind: "safe",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        paths: { type: "string", description: "Optional comma-separated paths to limit the diff to." },
      },
    },
    async execute(rawCtx, args) {
      const ctx = rawCtx as ShipToolContext;
      needRun(ctx);
      const state = await requireState(deps, ctx);
      const sandbox = await deps.getSandbox(ctx);
      const paths = str(args.paths)
        ?.split(",")
        .map((p) => p.trim())
        .filter((p) => p && !p.startsWith("-"));
      const d = await diffSnapshot(sandbox, ctx, state, { paths });
      const headline = diffHeadline(d);
      await record(deps, ctx, `Diff: ${headline}`, {
        tool: "git_diff",
        repo: state.repo,
        branch: state.branch,
        baseSha: state.baseSha,
        patch: d.patch,
        truncated: d.truncated,
        files: d.files,
        additions: d.additions,
        deletions: d.deletions,
      });
      return done(d.files.length ? `${headline}:\n${forModel(d.patch)}` : `${headline} since the task started.`, {
        files: d.files,
        truncated: d.truncated,
      });
    },
  };

  const git_commit: ToolDef = {
    name: "git_commit",
    description: "Commit every change in the cloned repository to the task's branch, with a message.",
    kind: "safe",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: { message: { type: "string", description: "The commit message (required)." } },
      required: ["message"],
    },
    async execute(rawCtx, args) {
      const ctx = rawCtx as ShipToolContext;
      needRun(ctx);
      const message = str(args.message);
      if (!message) throw new Error("A commit needs a message.");
      const state = await requireState(deps, ctx);
      const sandbox = await deps.getSandbox(ctx);
      const current = (await git(sandbox, g(state.dir, "rev-parse", "--abbrev-ref", "HEAD"), ctx)).stdout.trim();
      if (current !== state.branch) {
        throw new Error(`You are on ${current}; commits go on the task's branch ${state.branch} (git checkout ${state.branch}).`);
      }
      await git(sandbox, g(state.dir, "add", "-A"), ctx);
      const staged = await git(sandbox, g(state.dir, "diff", "--cached", "--quiet"), ctx, { allowFail: true });
      if (staged.exitCode === 0) {
        await record(deps, ctx, "Nothing to commit", { tool: "git_commit", repo: state.repo, branch: state.branch });
        return done("Nothing to commit — the working tree matches the last commit.", { committed: false });
      }
      await git(sandbox, g(state.dir, "commit", "--no-gpg-sign", "-m", message.slice(0, 5000)), ctx);
      const sha = (await git(sandbox, g(state.dir, "rev-parse", "HEAD"), ctx)).stdout.trim();
      const d = await diffSnapshot(sandbox, ctx, state, { to: "HEAD" });
      await record(deps, ctx, `Committed ${sha.slice(0, 7)}: ${message.split("\n")[0]!.slice(0, 120)}`, {
        tool: "git_commit",
        repo: state.repo,
        branch: state.branch,
        sha,
        baseSha: state.baseSha,
        patch: d.patch,
        truncated: d.truncated,
        files: d.files,
        additions: d.additions,
        deletions: d.deletions,
      });
      return done(`Committed ${sha.slice(0, 7)} on ${state.branch}. Since the start: ${diffHeadline(d)}.`, { sha, committed: true });
    },
  };

  const git_push_branch: ToolDef = {
    name: "git_push_branch",
    description:
      "Push the task's commits to its own branch (shapes/<run id>) on GitHub. Never pushes to the default branch, never force-pushes. A person approves it first.",
    kind: "publish",
    minRole: "editor",
    argsSchema: { type: "object", properties: {} },
    async execute(rawCtx, args) {
      const ctx = rawCtx as ShipToolContext;
      const runId = needRun(ctx);
      const state = await requireState(deps, ctx);
      assertPushAllowed({ branch: state.branch, defaultBranch: state.defaultBranch, baseBranch: state.baseBranch, args });
      const sandbox = await deps.getSandbox(ctx);
      const ahead = Number((await git(sandbox, g(state.dir, "rev-list", "--count", `${state.baseSha}..HEAD`), ctx)).stdout.trim()) || 0;
      if (ahead === 0) throw new Error("There are no commits to push yet — commit with git_commit first.");
      // A repo-level url.*.insteadOf could re-point the push; refuse instead.
      const rewrites = await git(sandbox, g(state.dir, "config", "--get-regexp", "^url\\."), ctx, { allowFail: true });
      if (rewrites.exitCode === 0 && rewrites.stdout.trim()) {
        throw new Error("This clone rewrites remote URLs (url.*.insteadOf); remove that config before pushing.");
      }
      const access = await deps.resolveAccess(ctx.workspaceId, state.repo);
      const token = await access.token();
      await git(sandbox, ["git", "-C", state.dir, ...pushArgs(state.repo, state.branch).slice(1)], ctx, {
        env: authGitEnv(token),
        timeoutMs: PUSH_TIMEOUT_MS,
        secrets: [token],
      });
      const sha = (await git(sandbox, g(state.dir, "rev-parse", "HEAD"), ctx)).stdout.trim();
      const branchUrl = `https://github.com/${state.repo}/tree/${state.branch}`;
      const next: ShipState = { ...state, branchUrl, pushedSha: sha, pushedAt: new Date().toISOString() };
      await deps.saveState(ctx.workspaceId, runId, next);
      const d = await diffSnapshot(sandbox, ctx, state, { to: "HEAD" });
      await record(deps, ctx, `Pushed ${sha.slice(0, 7)} to ${state.branch}`, {
        tool: "git_push_branch",
        repo: state.repo,
        branch: state.branch,
        branchUrl,
        sha,
        baseSha: state.baseSha,
        patch: d.patch,
        truncated: d.truncated,
        files: d.files,
        additions: d.additions,
        deletions: d.deletions,
      });
      return done(`Pushed ${ahead} commit${ahead === 1 ? "" : "s"} to ${state.branch}: ${branchUrl}`, { branch: state.branch, branchUrl, sha });
    },
  };

  const open_pull_request: ToolDef = {
    name: "open_pull_request",
    description:
      "Open a pull request from the task's pushed branch into the branch it started from (or update the one already open). A person approves it first.",
    kind: "publish",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Pull request title (required)." },
        body: { type: "string", description: "What changed and why, and how it was tested." },
        draft: { type: "boolean", description: "Open it as a draft." },
      },
      required: ["title"],
    },
    async execute(rawCtx, args) {
      const ctx = rawCtx as ShipToolContext;
      const runId = needRun(ctx);
      const title = str(args.title);
      if (!title) throw new Error("A pull request needs a title.");
      const state = await requireState(deps, ctx);
      const access = await deps.resolveAccess(ctx.workspaceId, state.repo);
      const remote = await access.connector.getBranch(state.branch);
      if (!remote) throw new Error(`${state.branch} is not on GitHub yet — push it with git_push_branch first.`);
      const body = `${str(args.body) ?? ""}\n\n---\nOpened by a ShapesOS agent run (\`${runId}\`) from branch \`${state.branch}\`.`.trim();
      const existing = state.prNumber
        ? await access.connector.getPullRequest(state.prNumber).catch(() => null)
        : await access.connector.findPullRequestForBranch(state.branch);
      const pr =
        existing && existing.state === "open"
          ? await access.connector.updatePullRequest(existing.number, { title, body })
          : await access.connector.openPullRequest({
              title,
              body,
              head: state.branch,
              base: state.baseBranch,
              draft: args.draft === true || args.draft === "true",
            });
      const next: ShipState = { ...state, prNumber: pr.number, prUrl: pr.url };
      await deps.saveState(ctx.workspaceId, runId, next);
      const verb = existing && existing.state === "open" ? "Updated" : "Opened";
      await record(deps, ctx, `${verb} pull request #${pr.number}${pr.mock ? " (mock)" : ""}`, {
        tool: "open_pull_request",
        repo: state.repo,
        branch: state.branch,
        prNumber: pr.number,
        prUrl: pr.url,
        draft: pr.draft,
        mock: pr.mock === true,
      });
      return done(`${verb} pull request #${pr.number}: ${pr.url}${pr.mock ? " (demo data — mock)" : ""}`, {
        prNumber: pr.number,
        prUrl: pr.url,
      });
    },
  };

  const read_pr_feedback: ToolDef = {
    name: "read_pr_feedback",
    description:
      "Read the task's pull request: failing checks, review verdicts and review comments (file and line), so you can address them and push again.",
    kind: "safe",
    minRole: "editor",
    argsSchema: { type: "object", properties: {} },
    async execute(rawCtx) {
      const ctx = rawCtx as ShipToolContext;
      const runId = needRun(ctx);
      const state = await requireState(deps, ctx);
      const access = await deps.resolveAccess(ctx.workspaceId, state.repo);
      let prNumber = state.prNumber;
      if (!prNumber) {
        const found = await access.connector.findPullRequestForBranch(state.branch);
        if (!found) throw new Error("This task has no pull request yet — open one with open_pull_request.");
        prNumber = found.number;
        await deps.saveState(ctx.workspaceId, runId, { ...state, prNumber, prUrl: found.url });
      }
      const [status, reviews, comments] = await Promise.all([
        access.connector.getPullRequestStatus(prNumber),
        access.connector.listReviews(prNumber),
        access.connector.listReviewComments(prNumber),
      ]);
      const verdicts = reviews.filter((r) => r.state !== "PENDING");
      const lines: string[] = [
        `Pull request #${prNumber} (${status.pr.url}) is ${status.pr.merged ? "merged" : status.pr.state}; checks: ${status.state}.`,
      ];
      if (status.failing.length) {
        lines.push("Failing checks:");
        for (const c of status.failing) lines.push(`- ${c.name}: ${c.conclusion}${c.summary ? ` — ${c.summary}` : ""}${c.url ? ` (${c.url})` : ""}`);
      }
      const pendingChecks = status.checks.filter((c) => c.conclusion === null);
      if (pendingChecks.length) lines.push(`Still running: ${pendingChecks.map((c) => c.name).join(", ")}.`);
      if (verdicts.length) {
        lines.push("Reviews:");
        for (const r of verdicts) lines.push(`- ${r.author}: ${r.state}${r.body.trim() ? ` — ${r.body.trim().slice(0, 600)}` : ""}`);
      }
      if (comments.length) {
        lines.push("Review comments:");
        for (const c of comments) lines.push(`- ${c.path}${c.line ? `:${c.line}` : ""} ${c.author}${c.inReplyTo ? " (reply)" : ""}: ${c.body.trim().slice(0, 600)}`);
      }
      if (!status.failing.length && !verdicts.length && !comments.length) lines.push("No review feedback or failing checks yet.");
      const mock = status.mock === true || reviews.some((r) => r.mock) || comments.some((c) => c.mock);
      if (mock) lines.push("(Demo data — mock.)");
      const text = lines.join("\n");
      await record(
        deps,
        ctx,
        `PR #${prNumber}: checks ${status.state}, ${status.failing.length} failing, ${verdicts.length} review${verdicts.length === 1 ? "" : "s"}, ${comments.length} comment${comments.length === 1 ? "" : "s"}`,
        {
          tool: "read_pr_feedback",
          repo: state.repo,
          prNumber,
          prUrl: status.pr.url,
          checks: status.state,
          failing: status.failing.map((c) => ({ name: c.name, conclusion: c.conclusion, url: c.url })),
          reviews: verdicts.map((r) => ({ author: r.author, state: r.state })),
          comments: comments.length,
          mock,
        },
      );
      return done(forModel(text), { prNumber, checks: status.state, failing: status.failing, reviews: verdicts, comments });
    },
  };

  return [git_clone, git_status, git_diff, git_commit, git_push_branch, open_pull_request, read_pr_feedback];
}

export const SHIP_TOOL_NAMES = [
  "git_clone",
  "git_status",
  "git_diff",
  "git_commit",
  "git_push_branch",
  "open_pull_request",
  "read_pr_feedback",
] as const;

let registered = false;

/** Register the ship tools with the chat tool registry (idempotent). */
export function registerShipTools(deps: ShipDeps = defaultShipDeps): void {
  if (registered) return;
  registered = true;
  for (const t of createShipTools(deps)) registerExtraTool(t);
}

registerShipTools();
