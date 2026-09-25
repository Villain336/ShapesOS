// Marketr — Playbook persistence + review queue (Phase 8 G3).
//
// Cross-client learning travels ONLY as anonymized, human-reviewed playbook
// patterns (spec §8.4 — "no shared client-fact pooling, ever"). Pipeline:
//   1. proposePlaybookPattern(workspaceId, learningId): anonymize the
//      learning's hypothesis+action. Quarantined (risky PII/spend figures
//      survive) → NOT inserted, reasons returned.
//   2. Row lands in playbook_learnings with reviewed_at NULL. Normal SELECT
//      (FORCE RLS) sees reviewed rows only; the review queue is exposed via
//      the reviewer GUC (app.playbook_reviewer=1).
//   3. Human approves → reviewed_at + anonymization_reviewed_by stamped.
//      Rejected candidates are DELETED (they are proposals, not history).
//
// Real columns (migration 20260925180000_phase8_memory): id, patternTitle,
// patternBody, supportingClientCount, firstObserved, lastObserved,
// anonymizationReviewedBy, reviewedAt. "Pending" vs "approved" is DERIVED:
// reviewedAt IS NULL → pending; IS NOT NULL → approved/published.

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope, withPlaybookReviewer } from "./rls";
import { anonymizeForPlaybook } from "./anonymize";
import { scrubJson } from "./scrub";
import { memoryAudit } from "./audit";

export interface ProposalInput {
  learningId: string;
  /** optional editor override of the auto-summary */
  title?: string | null;
}

export interface ProposalResult {
  inserted: boolean;
  playbookId: string | null;
  quarantined: boolean;
  quarantineReasons: string[];
}

/**
 * Propose a playbook pattern from a learning. The learning is read through
 * the tenant's RLS scope (never cross-workspace); the anonymized pattern is
 * stored WITHOUT any workspace attribution.
 */
export async function proposePlaybookPattern(
  workspaceId: string,
  input: ProposalInput,
): Promise<ProposalResult> {
  const learning = await withWorkspaceScope(workspaceId, (tx) =>
    tx.memoryLearning.findUnique({
      where: { id: input.learningId },
      select: { id: true, workspaceId: true, hypothesis: true, action: true, result: true },
    }),
  );
  if (!learning || learning.workspaceId !== workspaceId) {
    throw new Error("Learning not found in this workspace.");
  }
  const anon = anonymizeForPlaybook(learning.hypothesis, `${learning.hypothesis}\n${learning.action}`);
  if (anon.needsManualReview) {
    return { inserted: false, playbookId: null, quarantined: true, quarantineReasons: ["needsManualReview"] };
  }
  // Defense in depth: the source learning was scrubbed at write time, but the
  // playbook row is a second persistence — scrub the anonymized text again.
  const scrubbedTitle = scrubJson({ t: ((input.title?.slice(0, 240) ?? anon.title.slice(0, 240)) || learning.hypothesis.slice(0, 240)) });
  const scrubbedBody = scrubJson({ b: anon.body.slice(0, 4000) });
  // INSERT ... RETURNING under FORCE RLS: the SELECT policy only reveals
  // reviewed rows, so a plain insert cannot RETURN its own unreviewed row.
  // Insert through the reviewer-scoped transaction (sets
  // app.playbook_reviewer='1'); the row is still unreviewed, hence invisible
  // to normal reads — the publication gate holds.
  const created = await withPlaybookReviewer(workspaceId, (tx) =>
    tx.playbookLearning.create({
      data: {
        patternTitle: (scrubbedTitle.value as { t: string }).t,
        patternBody: (scrubbedBody.value as { b: string }).b,
        supportingClientCount: 1,
      },
      select: { id: true },
    }),
  );
  return { inserted: true, playbookId: created.id, quarantined: false, quarantineReasons: [] };
}

export interface PlaybookListItem {
  id: string;
  patternTitle: string;
  patternBody: string;
  supportingClientCount: number;
  firstObserved: string;
  lastObserved: string;
  anonymizationReviewedBy: string | null;
  reviewedAt: string | null;
  /** Derived: "approved" when reviewedAt is set, else "pending". */
  status: "pending" | "approved";
}

/**
 * Published patterns. NOTE: playbook_learnings has FORCE RLS; plain Prisma
 * queries (no reviewer GUC) see reviewed rows only — that IS the publication
 * gate. The explicit reviewedAt filter is belt-and-braces.
 */
export async function listReviewedPatterns(opts: {
  q?: string;
  limit?: number;
}): Promise<PlaybookListItem[]> {
  const rows = await prisma.playbookLearning.findMany({
    where: {
      NOT: { reviewedAt: null },
      ...(opts.q
        ? {
            OR: [
              { patternTitle: { contains: opts.q, mode: "insensitive" } },
              { patternBody: { contains: opts.q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { reviewedAt: "desc" },
    take: Math.min(opts.limit ?? 50, 200),
  });
  return rows.map(toItem);
}

/** Review queue: unreviewed patterns. Requires the reviewer GUC. */
export async function listReviewQueue(workspaceId: string): Promise<PlaybookListItem[]> {
  return withPlaybookReviewer(workspaceId, async (tx) => {
    const rows = await tx.playbookLearning.findMany({
      where: { reviewedAt: null },
      orderBy: { firstObserved: "asc" },
      take: 100,
    });
    return rows.map(toItem);
  });
}

export async function reviewPattern(
  workspaceId: string,
  reviewerUserId: string,
  playbookId: string,
  decision: "approved" | "rejected",
  note?: string,
): Promise<boolean> {
  const ok = await withPlaybookReviewer(workspaceId, async (tx) => {
    if (decision === "approved") {
      const res = await tx.playbookLearning.updateMany({
        where: { id: playbookId, reviewedAt: null },
        data: {
          reviewedAt: new Date(),
          anonymizationReviewedBy: reviewerUserId,
          lastObserved: new Date(),
        },
      });
      return res.count === 1;
    }
    // Rejected proposals are not history — delete the candidate.
    const res = await tx.playbookLearning.deleteMany({
      where: { id: playbookId, reviewedAt: null },
    });
    return res.count === 1;
  });
  if (ok) {
    memoryAudit().log(workspaceId, reviewerUserId, `playbook.${decision}`, playbookId, { note });
  }
  return ok;
}

function toItem(r: {
  id: string;
  patternTitle: string;
  patternBody: string;
  supportingClientCount: number;
  firstObserved: Date;
  lastObserved: Date;
  anonymizationReviewedBy: string | null;
  reviewedAt: Date | null;
}): PlaybookListItem {
  return {
    id: r.id,
    patternTitle: r.patternTitle,
    patternBody: r.patternBody,
    supportingClientCount: r.supportingClientCount,
    firstObserved: r.firstObserved.toISOString(),
    lastObserved: r.lastObserved.toISOString(),
    anonymizationReviewedBy: r.anonymizationReviewedBy,
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    status: r.reviewedAt ? "approved" : "pending",
  };
}
