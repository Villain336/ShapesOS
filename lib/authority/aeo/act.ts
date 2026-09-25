// Marketr — A1 AEO: the act leg.
// Tico's directive: agents find the highest-impact sources, then ACT where
// possible or hand the user a concrete plan.
// - Owned-domain sources → GEO16-pillar fix proposals → the supervised
//   fix-agent ladder (propose → human approves → apply). NEVER autonomous:
//   apply() requires the authority approval to be executed, and execute()
//   re-verifies the exact binding and HALTS on mismatch (spine).
// - Third-party sources → concrete user action plans {exact target,
//   contribution angle, expected lift, deadline} tracked to completion.

import { prisma } from "@/lib/prisma";
import { authorityApprovals, authorityAudit } from "../db";
import { domainOf } from "./scoring";
import type { SourceImpactRow } from "./impact";

export const GEO16_PILLARS = [
  "metadata_freshness",
  "semantic_html",
  "structured_data",
  "query_matching_headings",
] as const;

export type Geo16Pillar = (typeof GEO16_PILLARS)[number];

export const GEO16_PILLAR_LABELS: Record<Geo16Pillar, string> = {
  metadata_freshness: "Metadata & freshness",
  semantic_html: "Semantic HTML",
  structured_data: "Structured data",
  query_matching_headings: "Query-matching headings",
};

/** 2026 GEO16 benchmarks: pillar → (correlation r, observed citation impact). */
export const GEO16_BENCHMARKS: Record<Geo16Pillar, { r: number; impactPct: number }> = {
  metadata_freshness: { r: 0.68, impactPct: 47 },
  semantic_html: { r: 0.65, impactPct: 42 },
  structured_data: { r: 0.63, impactPct: 39 },
  query_matching_headings: { r: 0.58, impactPct: 31 },
};

export interface FixProposal {
  pageUrl: string;
  pillar: Geo16Pillar;
  gap: string;
  proposedChange: string;
  /** Benchmark citation impact for the pillar (directional, not a promise). */
  benchmarkImpactPct: number;
  rationale: string;
}

const PILLAR_FIXES: Record<Geo16Pillar, { gap: string; proposedChange: string; rationale: string }> = {
  metadata_freshness: {
    gap: "Stale metadata: title/description don't match the money-prompt queries and carry no freshness signals.",
    proposedChange:
      "Rewrite <title> and meta description around the exact money-prompt phrasing; add lastmod/updated timestamps and visible 'updated' dates on the page.",
    rationale: "Metadata & freshness is the strongest citability predictor (r=0.68, +47% citation impact).",
  },
  semantic_html: {
    gap: "Weak document structure: multiple or missing H1, headings don't mirror query language, landmark elements absent.",
    proposedChange:
      "One H1 per page; H2s that mirror the money prompts verbatim; wrap content in <article>/<section> landmarks with descriptive aria labels.",
    rationale: "Semantic HTML (r=0.65, +42%) — retrieval position is the #1 citation predictor and structure drives it.",
  },
  structured_data: {
    gap: "Missing or thin schema: no FAQPage/HowTo/Product markup for the page to be extracted as an answer unit.",
    proposedChange:
      "Add FAQPage schema answering the top money prompts verbatim plus Product/HowTo where applicable; validate with a schema linter before proposing.",
    rationale: "Structured data (r=0.63, +39%) — lets engines lift the page as a citable answer block.",
  },
  query_matching_headings: {
    gap: "No section answers the money prompts directly — the page ranks on brand terms, not on the questions engines cite.",
    proposedChange:
      "Add a comparison/FAQ section headed with the exact money-prompt questions ('Best CRM for …'), answering each in 40–60 words above the fold.",
    rationale: "Pages that answer the prompt verbatim get cited; 58% of citations come from retrieval position 1 vs 14% at position 10.",
  },
};

/** True when a cited domain belongs to the client (owned) rather than a third party. */
export function isOwnedDomain(domain: string, ownedDomains: string[]): boolean {
  const d = domain.toLowerCase().replace(/^www\./, "");
  return ownedDomains.some((o) => {
    const own = o.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
    return d === own || d.endsWith(`.${own}`);
  });
}

/**
 * Build GEO16 fix proposals for owned-domain sources: one proposal per
 * pillar per owned page. Proposals are DATA — applying them requires the
 * supervised ladder (approveAction → authority approval → execute).
 */
export function proposeOwnedFixes(input: {
  ownedDomains: string[];
  pageUrls: string[];
  brand: string;
}): FixProposal[] {
  const pages =
    input.pageUrls.length > 0
      ? input.pageUrls
      : input.ownedDomains.map((d) => `https://${d.replace(/^https?:\/\//, "").replace(/\/$/, "")}/`);
  const proposals: FixProposal[] = [];
  for (const pageUrl of pages) {
    for (const pillar of GEO16_PILLARS) {
      const fix = PILLAR_FIXES[pillar];
      proposals.push({
        pageUrl,
        pillar,
        gap: fix.gap,
        proposedChange: fix.proposedChange,
        benchmarkImpactPct: GEO16_BENCHMARKS[pillar].impactPct,
        rationale: fix.rationale,
      });
    }
  }
  return proposals;
}

export interface ThirdPartyActionPlan {
  exactTarget: string;
  domain: string;
  contributionAngle: string;
  expectedLift: number;
  /** ISO date the user commits to completing the engagement by. */
  deadline: string;
}

const ANGLE_BY_DOMAIN: [RegExp, string][] = [
  [/reddit\.com/, "Answer the thread with a genuinely useful, non-promotional breakdown; disclose affiliation; earn upvotes so the comment survives as a cited answer."],
  [/youtube\.com/, "Comment with timestamped corrections/additions or publish a response walkthrough; ask the creator to pin it."],
  [/g2\.com|trustpilot|capterra/, "Earn authentic customer reviews on the platform — ask happy customers directly; never incentivize (Google/formal bans)."],
  [/forbes\.com|.*news|.*\.com\/.*best/, "Pitch the listicle author a data point or customer story for the next refresh; offer an expert quote they can cite."],
];

/** Build a concrete user action plan for a third-party source (Marketr cannot edit these). */
export function buildThirdPartyPlan(
  impact: SourceImpactRow,
  opts: { deadlineDays?: number } = {},
): ThirdPartyActionPlan {
  const angle =
    ANGLE_BY_DOMAIN.find(([re]) => re.test(impact.domain))?.[1] ??
    "Engage the page owner/community with a useful, citable contribution — a data point, correction, or expert quote they can reference.";
  const deadline = new Date(Date.now() + (opts.deadlineDays ?? 14) * 86400_000)
    .toISOString()
    .slice(0, 10);
  return {
    exactTarget: impact.urls[0] ?? `https://${impact.domain}/`,
    domain: impact.domain,
    contributionAngle: angle,
    // Directional: the measured lift if this source starts being cited with us recommended.
    expectedLift: Math.round(impact.cooccurrenceLift * 1000) / 10,
    deadline,
  };
}

// ---------------------------------------------------------------------------
// Prisma-backed action lifecycle
// ---------------------------------------------------------------------------

export interface CreateActionInput {
  workspaceId: string;
  kind: "owned_fix" | "third_party_plan";
  sourceRef: string;
  geo16Pillars?: Geo16Pillar[];
  fixProposal?: FixProposal | null;
  actionPlan?: ThirdPartyActionPlan | null;
  expectedLift?: number | null;
  createdBy: string;
}

export async function createAction(input: CreateActionInput) {
  const action = await prisma.aeoAction.create({
    data: {
      workspaceId: input.workspaceId,
      kind: input.kind,
      sourceRef: input.sourceRef,
      geo16Pillars: input.geo16Pillars ?? [],
      fixProposalJson: (input.fixProposal ?? {}) as never,
      actionPlanJson: (input.actionPlan ?? {}) as never,
      expectedLift: input.expectedLift ?? null,
      status: "proposed",
    },
  });
  await authorityAudit.logAsync({
    workspaceId: input.workspaceId,
    actor: input.createdBy,
    action: "aeo_action_proposed",
    entityType: "aeo_action",
    entityId: action.id,
    detail: { kind: input.kind, sourceRef: input.sourceRef },
  });
  return action;
}

/**
 * Generate actions from the latest source-impact ranking:
 * owned domains → GEO16 fix proposals (owned_fix), everything else →
 * third-party user action plans. Skips sources that already have an open action.
 */
export async function generateActionsFromImpacts(input: {
  workspaceId: string;
  ownedDomains: string[];
  pageUrls?: string[];
  brand: string;
  createdBy: string;
  minLift?: number;
}): Promise<{ ownedFixes: number; thirdPartyPlans: number; skipped: number }> {
  const impacts = await prisma.aeoSourceImpact.findMany({
    where: { workspaceId: input.workspaceId },
    orderBy: [{ cooccurrenceLift: "desc" }],
    take: 60,
  });
  const minLift = input.minLift ?? 0;
  let ownedFixes = 0;
  let thirdPartyPlans = 0;
  let skipped = 0;

  for (const impact of impacts) {
    if (impact.cooccurrenceLift < minLift) continue;
    const existing = await prisma.aeoAction.findFirst({
      where: {
        workspaceId: input.workspaceId,
        sourceRef: impact.domain,
        status: { in: ["proposed", "approved", "applied"] },
      },
    });
    if (existing) {
      skipped += 1;
      continue;
    }
    if (isOwnedDomain(impact.domain, input.ownedDomains)) {
      const proposals = proposeOwnedFixes({
        ownedDomains: input.ownedDomains,
        pageUrls: input.pageUrls ?? [],
        brand: input.brand,
      });
      for (const proposal of proposals) {
        await createAction({
          workspaceId: input.workspaceId,
          kind: "owned_fix",
          sourceRef: impact.domain,
          geo16Pillars: [proposal.pillar],
          fixProposal: proposal,
          expectedLift: Math.round(impact.cooccurrenceLift * 1000) / 10,
          createdBy: input.createdBy,
        });
        ownedFixes += 1;
      }
    } else {
      const plan = buildThirdPartyPlan(
        {
          engine: impact.engine as never,
          domain: impact.domain,
          citationFrequency: impact.citationFrequency,
          citationEfficiency: impact.citationEfficiency,
          cooccurrenceLift: impact.cooccurrenceLift,
          urls: [],
        },
        {},
      );
      await createAction({
        workspaceId: input.workspaceId,
        kind: "third_party_plan",
        sourceRef: impact.domain,
        actionPlan: plan,
        expectedLift: plan.expectedLift,
        createdBy: input.createdBy,
      });
      thirdPartyPlans += 1;
    }
  }
  return { ownedFixes, thirdPartyPlans, skipped };
}

/**
 * Approve an action. Owned fixes enter the supervised ladder: an
 * aeo_content_fix authority approval is created AND submitted — the fix
 * cannot apply until that approval is approved AND executed (binding
 * re-verified, HALTS on mismatch). Third-party plans are approved as a
 * user commitment (no external publish — Marketr can't edit those pages).
 */
export async function approveAction(input: {
  id: string;
  workspaceId: string;
  approver: string;
}): Promise<{ actionId: string; status: string; approvalId: string | null }> {
  const action = await prisma.aeoAction.findFirst({
    where: { id: input.id, workspaceId: input.workspaceId },
  });
  if (!action) throw new Error("AEO action not found in workspace.");
  if (action.status !== "proposed") {
    throw new Error(`Cannot approve action in status ${action.status}.`);
  }

  let approvalId: string | null = null;
  if (action.kind === "owned_fix") {
    const binding = executionPayloadForAction(action);
    const approval = await authorityApprovals.create({
      workspaceId: input.workspaceId,
      type: "aeo_content_fix",
      bindingJson: binding,
      createdBy: input.approver,
    });
    await authorityApprovals.submit(approval.id, input.workspaceId, input.approver);
    approvalId = approval.id;
  }

  const updated = await prisma.aeoAction.update({
    where: { id: action.id },
    data: { status: "approved", approvalId },
  });
  await authorityAudit.logAsync({
    workspaceId: input.workspaceId,
    actor: input.approver,
    action: "aeo_action_approved",
    entityType: "aeo_action",
    entityId: action.id,
    detail: { kind: action.kind, approvalId },
  });
  return { actionId: updated.id, status: updated.status, approvalId };
}

/**
 * The exact binding payload approveAction() committed to the authority
 * approval. execute() re-verifies this byte-for-byte; any drift HALTS.
 */
export function executionPayloadForAction(action: {
  id: string;
  sourceRef: string;
  geo16Pillars: string[];
  fixProposalJson: unknown;
  expectedLift: number | null;
}): Record<string, unknown> {
  return {
    aeoActionId: action.id,
    sourceRef: action.sourceRef,
    geo16Pillars: action.geo16Pillars,
    fixProposal: action.fixProposalJson,
    expectedLift: action.expectedLift,
  };
}

/**
 * Apply an owned fix — ONLY after the linked authority approval has been
 * approved and executed. execute() re-verifies the binding; any mismatch
 * HALTS. This is the "never autonomous" gate.
 */
export async function applyOwnedFix(input: {
  id: string;
  workspaceId: string;
  actor: string;
  /** The exact payload that was executed against the authority approval. */
  executionPayload: Record<string, unknown>;
}): Promise<{ actionId: string; status: string }> {
  const action = await prisma.aeoAction.findFirst({
    where: { id: input.id, workspaceId: input.workspaceId },
  });
  if (!action) throw new Error("AEO action not found in workspace.");
  if (action.kind !== "owned_fix") throw new Error("Only owned_fix actions go through the fix ladder.");
  if (action.status !== "approved") throw new Error(`Cannot apply action in status ${action.status} — approve it first.`);
  if (!action.approvalId) throw new Error("No linked authority approval — the supervised ladder is mandatory.");

  // The spine's execute() re-verifies the binding and HALTS on mismatch.
  const executed = await authorityApprovals.execute(action.approvalId, input.workspaceId, input.executionPayload);
  if (executed.status !== "executed") throw new Error("Authority approval did not execute — apply blocked.");

  const updated = await prisma.aeoAction.update({
    where: { id: action.id },
    data: { status: "applied" },
  });
  await authorityAudit.logAsync({
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: "aeo_action_applied",
    entityType: "aeo_action",
    entityId: action.id,
    detail: { approvalId: action.approvalId },
  });
  return { actionId: updated.id, status: updated.status };
}

const TERMINAL_TRANSITIONS: Record<string, string[]> = {
  proposed: ["approved", "dismissed"],
  approved: ["applied", "dismissed"],
  applied: ["done", "dismissed"],
  done: [],
  dismissed: [],
};

/** Track a third-party plan (or mark anything done/dismissed) — no external publish involved. */
export async function transitionAction(input: {
  id: string;
  workspaceId: string;
  to: "applied" | "done" | "dismissed";
  actor: string;
  note?: string;
}): Promise<{ actionId: string; status: string }> {
  const action = await prisma.aeoAction.findFirst({
    where: { id: input.id, workspaceId: input.workspaceId },
  });
  if (!action) throw new Error("AEO action not found in workspace.");
  if (action.kind === "owned_fix" && input.to === "applied") {
    throw new Error("Owned fixes apply only through applyOwnedFix (authority approval must execute first).");
  }
  const allowed = TERMINAL_TRANSITIONS[action.status] ?? [];
  if (!allowed.includes(input.to)) {
    throw new Error(`Cannot move action from ${action.status} to ${input.to}.`);
  }
  const updated = await prisma.aeoAction.update({
    where: { id: action.id },
    data: { status: input.to },
  });
  await authorityAudit.logAsync({
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: `aeo_action_${input.to}`,
    entityType: "aeo_action",
    entityId: action.id,
    detail: { note: input.note ?? null },
  });
  return { actionId: updated.id, status: updated.status };
}

export { domainOf };
