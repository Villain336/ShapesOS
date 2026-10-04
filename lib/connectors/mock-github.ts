// Marketr — mock GitHub connector (milestone 7).
//
// Deterministic demo repo (a small static site for "Acme Plumbing") so the
// full connect → browse → edit → deploy flow works end-to-end without GitHub
// credentials or network access. Every entry/result is flagged mock: true and
// the UI labels it honestly. Writes mutate an in-memory map (per server
// process); restarting resets the demo. Never ship as real data.
//
// Phase 8: the ship operations (branches, compare, pull requests, checks,
// reviews) are mirrored in memory with the same contract as the live
// connector — every branch / PR / check / review it returns is mock: true,
// and the demo PR's single check and review are labelled "(MOCK)".

import type { FileEntry, ReadResult, SiteFileProvider } from "@/lib/sitefiles/types";
import { joinPath, parentPath, sanitizePath } from "@/lib/sitefiles/paths";
import type {
  GitHubBranch,
  GitHubCompare,
  GitHubConnector,
  GitHubPrStatus,
  GitHubPullRequest,
  GitHubRepoSummary,
  GitHubReview,
  GitHubReviewComment,
  OpenPullRequestInput,
  PushResult,
  UpdatePullRequestInput,
} from "./types";
import { assertBranchName, rollUpChecks } from "./github";

function demoRepo(): Map<string, string> {
  const files = new Map<string, string>();
  files.set(
    "/index.html",
    [
      "<!DOCTYPE html>",
      "<html lang=\"en\">",
      "<head>",
      '  <meta charset="utf-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1">',
      "  <title>Acme Plumbing — Triad Plumbers (MOCK)</title>",
      '  <link rel="stylesheet" href="/styles.css">',
      "</head>",
      "<body>",
      "  <header><h1>Acme Plumbing</h1><nav><a href=\"/\">Home</a> <a href=\"/about.html\">About</a></nav></header>",
      "  <main>",
      "    <h2>We fix leaks, install water heaters, and unclog drains.</h2>",
      '    <a class="cta" href="/about.html">Get a free quote</a>',
      "  </main>",
      "</body>",
      "</html>",
      "",
    ].join("\n"),
  );
  files.set(
    "/styles.css",
    [
      "/* Demo stylesheet (MOCK). */",
      "body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; }",
      ".cta { display: inline-block; background: #0ea5e9; color: #fff; padding: 0.75rem 1.5rem; border-radius: 0.5rem; text-decoration: none; }",
      "",
    ].join("\n"),
  );
  files.set(
    "/about.html",
    [
      "<!DOCTYPE html>",
      "<html lang=\"en\">",
      "<head>",
      '  <meta charset="utf-8">',
      "  <title>About — Acme Plumbing (MOCK)</title>",
      '  <link rel="stylesheet" href="/styles.css">',
      "</head>",
      "<body>",
      "  <h1>About Acme Plumbing</h1>",
      "  <p>Family-owned since 1998, serving the Triad. (MOCK)</p>",
      '  <a href="/">← Home</a>',
      "</body>",
      "</html>",
      "",
    ].join("\n"),
  );
  files.set(
    "/README.md",
    ["# acme-plumbing-site (MOCK)", "", "Demo repo served by ShapesOS's mock GitHub connector.", ""].join("\n"),
  );
  return files;
}

export class MockGitHubConnector implements GitHubConnector {
  readonly kind = "github" as const;
  readonly name = "github-mock";
  readonly isLive = false;
  private files = demoRepo();

  private entry(path: string): FileEntry {
    const p = sanitizePath(path);
    if (this.files.has(p)) {
      return {
        name: p.split("/").pop()!,
        path: p,
        type: "file",
        size: this.files.get(p)!.length,
        mock: true,
      };
    }
    // Directory if any file lives under it (or root).
    const prefix = p === "/" ? "/" : p + "/";
    const isDir =
      p === "/" || [...this.files.keys()].some((k) => k.startsWith(prefix));
    if (!isDir) throw new Error(`Path not found: ${p}`);
    return { name: p === "/" ? "/" : p.split("/").pop()!, path: p, type: "dir", mock: true };
  }

  async test() {
    return { ok: true, message: "Mock GitHub repo ready (demo data — not a real repo)" };
  }

  async listDir(path: string): Promise<FileEntry[]> {
    const dir = sanitizePath(path);
    const e = this.entry(dir);
    if (e.type !== "dir") throw new Error(`${dir} is not a directory`);
    const prefix = dir === "/" ? "/" : dir + "/";
    const seen = new Map<string, FileEntry>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const seg = rest.split("/")[0];
      const childPath = joinPath(dir, seg);
      if (!seen.has(childPath)) {
        seen.set(
          childPath,
          rest.includes("/")
            ? { name: seg, path: childPath, type: "dir", mock: true }
            : {
                name: seg,
                path: childPath,
                type: "file",
                size: this.files.get(key)!.length,
                mock: true,
              },
        );
      }
    }
    return [...seen.values()].sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
    );
  }

  async readFile(path: string): Promise<ReadResult> {
    const p = sanitizePath(path);
    const content = this.files.get(p);
    if (content === undefined) throw new Error(`File not found: ${p}`);
    return { content, truncated: false, mock: true };
  }

  async writeFile(path: string, content: string): Promise<void> {
    const p = sanitizePath(path);
    // Ensure parent "dirs" exist implicitly — the map is flat, nothing to do.
    void parentPath(p);
    this.files.set(p, content);
  }

  async stat(path: string): Promise<FileEntry> {
    return this.entry(path);
  }

  async listRepos(): Promise<GitHubRepoSummary[]> {
    return [
      {
        owner: "demo-user",
        name: "acme-plumbing-site",
        fullName: "demo-user/acme-plumbing-site",
        private: true,
        defaultBranch: "main",
        updatedAt: new Date().toISOString(),
        mock: true,
      },
      {
        owner: "demo-user",
        name: "acme-landing-q3",
        fullName: "demo-user/acme-landing-q3",
        private: false,
        defaultBranch: "main",
        updatedAt: new Date().toISOString(),
        mock: true,
      },
    ];
  }

  async createRepo(name: string): Promise<GitHubRepoSummary> {
    const clean = name.trim();
    if (!/^[A-Za-z0-9._-]+$/.test(clean)) throw new Error("Invalid repository name");
    return {
      owner: "demo-user",
      name: clean,
      fullName: `demo-user/${clean}`,
      private: true,
      defaultBranch: "main",
      updatedAt: new Date().toISOString(),
      mock: true,
    };
  }

  // ---------------------------------------------------------------------
  // Phase 8: ship operations (in-memory, labelled mock).
  // ---------------------------------------------------------------------

  private branches = new Map<string, string>([["main", "mock-sha-0000000"]]);
  private pulls: GitHubPullRequest[] = [];
  private branchSeq = 0;

  async getRepo(): Promise<GitHubRepoSummary> {
    return (await this.listRepos())[0]!;
  }

  async getBranch(name: string): Promise<GitHubBranch | null> {
    assertBranchName(name);
    const sha = this.branches.get(name);
    return sha
      ? { name, sha, url: `https://github.com/demo-user/acme-plumbing-site/tree/${name}`, mock: true }
      : null;
  }

  async createBranch(name: string, opts?: { from?: string }): Promise<GitHubBranch> {
    assertBranchName(name);
    if (this.branches.has(name)) throw new Error("GitHub API error 422: Reference already exists (MOCK)");
    const from = opts?.from ?? "main";
    const sha = this.branches.get(from);
    if (!sha) throw new Error(`Base branch ${from} not found on GitHub`);
    this.branchSeq += 1;
    this.branches.set(name, `${sha.slice(0, 9)}${String(this.branchSeq).padStart(7, "0")}`);
    return (await this.getBranch(name))!;
  }

  async compare(base: string, head: string): Promise<GitHubCompare> {
    if (!this.branches.has(base) || !this.branches.has(head)) throw new Error("Not found on GitHub");
    const same = this.branches.get(base) === this.branches.get(head);
    return {
      status: same ? "identical" : "ahead",
      aheadBy: same ? 0 : 1,
      behindBy: 0,
      totalCommits: same ? 0 : 1,
      files: same
        ? []
        : [
            {
              filename: "index.html",
              status: "modified",
              additions: 1,
              deletions: 1,
              patch: "@@ -12 +12 @@\n-    <h2>We fix leaks, install water heaters, and unclog drains.</h2>\n+    <h2>We fix leaks fast. (MOCK)</h2>",
            },
          ],
      htmlUrl: `https://github.com/demo-user/acme-plumbing-site/compare/${base}...${head}`,
      mock: true,
    };
  }

  async openPullRequest(input: OpenPullRequestInput): Promise<GitHubPullRequest> {
    assertBranchName(input.head);
    const base = input.base ?? "main";
    if (base === input.head) throw new Error("A pull request needs a head branch different from its base");
    if (!this.branches.has(input.head)) throw new Error("GitHub API error 422: head branch not found (MOCK)");
    const number = this.pulls.length + 1;
    const pr: GitHubPullRequest = {
      number,
      url: `https://github.com/demo-user/acme-plumbing-site/pull/${number}`,
      title: input.title.trim().slice(0, 256),
      body: input.body ?? "",
      state: "open",
      merged: false,
      draft: input.draft === true,
      head: input.head,
      base,
      headSha: this.branches.get(input.head)!,
      mergeable: true,
      mock: true,
    };
    this.pulls.push(pr);
    return { ...pr };
  }

  private pull(number: number): GitHubPullRequest {
    const pr = this.pulls.find((p) => p.number === number);
    if (!pr) throw new Error("Not found on GitHub");
    return pr;
  }

  async updatePullRequest(number: number, patch: UpdatePullRequestInput): Promise<GitHubPullRequest> {
    const pr = this.pull(number);
    if (patch.title !== undefined) pr.title = patch.title.slice(0, 256);
    if (patch.body !== undefined) pr.body = patch.body;
    if (patch.state !== undefined) pr.state = patch.state;
    if (patch.base !== undefined) pr.base = patch.base;
    return { ...pr };
  }

  async getPullRequest(number: number): Promise<GitHubPullRequest> {
    return { ...this.pull(number) };
  }

  async findPullRequestForBranch(branch: string): Promise<GitHubPullRequest | null> {
    const pr = this.pulls.find((p) => p.head === branch && p.state === "open");
    return pr ? { ...pr } : null;
  }

  async getPullRequestStatus(number: number): Promise<GitHubPrStatus> {
    const pr = await this.getPullRequest(number);
    return {
      pr,
      ...rollUpChecks([
        {
          name: "build (MOCK)",
          source: "check_run",
          status: "completed",
          conclusion: "success",
          url: null,
          summary: "Demo check — not a real CI run",
        },
      ]),
      mock: true,
    };
  }

  async listReviewComments(number: number): Promise<GitHubReviewComment[]> {
    this.pull(number);
    return [
      {
        id: 1,
        path: "index.html",
        line: 12,
        body: "Can we keep the water heater mention? (MOCK)",
        author: "demo-reviewer",
        url: `https://github.com/demo-user/acme-plumbing-site/pull/${number}#discussion_r1`,
        createdAt: new Date(0).toISOString(),
        inReplyTo: null,
        mock: true,
      },
    ];
  }

  async listReviews(number: number): Promise<GitHubReview[]> {
    this.pull(number);
    return [
      {
        id: 1,
        author: "demo-reviewer",
        state: "CHANGES_REQUESTED",
        body: "One small change, then good to go. (MOCK)",
        url: `https://github.com/demo-user/acme-plumbing-site/pull/${number}#pullrequestreview-1`,
        submittedAt: new Date(0).toISOString(),
        mock: true,
      },
    ];
  }

  async pushFiles(
    files: { path: string; content: string }[],
    _message: string,
  ): Promise<PushResult> {
    for (const f of files) this.files.set(sanitizePath(f.path), f.content);
    const digest = files
      .map((f) => f.path.length + f.content.length)
      .reduce((a, b) => a + b, 0)
      .toString(16);
    return {
      sha: `mock-sha-${digest.padStart(7, "0")}`,
      files: files.map((f) => ({ path: sanitizePath(f.path), ok: true })),
      mock: true,
    };
  }
}

export type { SiteFileProvider };
