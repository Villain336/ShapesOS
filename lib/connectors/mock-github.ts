// Marketr — mock GitHub connector (milestone 7).
//
// Deterministic demo repo (a small static site for "Acme Plumbing") so the
// full connect → browse → edit → deploy flow works end-to-end without GitHub
// credentials or network access. Every entry/result is flagged mock: true and
// the UI labels it honestly. Writes mutate an in-memory map (per server
// process); restarting resets the demo. Never ship as real data.

import type { FileEntry, ReadResult, SiteFileProvider } from "@/lib/sitefiles/types";
import { joinPath, parentPath, sanitizePath } from "@/lib/sitefiles/paths";
import type { GitHubConnector, GitHubRepoSummary, PushResult } from "./types";

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
    ["# acme-plumbing-site (MOCK)", "", "Demo repo served by Marketr's mock GitHub connector.", ""].join("\n"),
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
