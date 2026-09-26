// Marketr — Phase 10 M8: expertise profile loader.
//
// The opportunity ranker matches threads against what the workspace knows
// about — built from Phase 1 keyword storage: Keyword rows with
// tracked=true across the workspace's projects, plus the competitors
// table (competitor mentions are a signal) and project domains (excluded
// from competitor matching so self-mentions don't score).

import { withWorkspaceScope, type TxClient } from "@/lib/substrate/graph/rls";
import type { ExpertiseProfile } from "./types";

interface ProfileRows {
  keywords: string[];
  competitorDomains: string[];
  projectDomains: string[];
}

/** Pure normalization — unit-testable without a database. */
export function buildExpertiseProfile(rows: ProfileRows): ExpertiseProfile {
  const norm = (s: string) => s.trim().toLowerCase();
  const dedupe = (xs: string[]) => [...new Set(xs.map(norm).filter(Boolean))];
  return {
    trackedKeywords: dedupe(rows.keywords),
    competitorDomains: dedupe(rows.competitorDomains),
    projectDomains: dedupe(rows.projectDomains),
  };
}

type ProfileTx = Pick<TxClient, "project" | "keyword" | "competitor">;

/** Load the workspace's expertise profile (tenant-scoped, fail-closed). */
export async function loadExpertiseProfile(
  workspaceId: string,
  txOverride?: ProfileTx,
): Promise<ExpertiseProfile> {
  const run = async (tx: ProfileTx): Promise<ProfileRows> => {
    const projects = await tx.project.findMany({
      where: { workspaceId },
      select: { id: true, domain: true },
    });
    const projectIds = projects.map((p) => p.id);
    const keywords =
      projectIds.length === 0
        ? []
        : await tx.keyword.findMany({
            where: { projectId: { in: projectIds }, tracked: true },
            select: { phrase: true },
            take: 200,
          });
    const competitors =
      projectIds.length === 0
        ? []
        : await tx.competitor.findMany({
            where: { projectId: { in: projectIds } },
            select: { domain: true },
          });
    return {
      keywords: keywords.map((k) => k.phrase),
      competitorDomains: competitors.map((c) => c.domain),
      projectDomains: projects.map((p) => p.domain),
    };
  };
  const rows = txOverride
    ? await run(txOverride)
    : await withWorkspaceScope(workspaceId, (tx) => run(tx as unknown as ProfileTx));
  return buildExpertiseProfile(rows);
}
