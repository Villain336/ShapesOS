// Marketr — GitHub repo picker API (milestone 7).
// POST /api/websites/github/repos { projectId, token?, demo? }
//   → { repos: [{ owner, name, fullName, private, defaultBranch, mock? }] }
// POST /api/websites/github/repos { projectId, token, create: "<name>" }
//   → { repo } — creates a new (private) repo under the token's account.
//
// demo:true returns labeled mock repos (GitHub is unreachable from some
// environments). The token is used for this single request and never stored
// here — it is only persisted (encrypted) when the site is created.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { ownedProject, readJsonBody } from "@/lib/sitefiles/api";
import { GitHubSiteFileProvider } from "@/lib/connectors/github";
import { MockGitHubConnector } from "@/lib/connectors/mock-github";

interface ReposBody {
  projectId?: string;
  token?: string;
  demo?: boolean;
  create?: string;
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await readJsonBody<ReposBody>(req);
  if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });

  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

  try {
    if (body.demo === true) {
      const mock = new MockGitHubConnector();
      if (body.create?.trim()) {
        const repo = await mock.createRepo(body.create.trim());
        return Response.json({ repo });
      }
      return Response.json({ repos: await mock.listRepos() });
    }

    const token = (body.token ?? "").trim();
    if (!token) return Response.json({ error: "GitHub token is required" }, { status: 400 });
    const gh = new GitHubSiteFileProvider({ token, owner: "", repo: "", branch: "main", demo: false });

    if (body.create?.trim()) {
      const repo = await gh.createRepo(body.create.trim());
      return Response.json({ repo });
    }
    return Response.json({ repos: await gh.listRepos() });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "GitHub request failed" },
      { status: 502 },
    );
  }
}
