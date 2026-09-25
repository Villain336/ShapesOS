// Marketr — O2 digital PR: service layer.
// Wires the pure pr/* modules to prisma, the approval spine, and the audit
// log. Route handlers stay thin; every rule lives here or in the pure
// modules. Invariants enforced:
//   - no auto-send on client identity, ever (Marketr records human sends)
//   - drafts never reach approval without the de-AI pass + full checklist
//   - every send attempt without an approved pr_send approval is blocked + audit-logged
//   - journalist rules (max 2 follow-ups, 48h cadence, 1:1, no attachments,
//     subject ≤49) enforced via assertJournalistSendAllowed

import { prisma } from "@/lib/prisma";
import type { Prisma, PrSource } from "@prisma/client";
import { authorityApprovals, authorityAudit } from "../db";
import { ApprovalError } from "../approvals";
import { approvalReceiptSecret } from "@/lib/media/safety";
import {
  ingestOpportunities, fixtureOpportunities,
  type PrOpportunityInput, type IngestedOpportunity,
} from "./ingest";
import {
  matchOpportunity, isStrongMatch,
  DEFAULT_EXPERTISE_PROFILE, type ExpertiseProfile,
} from "./match";
import { triageOpportunity, type Urgency } from "./triage";
import {
  buildDraftWorkspace, checklistAllPassed,
  type DraftWorkspace,
} from "./drafts";
import {
  blankRelationship, recordInteraction, authorizeSend,
  type RelationshipRecord, type JournalistInteraction,
} from "./relationships";
import {
  computeVisibilityImpact, exportPlacedDomains,
  type PlacementInput,
} from "./attribution";

export class PrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrError";
  }
}

const json = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

export interface IngestResult {
  received: number;
  rejected: { journalist: string; outlet: string; reason: string }[];
  created: { id: string; fingerprint: string; score: number; urgency: Urgency }[];
  deduped: number;
}

export async function ingestForWorkspace(input: {
  workspaceId: string;
  actor: string;
  sources?: string[];
  raw?: PrOpportunityInput[];
  expertise?: Partial<ExpertiseProfile>;
}): Promise<IngestResult> {
  const profile: ExpertiseProfile = { ...DEFAULT_EXPERTISE_PROFILE, ...(input.expertise ?? {}) };
  const raw = input.raw ?? fixtureOpportunities();
  const filtered = input.sources?.length
    ? raw.filter((r) => input.sources!.includes(r.source))
    : raw;
  const { ingested, rejected } = ingestOpportunities(filtered);

  const result: IngestResult = {
    received: ingested.length,
    rejected: rejected.map((r) => ({ journalist: r.row.journalist, outlet: r.row.outlet, reason: r.reason })),
    created: [],
    deduped: 0,
  };
  const now = new Date();

  for (const opp of ingested) {
    // De-dupe against the DB: same journalist + outlet + query text.
    const existing = await prisma.prOpportunity.findFirst({
      where: {
        workspaceId: input.workspaceId,
        journalist: opp.journalist,
        outlet: opp.outlet,
        queryText: opp.queryText,
      },
      select: { id: true },
    });
    if (existing) {
      result.deduped += 1;
      continue;
    }
    const match = matchOpportunity(opp, profile);
    const triaged = triageOpportunity(opp, { wasMatched: isStrongMatch(match), now });
    const row = await prisma.prOpportunity.create({
      data: {
        workspaceId: input.workspaceId,
        source: opp.source as PrSource,
        journalist: opp.journalist,
        outlet: opp.outlet,
        queryText: opp.queryText,
        deadline: opp.deadline,
        matchScore: match.score,
        expertiseTags: opp.expertiseTags,
        status: triaged.resolvedStatus,
      },
      select: { id: true },
    });
    result.created.push({ id: row.id, fingerprint: opp.fingerprint, score: match.score, urgency: triaged.urgency });
  }

  await authorityAudit.logAsync({
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: "pr_opportunities_ingested",
    entityType: "pr_opportunity_batch",
    entityId: `batch-${now.getTime()}`,
    detail: { received: result.received, created: result.created.length, deduped: result.deduped },
  });
  return result;
}

// ---------------------------------------------------------------------------
// Opportunity feed (matched, deadline-triaged)
// ---------------------------------------------------------------------------

export interface FeedItem {
  id: string;
  source: string;
  journalist: string;
  outlet: string;
  queryText: string;
  deadline: Date | null;
  matchScore: number;
  expertiseTags: string[];
  status: string;
  urgency: Urgency;
  hoursLeft: number | null;
  sameDayUrgency: boolean;
}

export async function opportunityFeed(workspaceId: string, opts: { limit?: number } = {}): Promise<FeedItem[]> {
  const now = new Date();
  const rows = await prisma.prOpportunity.findMany({
    where: { workspaceId, status: { in: ["new", "matched", "drafting"] } },
    orderBy: [{ deadline: "asc" }, { matchScore: "desc" }],
    take: Math.min(opts.limit ?? 100, 200),
  });
  const triaged = rows.map((r) =>
    triageOpportunity(r as typeof r & { deadline: Date | null }, {
      wasMatched: r.status !== "new",
      now,
    }),
  );
  const rank: Record<Urgency, number> = { same_day: 0, within_48h: 1, this_week: 2, open: 3, expired: 4 };
  triaged.sort((a, b) => rank[a.urgency] - rank[b.urgency]);
  return triaged.map((t) => ({
    id: (t.opportunity as { id: string }).id,
    source: (t.opportunity as { source: string }).source,
    journalist: (t.opportunity as { journalist: string }).journalist,
    outlet: (t.opportunity as { outlet: string }).outlet,
    queryText: (t.opportunity as { queryText: string }).queryText,
    deadline: (t.opportunity as { deadline: Date | null }).deadline,
    matchScore: (t.opportunity as { matchScore: number }).matchScore,
    expertiseTags: (t.opportunity as { expertiseTags: string[] }).expertiseTags,
    status: (t.opportunity as { status: string }).status,
    urgency: t.urgency,
    hoursLeft: t.hoursLeft,
    sameDayUrgency: t.sameDayUrgency,
  }));
}

// ---------------------------------------------------------------------------
// Draft workspace
// ---------------------------------------------------------------------------

export interface CreateDraftInput {
  expertiseSummary: string;
  subject: string;
  bodyText?: string;
  guidelinesChecked?: boolean;
  audienceFit?: boolean;
}

export interface DraftResult {
  id: string;
  workspace: DraftWorkspace;
}

export async function createDraft(input: {
  workspaceId: string;
  opportunityId: string;
  actor: string;
  draft: CreateDraftInput;
}): Promise<DraftResult> {
  const opp = await prisma.prOpportunity.findFirst({
    where: { id: input.opportunityId, workspaceId: input.workspaceId },
  });
  if (!opp) throw new PrError("Opportunity not found in workspace.");
  if (opp.status === "expired") throw new PrError("Opportunity expired — drafting is blocked.");
  if (input.draft.subject.length > 49) {
    throw new PrError(`Subject is ${input.draft.subject.length} chars; journalist pitches require ≤49.`);
  }

  const workspace = buildDraftWorkspace({
    journalist: opp.journalist,
    outlet: opp.outlet,
    queryText: opp.queryText,
    expertiseSummary: input.draft.expertiseSummary,
    subject: input.draft.subject,
    bodyText: input.draft.bodyText ?? "",
    guidelinesChecked: input.draft.guidelinesChecked ?? false,
    audienceFit: input.draft.audienceFit ?? false,
  });

  const row = await prisma.prDraft.create({
    data: {
      workspaceId: input.workspaceId,
      opportunityId: opp.id,
      researchBriefJson: json({
        brief: workspace.brief,
        gap: workspace.gap,
        deAi: workspace.deAi,
      }),
      quoteSkeleton: workspace.quoteSkeleton,
      checklistJson: json({ items: workspace.checklist, subject: input.draft.subject }),
      deAiPassed: workspace.deAiPassed,
      status: "draft",
    },
    select: { id: true },
  });
  await prisma.prOpportunity.update({
    where: { id: opp.id },
    data: { status: "drafting" },
  });
  // Ensure a relationship row exists for the journalist (CRM-lite).
  await prisma.prRelationship.upsert({
    where: { workspaceId_journalist_outlet: { workspaceId: input.workspaceId, journalist: opp.journalist, outlet: opp.outlet } },
    update: {},
    create: { workspaceId: input.workspaceId, journalist: opp.journalist, outlet: opp.outlet },
  });

  await authorityAudit.logAsync({
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: "pr_draft_created",
    entityType: "pr_draft",
    entityId: row.id,
    detail: { opportunityId: opp.id, deAiPassed: workspace.deAiPassed, checklistPassed: checklistAllPassed(workspace.checklist) },
  });
  return { id: row.id, workspace };
}

/** Human approves the draft content. Drafts never send themselves. */
export async function approveDraft(input: {
  workspaceId: string;
  draftId: string;
  actor: string;
}): Promise<{ id: string; status: string }> {
  const draft = await prisma.prDraft.findFirst({
    where: { id: input.draftId, workspaceId: input.workspaceId },
    include: { opportunity: true },
  });
  if (!draft) throw new PrError("Draft not found in workspace.");
  if (draft.status !== "draft") throw new PrError(`Cannot approve draft in status ${draft.status}.`);
  if (!draft.deAiPassed) {
    throw new PrError("De-AI pass failed — rework the draft until de_ai_passed before human approval.");
  }
  const checklist = (draft.checklistJson as { items?: { passed: boolean }[] } | null)?.items ?? [];
  if (!checklistAllPassed(checklist.map((i) => ({ id: "", label: "", detail: "", passed: i.passed })))) {
    throw new PrError("Pre-send checklist is incomplete — all items must pass before approval.");
  }

  await prisma.prDraft.update({ where: { id: draft.id }, data: { status: "human_approved" } });
  await authorityAudit.logAsync({
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: "pr_draft_approved",
    entityType: "pr_draft",
    entityId: draft.id,
    detail: { opportunityId: draft.opportunityId, human: true },
  });
  return { id: draft.id, status: "human_approved" };
}

// ---------------------------------------------------------------------------
// Send (human-executed, approval-bound). Marketr never sends on the client's
// identity — this endpoint RECORDS a human-executed send against a pr_send
// approval. No approved approval → blocked + audit-logged.
// ---------------------------------------------------------------------------

export async function markSent(input: {
  workspaceId: string;
  draftId: string;
  actor: string;
  sentAt?: string;
}): Promise<{ draftId: string; approvalId: string; status: string }> {
  const draft = await prisma.prDraft.findFirst({
    where: { id: input.draftId, workspaceId: input.workspaceId },
    include: { opportunity: true },
  });
  if (!draft) throw new PrError("Draft not found in workspace.");

  const block = async (reason: string, detail?: Record<string, unknown>) => {
    await authorityAudit.logAsync({
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: "pr_send_blocked",
      entityType: "pr_draft",
      entityId: draft.id,
      detail: { reason, ...(detail ?? {}) },
    });
    throw new PrError(`Send blocked: ${reason}`);
  };

  if (draft.status === "sent") return block("draft already recorded as sent — duplicate send attempt");
  if (draft.status !== "human_approved") {
    return block(`draft status is ${draft.status}; human approval is required before a send can be recorded`);
  }

  const checklist = (draft.checklistJson as { subject?: string } | null) ?? {};
  const subject = (checklist.subject ?? "").toString();

  // Create the pr_send approval object (the accountability record), submit,
  // and have the acting human approve it — they are the one who pressed send
  // in their own email client, so the approval is their attestation.
  const binding = {
    type: "pr_send",
    draftId: draft.id,
    opportunityId: draft.opportunityId,
    journalist: draft.opportunity.journalist,
    outlet: draft.opportunity.outlet,
    subject,
  };
  const approval = await authorityApprovals.create({
    workspaceId: input.workspaceId,
    type: "pr_send",
    bindingJson: binding,
    createdBy: input.actor,
  });
  await authorityApprovals.submit(approval.id, input.workspaceId, input.actor);
  let approved = approval;
  try {
    approved = await authorityApprovals.approve(approval.id, input.workspaceId, input.actor, approvalReceiptSecret());
  } catch (err) {
    await authorityAudit.logAsync({
      workspaceId: input.workspaceId, actor: input.actor, action: "pr_send_blocked",
      entityType: "pr_draft", entityId: draft.id,
      detail: { reason: "pr_send approval could not be approved", error: err instanceof Error ? err.message : String(err) },
    });
    throw err instanceof ApprovalError ? err : new ApprovalError(String(err));
  }

  // Journalist ruleset enforcement (fail closed, blocked attempts logged).
  const rel = await loadRelationship(input.workspaceId, draft.opportunity.journalist, draft.opportunity.outlet);
  try {
    const { updated } = authorizeSend(rel, { subject, hasAttachment: false, isBcc: false });
    await saveRelationship(input.workspaceId, updated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await authorityAudit.logAsync({
      workspaceId: input.workspaceId, actor: input.actor, action: "pr_send_blocked",
      entityType: "pr_draft", entityId: draft.id,
      detail: { reason: "journalist ruleset violation", approvalId: approved.id, error: msg },
    });
    throw new PrError(`Journalist ruleset blocked the send: ${msg}`);
  }

  // Executor entry point: re-verifies the exact binding; HALTS on mismatch.
  const executed = await authorityApprovals.execute(approved.id, input.workspaceId, approved.bindingJson);

  await prisma.prDraft.update({
    where: { id: draft.id },
    data: { status: "sent", approvalId: executed.id },
  });
  await prisma.prOpportunity.update({
    where: { id: draft.opportunityId },
    data: { status: "submitted" },
  });
  await authorityAudit.logAsync({
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: "pr_send_recorded",
    entityType: "pr_draft",
    entityId: draft.id,
    detail: {
      approvalId: executed.id,
      bindingHash: executed.bindingHash,
      humanExecuted: true,
      note: "Marketr did not send this email — the human sent it from their own client. This record is the audit trail.",
    },
  });
  return { draftId: draft.id, approvalId: executed.id, status: "sent" };
}

// ---------------------------------------------------------------------------
// Relationships (CRM-lite)
// ---------------------------------------------------------------------------

function toRelationshipRecord(r: {
  journalist: string;
  outlet: string;
  historyJson: unknown;
  declinationReasons: string[];
  reengagementEligibleAt: Date | null;
  followUpCount: number;
}): RelationshipRecord {
  const history = (Array.isArray(r.historyJson) ? r.historyJson : []) as {
    ts: string | Date;
    kind: JournalistInteraction["kind"];
    detail: string;
  }[];
  return {
    journalist: r.journalist,
    outlet: r.outlet,
    history: history.map((h) => ({ ...h, ts: new Date(h.ts) })),
    declinationReasons: r.declinationReasons,
    reengagementEligibleAt: r.reengagementEligibleAt,
    followUpCount: r.followUpCount,
  };
}

export async function loadRelationship(
  workspaceId: string,
  journalist: string,
  outlet: string,
): Promise<RelationshipRecord> {
  const row = await prisma.prRelationship.findUnique({
    where: { workspaceId_journalist_outlet: { workspaceId, journalist, outlet } },
  });
  return row ? toRelationshipRecord(row) : blankRelationship(journalist, outlet);
}

export async function saveRelationship(workspaceId: string, rel: RelationshipRecord): Promise<void> {
  await prisma.prRelationship.upsert({
    where: { workspaceId_journalist_outlet: { workspaceId, journalist: rel.journalist, outlet: rel.outlet } },
    update: {
      historyJson: json(rel.history.map((h) => ({ ...h, ts: h.ts.toISOString() }))),
      declinationReasons: rel.declinationReasons,
      reengagementEligibleAt: rel.reengagementEligibleAt,
      followUpCount: rel.followUpCount,
    },
    create: {
      workspaceId,
      journalist: rel.journalist,
      outlet: rel.outlet,
      historyJson: json(rel.history.map((h) => ({ ...h, ts: h.ts.toISOString() }))),
      declinationReasons: rel.declinationReasons,
      reengagementEligibleAt: rel.reengagementEligibleAt,
      followUpCount: rel.followUpCount,
    },
  });
}

export async function listRelationships(workspaceId: string): Promise<(RelationshipRecord & { id: string })[]> {
  const rows = await prisma.prRelationship.findMany({
    where: { workspaceId },
    orderBy: { journalist: "asc" },
  });
  return rows.map((r) => ({ id: r.id, ...toRelationshipRecord(r) }));
}

export async function recordRelationshipEvent(input: {
  workspaceId: string;
  actor: string;
  journalist: string;
  outlet: string;
  kind: JournalistInteraction["kind"];
  detail: string;
  declinationReason?: string;
}): Promise<RelationshipRecord & { id: string }> {
  const now = new Date();
  const row = await prisma.prRelationship.upsert({
    where: { workspaceId_journalist_outlet: { workspaceId: input.workspaceId, journalist: input.journalist, outlet: input.outlet } },
    update: {},
    create: { workspaceId: input.workspaceId, journalist: input.journalist, outlet: input.outlet },
  });
  let rel = toRelationshipRecord(row);
  if (input.kind === "declined") {
    const { recordDeclination } = await import("./relationships");
    rel = recordDeclination(rel, input.declinationReason ?? input.detail, now);
  } else {
    rel = recordInteraction(rel, input.kind, input.detail, now);
  }
  await saveRelationship(input.workspaceId, rel);
  await authorityAudit.logAsync({
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: "pr_relationship_event",
    entityType: "pr_relationship",
    entityId: row.id,
    detail: { journalist: input.journalist, outlet: input.outlet, kind: input.kind },
  });
  return { id: row.id, ...rel };
}

// ---------------------------------------------------------------------------
// Placements + attribution
// ---------------------------------------------------------------------------

export async function recordPlacement(input: {
  workspaceId: string;
  actor: string;
  opportunityId?: string | null;
  url: string;
  outlet: string;
  publishDate?: string | null;
  signals?: PlacementInput["signals"];
}): Promise<{ id: string; impact: ReturnType<typeof computeVisibilityImpact> }> {
  let opportunityId: string | null = input.opportunityId ?? null;
  if (opportunityId) {
    const opp = await prisma.prOpportunity.findFirst({
      where: { id: opportunityId, workspaceId: input.workspaceId },
      select: { id: true },
    });
    if (!opp) throw new PrError("Opportunity not found in workspace.");
  }
  const placement: PlacementInput = {
    url: input.url,
    outlet: input.outlet,
    publishDate: input.publishDate ? new Date(input.publishDate) : null,
    signals: input.signals,
  };
  const impact = computeVisibilityImpact(placement);
  const row = await prisma.prPlacement.create({
    data: {
      workspaceId: input.workspaceId,
      opportunityId,
      url: input.url,
      outlet: input.outlet,
      publishDate: placement.publishDate,
      visibilityImpactJson: json({ impact, signals: input.signals ?? {} }),
    },
    select: { id: true },
  });
  if (opportunityId) {
    await prisma.prOpportunity.update({ where: { id: opportunityId }, data: { status: "placed" } });
  }
  await authorityAudit.logAsync({
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: "pr_placement_recorded",
    entityType: "pr_placement",
    entityId: row.id,
    detail: { outlet: input.outlet, url: input.url, impactScore: impact.score },
  });
  return { id: row.id, impact };
}

export async function listPlacements(workspaceId: string): Promise<{
  placements: {
    id: string;
    url: string;
    outlet: string;
    publishDate: Date | null;
    opportunityId: string | null;
    impact: unknown;
  }[];
  aeoSourceDomains: { domain: string; placements: number }[];
}> {
  const rows = await prisma.prPlacement.findMany({
    where: { workspaceId },
    orderBy: { publishDate: "desc" },
    take: 200,
  });
  return {
    placements: rows.map((r) => ({
      id: r.id,
      url: r.url,
      outlet: r.outlet,
      publishDate: r.publishDate,
      opportunityId: r.opportunityId,
      impact: r.visibilityImpactJson,
    })),
    aeoSourceDomains: exportPlacedDomains(rows.map((r) => ({ url: r.url, outlet: r.outlet, publishDate: r.publishDate }))),
  };
}

/** List drafts for the workspace (with their opportunities). */
export async function listDrafts(workspaceId: string): Promise<{
  id: string;
  status: string;
  deAiPassed: boolean;
  checklist: unknown;
  quoteSkeleton: string;
  brief: unknown;
  approvalId: string | null;
  opportunity: { id: string; journalist: string; outlet: string; deadline: Date | null };
}[]> {
  const rows = await prisma.prDraft.findMany({
    where: { workspaceId },
    include: { opportunity: { select: { id: true, journalist: true, outlet: true, deadline: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    deAiPassed: r.deAiPassed,
    checklist: r.checklistJson,
    quoteSkeleton: r.quoteSkeleton,
    brief: r.researchBriefJson,
    approvalId: r.approvalId,
    opportunity: r.opportunity,
  }));
}
