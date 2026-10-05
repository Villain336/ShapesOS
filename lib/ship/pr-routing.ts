// ShapesOS — Phase 9 (repos): the ONE cross-workspace read of agent PRs.
//
// A GitHub delivery (or the poller) has no workspace; these two reads find
// it. They set app.github_route = 'lookup', which only a SELECT-only RLS
// policy on agent_pull_requests honours (migration
// 20261010200000_p9_repos_agent_pull_requests), and return ids only. Every
// write after that runs under the row's own tenant GUC (./pull-requests.ts).
// Kept in its own file so the defense-in-depth allow-list
// (lib/substrate/memory/__tests__/rls-defense-in-depth.test.ts) exempts only
// these reads.

import { prisma } from "@/lib/prisma";

/** "owner/name" as stored (lower-cased). */
export function normalizeRepo(fullName: string): string {
  return fullName.trim().toLowerCase();
}

export interface PullRequestRoute {
  id: string;
  workspaceId: string;
}

/**
 * Which workspace owns this repository's branch (or PR number)? Read-only,
 * through the app.github_route SELECT policy; returns ids only.
 */
export async function routePullRequest(q: { repoFullName: string; branch?: string | null; prNumber?: number | null }): Promise<PullRequestRoute | null> {
  const repoFullName = normalizeRepo(q.repoFullName);
  if (!q.branch && !q.prNumber) return null;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.github_route = 'lookup'`);
    return tx.agentPullRequest.findFirst({
      where: q.branch ? { repoFullName, branch: q.branch } : { repoFullName, prNumber: q.prNumber! },
      orderBy: { createdAt: "desc" },
      select: { id: true, workspaceId: true },
    });
  });
}

/** Open agent PRs in every workspace (the poller's discovery; ids only). */
export async function discoverOpenPullRequests(limit = 500): Promise<PullRequestRoute[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.github_route = 'lookup'`);
    return tx.agentPullRequest.findMany({
      where: { state: { in: ["pushed", "open"] } },
      orderBy: { updatedAt: "asc" },
      take: Math.max(1, limit),
      select: { id: true, workspaceId: true },
    });
  });
}
