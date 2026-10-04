// ShapesOS — Phase 8 (ship): who may act on a GitHub repository, and how.
//
// A repository is reachable for a workspace in one of two ways (checked in
// this order):
//   1. GitHub App — GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY are set and the
//      app is installed on the repository: short-lived installation tokens
//      (lib/connectors/github-app.ts, cached until expiry).
//   2. Personal access token — a GitHub site in this workspace
//      (Websites → GitHub) points at the repository; its token is stored
//      encrypted in Site.configEnc (lib/connectors/source.ts).
// A demo GitHub site resolves to the labelled mock connector; it can't be
// cloned (there is no real repository behind it) and says so.
//
// The token never leaves this module except through RepoAccess.token(),
// which the git tools pass straight into one sandbox process's environment.

import { prisma } from "@/lib/prisma";
import { GitHubSiteFileProvider } from "@/lib/connectors/github";
import { MockGitHubConnector } from "@/lib/connectors/mock-github";
import { githubApp, type GitHubAppAuth } from "@/lib/connectors/github-app";
import { decryptSiteConfig } from "@/lib/connectors/source";
import type { GitHubConnector } from "@/lib/connectors/types";
import { parseRepoFullName } from "./git";

export interface RepoAccess {
  owner: string;
  repo: string;
  fullName: string;
  mode: "app" | "pat" | "mock";
  connector: GitHubConnector;
  /** A token for git over https (throws for the mock). */
  token(): Promise<string>;
}

export interface RepoAccessDeps {
  /** GitHub App auth (default: from env; null = App mode off). */
  app?: GitHubAppAuth | null;
  /** Decrypted GitHub site configs in the workspace (default: from the DB). */
  siteConfigs?: (workspaceId: string) => Promise<Record<string, unknown>[]>;
  fetch?: typeof fetch;
}

async function workspaceGithubSiteConfigs(workspaceId: string): Promise<Record<string, unknown>[]> {
  const sites = await prisma.site.findMany({
    where: { sourceType: "github", project: { workspaceId } },
    select: { configEnc: true },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  return sites.map((s) => decryptSiteConfig(s));
}

export class RepoAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoAccessError";
  }
}

/** Resolve how this workspace reaches owner/name. Throws RepoAccessError with a fix. */
export async function resolveRepoAccess(
  workspaceId: string,
  repoFullName: string,
  deps: RepoAccessDeps = {},
): Promise<RepoAccess> {
  const { owner, repo, fullName } = parseRepoFullName(repoFullName);
  const app = deps.app === undefined ? githubApp() : deps.app;
  const fetchDep = deps.fetch ? { fetch: deps.fetch } : {};

  // 1. GitHub App, when configured and installed on this repository.
  if (app) {
    let installed = false;
    try {
      await app.installationIdFor(owner, repo);
      installed = true;
    } catch {
      installed = false; // not installed here → try a PAT site below
    }
    if (installed) {
      const getToken = async () => (await app.tokenFor(owner, repo)).token;
      return {
        owner,
        repo,
        fullName,
        mode: "app",
        connector: new GitHubSiteFileProvider({ token: "", owner, repo, branch: "main", demo: false, getToken }, fetchDep),
        token: getToken,
      };
    }
  }

  // 2. A GitHub site in this workspace for the same repository.
  const configs = await (deps.siteConfigs ?? workspaceGithubSiteConfigs)(workspaceId);
  const match = configs.find(
    (c) =>
      String(c.owner ?? "").toLowerCase() === owner.toLowerCase() &&
      String(c.repo ?? "").toLowerCase() === repo.toLowerCase(),
  );
  if (match?.demo === true) {
    return {
      owner,
      repo,
      fullName,
      mode: "mock",
      connector: new MockGitHubConnector(),
      token: async () => {
        throw new RepoAccessError(`${fullName} is a demo repository (mock data); connect a real GitHub repository to clone it.`);
      },
    };
  }
  const pat = typeof match?.token === "string" ? match.token.trim() : "";
  if (pat) {
    return {
      owner,
      repo,
      fullName,
      mode: "pat",
      connector: new GitHubSiteFileProvider(
        { token: pat, owner, repo, branch: String(match?.branch ?? "main"), demo: false },
        fetchDep,
      ),
      token: async () => pat,
    };
  }
  throw new RepoAccessError(
    app
      ? `The ShapesOS GitHub App is not installed on ${fullName}, and no GitHub site in this workspace points at it. Install the app on the repository, or connect it under Websites → GitHub.`
      : `No GitHub access to ${fullName}. Connect it under Websites → GitHub (a token with repo access), or configure the ShapesOS GitHub App.`,
  );
}
