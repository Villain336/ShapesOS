// Marketr — GitHub file connector (milestone 7, live implementation).
//
// Talks to the GitHub REST API directly with fetch (no Octokit dependency).
// Implements SiteFileProvider (so the IDE can browse it) plus repo-level ops:
// listRepos, createRepo, and pushFiles — which pushes many files in ONE
// commit via the Git Data API (used by Deploy). Untested against the live API
// from this sandbox (egress blocked); the mock in ./mock-github.ts covers the
// full flow end-to-end and every mock row is labeled mock: true.
//
// Phase 8 (ship): branches (create from the default branch, get, compare),
// pull requests (open, update, get, find by branch, status + checks, review
// comments and reviews), and a GitHub App mode next to the PAT: when
// cfg.getToken is set (lib/ship/github-access.ts wires it to
// lib/connectors/github-app.ts) every request uses a fresh-or-cached
// installation token instead of cfg.token. Request shapes follow the REST
// docs (API version 2022-11-28); the unit suite stubs fetch.

import type { FileEntry, ReadResult, SiteFileProvider } from "@/lib/sitefiles/types";
import { sanitizePath } from "@/lib/sitefiles/paths";
import type {
  GitHubBranch,
  GitHubCheck,
  GitHubCompare,
  GitHubConfig,
  GitHubConnector,
  GitHubPrStatus,
  GitHubPullRequest,
  GitHubRepoSummary,
  GitHubReview,
  GitHubReviewComment,
  GitHubIssueComment,
  OpenPullRequestInput,
  PushResult,
  UpdatePullRequestInput,
} from "./types";

const API = "https://api.github.com";
const MAX_READ_BYTES = 200 * 1024;

interface ContentsEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  size?: number;
  sha: string;
  encoding?: string;
  content?: string;
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "marketr",
  };
}

/** GitHub "contents" paths are repo-relative with no leading slash. */
function apiPath(sanitized: string): string {
  return sanitized.replace(/^\//, "");
}

export class GitHubSiteFileProvider implements GitHubConnector {
  readonly kind = "github" as const;
  readonly name = "github";
  readonly isLive = true;

  constructor(
    private cfg: GitHubConfig,
    private deps: { fetch?: typeof fetch } = {},
  ) {}

  private get owner() {
    return this.cfg.owner;
  }
  private get repo() {
    return this.cfg.repo;
  }
  private get branch() {
    return this.cfg.branch || "main";
  }
  private get repoBase() {
    return `${API}/repos/${this.owner}/${this.repo}`;
  }

  private async gh(path: string, init?: RequestInit): Promise<Response> {
    let res: Response;
    const token = this.cfg.getToken ? await this.cfg.getToken() : this.cfg.token;
    try {
      res = await (this.deps.fetch ?? fetch)(`${API}${path}`, {
        ...init,
        headers: { ...headers(token), ...(init?.headers ?? {}) },
      });
    } catch (err) {
      throw new Error(
        `GitHub request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return res;
  }

  private async ghJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.gh(path, init);
    if (res.status === 404) throw new Error("Not found on GitHub");
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub API error ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const repo = await this.ghJson<{ default_branch: string; full_name: string }>(
        `/repos/${this.owner}/${this.repo}`,
      );
      return { ok: true, message: `Connected to ${repo.full_name} (default branch ${repo.default_branch})` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "GitHub connection failed" };
    }
  }

  private toEntry(e: ContentsEntry): FileEntry {
    return {
      name: e.name,
      path: "/" + e.path,
      type: e.type === "dir" ? "dir" : "file",
      size: e.size,
    };
  }

  async listDir(path: string): Promise<FileEntry[]> {
    const dir = sanitizePath(path);
    const data = await this.ghJson<ContentsEntry[] | ContentsEntry>(
      `/repos/${this.owner}/${this.repo}/contents/${apiPath(dir)}?ref=${encodeURIComponent(this.branch)}`,
    );
    if (!Array.isArray(data)) throw new Error(`${dir} is not a directory`);
    return data
      .filter((e) => e.type === "file" || e.type === "dir")
      .map((e) => this.toEntry(e))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  }

  async readFile(path: string): Promise<ReadResult> {
    const p = sanitizePath(path);
    const data = await this.ghJson<ContentsEntry>(
      `/repos/${this.owner}/${this.repo}/contents/${apiPath(p)}?ref=${encodeURIComponent(this.branch)}`,
    );
    if (data.type !== "file" || typeof data.content !== "string") {
      throw new Error(`${p} is not a file`);
    }
    if ((data.size ?? 0) > MAX_READ_BYTES) throw new Error(`File too large to edit: ${p}`);
    const content = Buffer.from(data.content.replace(/\s/g, ""), "base64").toString("utf8");
    return { content, truncated: false };
  }

  async writeFile(path: string, content: string): Promise<void> {
    const p = sanitizePath(path);
    const rel = apiPath(p);
    // Fetch current sha (absent → creating a new file).
    let sha: string | undefined;
    try {
      const existing = await this.ghJson<ContentsEntry>(
        `/repos/${this.owner}/${this.repo}/contents/${rel}?ref=${encodeURIComponent(this.branch)}`,
      );
      if (existing.type === "file") sha = existing.sha;
    } catch (err) {
      if (!(err instanceof Error) || !/Not found/.test(err.message)) throw err;
    }
    const res = await this.gh(`/repos/${this.owner}/${this.repo}/contents/${rel}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `ShapesOS: update ${p}`,
        content: Buffer.from(content, "utf8").toString("base64"),
        branch: this.branch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub write failed (${res.status}): ${text.slice(0, 200)}`);
    }
  }

  async stat(path: string): Promise<FileEntry> {
    const p = sanitizePath(path);
    const data = await this.ghJson<ContentsEntry>(
      `/repos/${this.owner}/${this.repo}/contents/${apiPath(p)}?ref=${encodeURIComponent(this.branch)}`,
    );
    return this.toEntry(data);
  }

  async listRepos(): Promise<GitHubRepoSummary[]> {
    const data = await this.ghJson<
      { owner: { login: string }; name: string; full_name: string; private: boolean; default_branch: string; updated_at: string | null }[]
    >(`/user/repos?per_page=100&sort=updated`);
    return data.map((r) => ({
      owner: r.owner.login,
      name: r.name,
      fullName: r.full_name,
      private: r.private,
      defaultBranch: r.default_branch,
      updatedAt: r.updated_at,
    }));
  }

  async createRepo(
    name: string,
    opts?: { private?: boolean; description?: string },
  ): Promise<GitHubRepoSummary> {
    const clean = name.trim();
    if (!/^[A-Za-z0-9._-]+$/.test(clean)) throw new Error("Invalid repository name");
    const r = await this.ghJson<{
      owner: { login: string };
      name: string;
      full_name: string;
      private: boolean;
      default_branch: string;
      updated_at: string | null;
    }>(`/user/repos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: clean,
        private: opts?.private ?? true,
        description: opts?.description ?? "Site managed by ShapesOS",
        auto_init: true,
      }),
    });
    return {
      owner: r.owner.login,
      name: r.name,
      fullName: r.full_name,
      private: r.private,
      defaultBranch: r.default_branch,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Push many files in ONE commit via the Git Data API:
   * blobs → tree → commit → ref update. Returns the commit SHA.
   */
  async pushFiles(files: { path: string; content: string }[], message: string): Promise<PushResult> {
    const clean = files.map((f) => ({ path: apiPath(sanitizePath(f.path)), content: f.content }));
    if (clean.length === 0) throw new Error("No files to push");

    // 1. Current ref (may not exist on a brand-new repo).
    let baseSha: string | null = null;
    let refExists = true;
    try {
      const ref = await this.ghJson<{ object: { sha: string } }>(
        `/repos/${this.owner}/${this.repo}/git/ref/heads/${encodeURIComponent(this.branch)}`,
      );
      baseSha = ref.object.sha;
    } catch (err) {
      if (err instanceof Error && /Not found/.test(err.message)) refExists = false;
      else throw err;
    }

    // 2. Blobs.
    const tree: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
    for (const f of clean) {
      const blob = await this.ghJson<{ sha: string }>(
        `/repos/${this.owner}/${this.repo}/git/blobs`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: Buffer.from(f.content, "utf8").toString("base64"), encoding: "base64" }),
        },
      );
      tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
    }

    // 3. Tree.
    const treeRes = await this.ghJson<{ sha: string }>(
      `/repos/${this.owner}/${this.repo}/git/trees`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base_tree: baseSha ?? undefined, tree }),
      },
    );

    // 4. Commit.
    const commit = await this.ghJson<{ sha: string }>(
      `/repos/${this.owner}/${this.repo}/git/commits`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          tree: treeRes.sha,
          parents: baseSha ? [baseSha] : [],
        }),
      },
    );

    // 5. Move (or create) the branch ref.
    if (refExists) {
      await this.ghJson(
        `/repos/${this.owner}/${this.repo}/git/refs/heads/${encodeURIComponent(this.branch)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sha: commit.sha }),
        },
      );
    } else {
      await this.ghJson(`/repos/${this.owner}/${this.repo}/git/refs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: `refs/heads/${this.branch}`, sha: commit.sha }),
      });
    }

    return {
      sha: commit.sha,
      files: clean.map((f) => ({ path: "/" + f.path, ok: true })),
    };
  }

  // ---------------------------------------------------------------------
  // Phase 8: ship operations.
  // ---------------------------------------------------------------------

  private get repoPath(): string {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  private get htmlBase(): string {
    return `https://github.com/${this.owner}/${this.repo}`;
  }

  private jsonInit(method: string, body: unknown): RequestInit {
    return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  }

  async getRepo(): Promise<GitHubRepoSummary> {
    const r = await this.ghJson<RawRepo>(this.repoPath);
    return toRepoSummary(r);
  }

  async getBranch(name: string): Promise<GitHubBranch | null> {
    assertBranchName(name);
    try {
      const ref = await this.ghJson<{ object: { sha: string } }>(`${this.repoPath}/git/ref/heads/${encodeRef(name)}`);
      return { name, sha: ref.object.sha, url: `${this.htmlBase}/tree/${encodeRef(name)}` };
    } catch (err) {
      if (err instanceof Error && /Not found/.test(err.message)) return null;
      throw err;
    }
  }

  async createBranch(name: string, opts?: { from?: string }): Promise<GitHubBranch> {
    assertBranchName(name);
    const from = opts?.from ?? (await this.getRepo()).defaultBranch;
    const base = await this.getBranch(from);
    if (!base) throw new Error(`Base branch ${from} not found on GitHub`);
    const ref = await this.ghJson<{ object: { sha: string } }>(
      `${this.repoPath}/git/refs`,
      this.jsonInit("POST", { ref: `refs/heads/${name}`, sha: base.sha }),
    );
    return { name, sha: ref.object.sha, url: `${this.htmlBase}/tree/${encodeRef(name)}` };
  }

  async compare(base: string, head: string): Promise<GitHubCompare> {
    const c = await this.ghJson<{
      status: GitHubCompare["status"];
      ahead_by: number;
      behind_by: number;
      total_commits: number;
      html_url: string;
      files?: { filename: string; status: string; additions: number; deletions: number; patch?: string }[];
    }>(`${this.repoPath}/compare/${encodeRef(base)}...${encodeRef(head)}?per_page=100`);
    return {
      status: c.status,
      aheadBy: c.ahead_by,
      behindBy: c.behind_by,
      totalCommits: c.total_commits,
      htmlUrl: c.html_url,
      files: (c.files ?? []).map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        ...(typeof f.patch === "string" ? { patch: f.patch } : {}),
      })),
    };
  }

  async openPullRequest(input: OpenPullRequestInput): Promise<GitHubPullRequest> {
    assertBranchName(input.head);
    const title = input.title.trim();
    if (!title) throw new Error("A pull request needs a title");
    const base = input.base ?? (await this.getRepo()).defaultBranch;
    if (base === input.head) throw new Error("A pull request needs a head branch different from its base");
    const pr = await this.ghJson<RawPull>(
      `${this.repoPath}/pulls`,
      this.jsonInit("POST", {
        title: title.slice(0, 256),
        head: input.head,
        base,
        body: input.body ?? "",
        draft: input.draft === true,
        maintainer_can_modify: true,
      }),
    );
    return toPull(pr);
  }

  async updatePullRequest(number: number, patch: UpdatePullRequestInput): Promise<GitHubPullRequest> {
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.title = patch.title.slice(0, 256);
    if (patch.body !== undefined) body.body = patch.body;
    if (patch.state !== undefined) body.state = patch.state;
    if (patch.base !== undefined) body.base = patch.base;
    const pr = await this.ghJson<RawPull>(`${this.repoPath}/pulls/${prNumber(number)}`, this.jsonInit("PATCH", body));
    return toPull(pr);
  }

  async getPullRequest(number: number): Promise<GitHubPullRequest> {
    return toPull(await this.ghJson<RawPull>(`${this.repoPath}/pulls/${prNumber(number)}`));
  }

  async findPullRequestForBranch(branch: string): Promise<GitHubPullRequest | null> {
    assertBranchName(branch);
    const list = await this.ghJson<RawPull[]>(
      `${this.repoPath}/pulls?state=open&head=${encodeURIComponent(`${this.owner}:${branch}`)}&per_page=10`,
    );
    return list.length ? toPull(list[0]!) : null;
  }

  async getPullRequestStatus(number: number): Promise<GitHubPrStatus> {
    const pr = await this.getPullRequest(number);
    const sha = encodeURIComponent(pr.headSha);
    const [runs, combined] = await Promise.all([
      this.ghJson<{
        total_count: number;
        check_runs: {
          name: string;
          status: string;
          conclusion: string | null;
          html_url: string | null;
          details_url: string | null;
          output?: { title: string | null; summary: string | null };
        }[];
      }>(`${this.repoPath}/commits/${sha}/check-runs?per_page=100`),
      this.ghJson<{
        state: string;
        statuses: { context: string; state: string; description: string | null; target_url: string | null }[];
      }>(`${this.repoPath}/commits/${sha}/status`),
    ]);
    const checks: GitHubCheck[] = [
      ...(runs.check_runs ?? []).map((r) => ({
        name: r.name,
        source: "check_run" as const,
        status: r.status,
        conclusion: r.conclusion,
        url: r.html_url ?? r.details_url,
        summary: r.output?.title || r.output?.summary || null,
      })),
      ...(combined.statuses ?? []).map((st) => ({
        name: st.context,
        source: "status" as const,
        status: st.state === "pending" ? "pending" : "completed",
        conclusion: st.state === "pending" ? null : st.state,
        url: st.target_url,
        summary: st.description,
      })),
    ];
    return { pr, ...rollUpChecks(checks) };
  }

  async listReviewComments(number: number): Promise<GitHubReviewComment[]> {
    const rows = await this.ghJson<
      {
        id: number;
        path: string;
        line: number | null;
        original_line: number | null;
        body: string;
        user: { login: string } | null;
        html_url: string;
        created_at: string;
        in_reply_to_id?: number;
        diff_hunk?: string;
        author_association?: string;
      }[]
    >(`${this.repoPath}/pulls/${prNumber(number)}/comments?per_page=100&sort=created&direction=asc`);
    return rows.map((c) => ({
      id: c.id,
      path: c.path,
      line: c.line ?? c.original_line ?? null,
      body: c.body,
      author: c.user?.login ?? "unknown",
      url: c.html_url,
      createdAt: c.created_at,
      inReplyTo: c.in_reply_to_id ?? null,
      ...(c.diff_hunk ? { diffHunk: c.diff_hunk } : {}),
      ...(c.author_association ? { authorAssociation: c.author_association } : {}),
    }));
  }

  async listReviews(number: number): Promise<GitHubReview[]> {
    const rows = await this.ghJson<
      {
        id: number;
        user: { login: string } | null;
        body: string | null;
        state: string;
        html_url: string;
        submitted_at?: string | null;
        author_association?: string;
      }[]
    >(`${this.repoPath}/pulls/${prNumber(number)}/reviews?per_page=100`);
    return rows.map((r) => ({
      id: r.id,
      author: r.user?.login ?? "unknown",
      state: r.state,
      body: r.body ?? "",
      url: r.html_url,
      submittedAt: r.submitted_at ?? null,
      ...(r.author_association ? { authorAssociation: r.author_association } : {}),
    }));
  }

  /** Phase 9: the PR conversation's comments (GitHub stores them as issue comments). */
  async listIssueComments(number: number): Promise<GitHubIssueComment[]> {
    const rows = await this.ghJson<
      { id: number; body: string | null; user: { login: string } | null; html_url: string; created_at: string; author_association?: string }[]
    >(`${this.repoPath}/issues/${prNumber(number)}/comments?per_page=100`);
    return rows.map((c) => ({
      id: c.id,
      body: c.body ?? "",
      author: c.user?.login ?? "unknown",
      url: c.html_url,
      createdAt: c.created_at,
      ...(c.author_association ? { authorAssociation: c.author_association } : {}),
    }));
  }
}

// ---------------------------------------------------------------------------
// Phase 8 helpers (exported for the mock and the unit suite).
// ---------------------------------------------------------------------------

interface RawRepo {
  owner: { login: string };
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  updated_at: string | null;
}

interface RawPull {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: "open" | "closed";
  merged?: boolean;
  merged_at?: string | null;
  draft?: boolean;
  mergeable?: boolean | null;
  head: { ref: string; sha: string };
  base: { ref: string };
}

function toRepoSummary(r: RawRepo): GitHubRepoSummary {
  return {
    owner: r.owner.login,
    name: r.name,
    fullName: r.full_name,
    private: r.private,
    defaultBranch: r.default_branch,
    updatedAt: r.updated_at,
  };
}

function toPull(p: RawPull): GitHubPullRequest {
  return {
    number: p.number,
    url: p.html_url,
    title: p.title,
    body: p.body ?? "",
    state: p.state,
    merged: p.merged === true || !!p.merged_at,
    draft: p.draft === true,
    head: p.head.ref,
    base: p.base.ref,
    headSha: p.head.sha,
    mergeable: p.mergeable ?? null,
  };
}

function prNumber(n: number): number {
  if (!Number.isInteger(n) || n <= 0) throw new Error("Invalid pull request number");
  return n;
}

/** Encode a ref for a URL path, keeping the "/" separators of branch names. */
function encodeRef(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

/** git check-ref-format, the parts that matter for API calls. */
export function assertBranchName(name: string): void {
  if (
    typeof name !== "string" ||
    !name ||
    name.length > 200 ||
    name.startsWith("-") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".lock") ||
    name.endsWith(".") ||
    name.includes("..") ||
    name.includes("//") ||
    name.includes("@{") ||
    /[\x00-\x20~^:?*[\\\x7f]/.test(name)
  ) {
    throw new Error(`Invalid branch name: ${JSON.stringify(String(name).slice(0, 80))}`);
  }
}

const FAILING_CONCLUSIONS = new Set(["failure", "error", "timed_out", "cancelled", "action_required", "startup_failure"]);

/** Roll individual checks up into one state (failure > pending > success). */
export function rollUpChecks(checks: GitHubCheck[]): { state: GitHubPrStatus["state"]; checks: GitHubCheck[]; failing: GitHubCheck[] } {
  const failing = checks.filter((c) => c.conclusion !== null && FAILING_CONCLUSIONS.has(c.conclusion));
  const pending = checks.some((c) => c.conclusion === null);
  const state: GitHubPrStatus["state"] =
    checks.length === 0 ? "none" : failing.length ? "failure" : pending ? "pending" : "success";
  return { state, checks, failing };
}

export type SiteFileProviderT = SiteFileProvider;
