// Marketr — GitHub file connector (milestone 7, live implementation).
//
// Talks to the GitHub REST API directly with fetch (no Octokit dependency).
// Implements SiteFileProvider (so the IDE can browse it) plus repo-level ops:
// listRepos, createRepo, and pushFiles — which pushes many files in ONE
// commit via the Git Data API (used by Deploy). Untested against the live API
// from this sandbox (egress blocked); the mock in ./mock-github.ts covers the
// full flow end-to-end and every mock row is labeled mock: true.

import type { FileEntry, ReadResult, SiteFileProvider } from "@/lib/sitefiles/types";
import { sanitizePath } from "@/lib/sitefiles/paths";
import type {
  GitHubConfig,
  GitHubConnector,
  GitHubRepoSummary,
  PushResult,
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

  constructor(private cfg: GitHubConfig) {}

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
    try {
      res = await fetch(`${API}${path}`, {
        ...init,
        headers: { ...headers(this.cfg.token), ...(init?.headers ?? {}) },
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
}

export type SiteFileProviderT = SiteFileProvider;
