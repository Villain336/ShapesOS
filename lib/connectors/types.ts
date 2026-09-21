// Marketr — site connectors (milestone 7).
//
// A Site's files can live in a GitHub repo, on an SFTP host, or in a managed
// local directory (upload / AI-generated). Every connector implements the
// milestone-6 SiteFileProvider interface, so the IDE works identically no
// matter the source. GitHub adds repo-level operations (list/create repos,
// single-commit pushes) on top.

import type { SiteFileProvider } from "@/lib/sitefiles/types";

/** Decrypted GitHub config, server-side only. */
export interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  /** True → serve the deterministic mock repo instead of the GitHub API. */
  demo: boolean;
}

export interface GitHubRepoSummary {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string | null;
  mock?: boolean;
}

export interface PushResult {
  /** Commit SHA (real) or mock-sha-… (mock). */
  sha: string;
  files: { path: string; ok: boolean }[];
  mock?: boolean;
}

/** GitHub file connector: SiteFileProvider + repo operations. */
export interface GitHubConnector extends SiteFileProvider {
  readonly kind: "github";
  listRepos(): Promise<GitHubRepoSummary[]>;
  createRepo(name: string, opts?: { private?: boolean; description?: string }): Promise<GitHubRepoSummary>;
  /** Push many files in ONE commit. Used by Deploy. */
  pushFiles(files: { path: string; content: string }[], message: string): Promise<PushResult>;
}

export type { SiteFileProvider };
