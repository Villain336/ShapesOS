// Marketr — Phase 8 G2: the Campaign object engine.
// (docs/specs/SPEC-PHASE8.md §2 G2, §4; §9 safety invariants 1, 2, 7.)
//
// Campaign CRUD + hierarchy enforcement (≤3 levels, cycle detection), link
// attach/detach (surgical, auditable), the backfill proposer (precision over
// recall — zero auto-links), and the roll-up report aggregator.
//
// Safety:
// - Every DB touch runs inside withCampaignScope (RLS GUC + txn), and every
//   query also filters workspaceId explicitly (defense in depth).
// - Nothing here moves money (§3.1): budgetRollupCents is a reporting
//   convenience recomputed from linked fragments' declared budgets/spend;
//   no approval, pool, or execution path is created or widened.
// - Fragment tables are READ ONLY (see fragments.ts). History is never
//   remodeled; migration is link-not-replace.
// - Links materialize only via explicit human/orchestrator attach or by
//   resolving a pending proposal. The proposer NEVER writes campaign_links.

import {
  CAMPAIGN_STAGES,
  MAX_CAMPAIGN_DEPTH,
  CampaignError,
  type CampaignLinkedType,
  type CampaignLinkRole,
  type CampaignLinkSource,
  type CampaignStageKey,
  type CampaignStageState,
  type CampaignStageStatus,
  type FragmentMetric,
  type GrowthCampaignObjective,
  type GrowthCampaignStatus,
  type LinkProposalStatus,
  type MatchSignal,
  type MatchSignalKind,
} from "./types";
import { defaultStageFor, linkedTypeLabel, readFragment, scanWorkspaceFragments } from "./fragments";
import { withCampaignScope, type CampaignTx } from "./rls";
import type { Prisma } from "@prisma/client";

/** Prisma Json columns need InputJsonValue; our state types are plain JSON. */
function toJson(v: unknown): Prisma.InputJsonValue {
  return v as Prisma.InputJsonValue;
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

export function blankStages(): CampaignStageState[] {
  return CAMPAIGN_STAGES.map((key) => ({
    key,
    status: "not_started" as CampaignStageStatus,
    note: null,
    linkedRefs: [],
  }));
}

export function normalizeStages(raw: unknown): CampaignStageState[] {
  const blank = blankStages();
  if (!Array.isArray(raw)) return blank;
  const byKey = new Map<string, unknown>();
  for (const s of raw) {
    if (s && typeof s === "object" && "key" in s && typeof (s as { key: unknown }).key === "string") {
      byKey.set((s as { key: string }).key, s);
    }
  }
  return blank.map((b) => {
    const s = byKey.get(b.key) as Partial<CampaignStageState> | undefined;
    if (!s) return b;
    const status = (["not_started", "in_progress", "complete", "blocked", "skipped"] as CampaignStageStatus[]).includes(
      s.status as CampaignStageStatus,
    )
      ? (s.status as CampaignStageStatus)
      : b.status;
    const linkedRefs = Array.isArray(s.linkedRefs)
      ? s.linkedRefs.filter(
          (r): r is { linkedType: CampaignLinkedType; linkedId: string; stageKey: CampaignStageKey } =>
            !!r && typeof r === "object" && typeof (r as { linkedId?: unknown }).linkedId === "string",
        )
      : [];
    return { ...b, status, note: typeof s.note === "string" ? s.note : null, linkedRefs };
  });
}

function stageWithRef(stages: CampaignStageState[], key: CampaignStageKey, ref: { linkedType: CampaignLinkedType; linkedId: string }): CampaignStageState[] {
  return stages.map((s) => {
    if (s.key !== key) return s;
    const exists = s.linkedRefs.some((r) => r.linkedType === ref.linkedType && r.linkedId === ref.linkedId);
    const linkedRefs = exists ? s.linkedRefs : [...s.linkedRefs, { ...ref, stageKey: key }];
    const status: CampaignStageStatus = s.status === "not_started" ? "in_progress" : s.status;
    return { ...s, status, linkedRefs };
  });
}

function stageWithoutRef(stages: CampaignStageState[], linkedType: CampaignLinkedType, linkedId: string): CampaignStageState[] {
  return stages.map((s) => ({
    ...s,
    linkedRefs: s.linkedRefs.filter((r) => !(r.linkedType === linkedType && r.linkedId === linkedId)),
  }));
}

// ---------------------------------------------------------------------------
// CRUD + hierarchy
// ---------------------------------------------------------------------------

export interface CreateCampaignInput {
  name: string;
  objective: GrowthCampaignObjective;
  status?: GrowthCampaignStatus;
  parentCampaignId?: string | null;
  reportingConfig?: Record<string, unknown>;
  createdBy?: string;
}

/** Depth of a campaign: 1 = root, 2 = child, 3 = grandchild. */
export async function campaignDepth(tx: CampaignTx, workspaceId: string, campaignId: string): Promise<number> {
  let depth = 1;
  let cur: { parentCampaignId: string | null } | null = await tx.growthCampaign.findFirst({
    where: { id: campaignId, workspaceId },
    select: { parentCampaignId: true },
  });
  const seen = new Set<string>([campaignId]);
  while (cur?.parentCampaignId) {
    if (seen.has(cur.parentCampaignId)) throw new CampaignError("cycle", "Campaign hierarchy contains a cycle");
    seen.add(cur.parentCampaignId);
    depth += 1;
    cur = await tx.growthCampaign.findFirst({
      where: { id: cur.parentCampaignId, workspaceId },
      select: { parentCampaignId: true },
    });
    if (depth > MAX_CAMPAIGN_DEPTH + 1) break; // safety valve; real check below
  }
  return depth;
}

/** Would `campaignId` sit under `proposedParentId` without breaking rules? */
async function assertParentOk(
  tx: CampaignTx,
  workspaceId: string,
  campaignId: string | null,
  proposedParentId: string | null,
): Promise<void> {
  if (!proposedParentId) return;
  if (campaignId && proposedParentId === campaignId) {
    throw new CampaignError("cycle", "A campaign cannot be its own parent");
  }
  const parent = await tx.growthCampaign.findFirst({
    where: { id: proposedParentId, workspaceId },
    select: { id: true },
  });
  if (!parent) throw new CampaignError("not_found", "Parent campaign not found in this workspace");
  // Cycle: the proposed parent must not be a descendant of the campaign.
  if (campaignId) {
    let curId: string | null = proposedParentId;
    const seen = new Set<string>();
    while (curId) {
      if (curId === campaignId) throw new CampaignError("cycle", "Reparenting would create a hierarchy cycle");
      if (seen.has(curId)) throw new CampaignError("cycle", "Hierarchy contains a cycle");
      seen.add(curId);
      const row: { parentCampaignId: string | null } | null = await tx.growthCampaign.findFirst({
        where: { id: curId, workspaceId },
        select: { parentCampaignId: true },
      });
      curId = row?.parentCampaignId ?? null;
    }
  }
  const parentDepth = await campaignDepth(tx, workspaceId, proposedParentId);
  if (parentDepth + 1 > MAX_CAMPAIGN_DEPTH) {
    throw new CampaignError("depth_exceeded", `Hierarchy is limited to ${MAX_CAMPAIGN_DEPTH} levels`);
  }
}

export async function createCampaign(workspaceId: string, input: CreateCampaignInput) {
  if (!input.name?.trim()) throw new CampaignError("validation", "Campaign name is required");
  return withCampaignScope(workspaceId, async (tx) => {
    await assertParentOk(tx, workspaceId, null, input.parentCampaignId ?? null);
    const campaign = await tx.growthCampaign.create({
      data: {
        workspaceId,
        name: input.name.trim(),
        objective: input.objective,
        status: input.status ?? "draft",
        stages: toJson(blankStages()),
        reportingConfig: toJson(input.reportingConfig ?? {}),
        parentCampaignId: input.parentCampaignId ?? null,
        createdBy: input.createdBy ?? null,
      },
    });
    return campaign;
  });
}

export async function getCampaign(workspaceId: string, campaignId: string) {
  return withCampaignScope(workspaceId, async (tx) => {
    const campaign = await tx.growthCampaign.findFirst({
      where: { id: campaignId, workspaceId },
      include: {
        links: { orderBy: { linkedAt: "asc" } },
        parentCampaign: { select: { id: true, name: true, parentCampaignId: true } },
        children: { select: { id: true, name: true, status: true, objective: true } },
      },
    });
    if (!campaign) throw new CampaignError("not_found", "Campaign not found");
    return campaign;
  });
}

export async function listCampaigns(workspaceId: string, opts?: { status?: GrowthCampaignStatus; q?: string }) {
  return withCampaignScope(workspaceId, async (tx) => {
    return tx.growthCampaign.findMany({
      where: {
        workspaceId,
        ...(opts?.status ? { status: opts.status } : {}),
        ...(opts?.q ? { name: { contains: opts.q, mode: "insensitive" } } : {}),
      },
      include: {
        _count: { select: { links: true, children: true } },
        parentCampaign: { select: { id: true, name: true } },
      },
      orderBy: [{ createdAt: "desc" }],
      take: 200,
    });
  });
}

export async function updateCampaign(
  workspaceId: string,
  campaignId: string,
  patch: {
    name?: string;
    objective?: GrowthCampaignObjective;
    status?: GrowthCampaignStatus;
    reportingConfig?: Record<string, unknown>;
    parentCampaignId?: string | null;
    stages?: CampaignStageState[];
  },
) {
  return withCampaignScope(workspaceId, async (tx) => {
    const existing = await tx.growthCampaign.findFirst({ where: { id: campaignId, workspaceId } });
    if (!existing) throw new CampaignError("not_found", "Campaign not found");
    if (patch.parentCampaignId !== undefined) {
      await assertParentOk(tx, workspaceId, campaignId, patch.parentCampaignId);
    }
    if (patch.name !== undefined && !patch.name.trim()) {
      throw new CampaignError("validation", "Campaign name cannot be empty");
    }
    return tx.growthCampaign.update({
      where: { id: campaignId, workspaceId },
      data: {
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.objective ? { objective: patch.objective } : {}),
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.reportingConfig ? { reportingConfig: toJson(patch.reportingConfig) } : {}),
        ...(patch.parentCampaignId !== undefined ? { parentCampaignId: patch.parentCampaignId } : {}),
        ...(patch.stages ? { stages: toJson(normalizeStages(patch.stages)) } : {}),
      },
    });
  });
}

/** Create a sub-campaign (spec §5 POST :id/children). Enforces depth + cycle. */
export async function createChildCampaign(
  workspaceId: string,
  parentId: string,
  input: Omit<CreateCampaignInput, "parentCampaignId">,
) {
  return createCampaign(workspaceId, { ...input, parentCampaignId: parentId });
}

export async function listChildren(workspaceId: string, campaignId: string) {
  return withCampaignScope(workspaceId, async (tx) => {
    const campaign = await tx.growthCampaign.findFirst({ where: { id: campaignId, workspaceId }, select: { id: true } });
    if (!campaign) throw new CampaignError("not_found", "Campaign not found");
    return tx.growthCampaign.findMany({
      where: { parentCampaignId: campaignId, workspaceId },
      include: { _count: { select: { links: true, children: true } } },
      orderBy: { createdAt: "asc" },
    });
  });
}

/** Full ancestor chain, root-first (for hierarchy-aware list/detail). */
export async function ancestorChain(workspaceId: string, campaignId: string) {
  return withCampaignScope(workspaceId, async (tx) => {
    const chain: Array<{ id: string; name: string }> = [];
    let cur = await tx.growthCampaign.findFirst({
      where: { id: campaignId, workspaceId },
      select: { id: true, name: true, parentCampaignId: true },
    });
    if (!cur) throw new CampaignError("not_found", "Campaign not found");
    const seenAnc = new Set<string>();
    while (cur?.parentCampaignId) {
      if (seenAnc.has(cur.parentCampaignId)) break;
      seenAnc.add(cur.parentCampaignId);
      const p: { id: string; name: string; parentCampaignId: string | null } | null = await tx.growthCampaign.findFirst({
        where: { id: cur.parentCampaignId, workspaceId },
        select: { id: true, name: true, parentCampaignId: true },
      });
      if (!p) break;
      chain.unshift({ id: p.id, name: p.name });
      cur = p;
    }
    return chain;
  });
}

// ---------------------------------------------------------------------------
// Link attach / detach
// ---------------------------------------------------------------------------

export interface AttachLinkInput {
  linkedType: CampaignLinkedType;
  linkedId: string;
  role?: CampaignLinkRole;
  linkSource?: CampaignLinkSource;
  stageKey?: CampaignStageKey;
  platformRef?: Record<string, unknown> | null;
  linkedBy?: string;
}

async function recomputeBudgetRollup(tx: CampaignTx, workspaceId: string, campaignId: string): Promise<number> {
  const links = await tx.campaignLink.findMany({ where: { campaignId, campaign: { workspaceId } } });
  let total = 0;
  for (const l of links) {
    const f = await readFragment(tx, workspaceId, l.linkedType, l.linkedId);
    const spend = f?.metrics.find((m) => m.key === "spend_cents");
    if (typeof spend?.value === "number" && spend.value > 0) total += Math.round(spend.value);
  }
  await tx.growthCampaign.update({ where: { id: campaignId, workspaceId }, data: { budgetRollupCents: total } });
  return total;
}

/**
 * Attach a fragment to a campaign — the hook point per-channel builders call
 * ("Attach to campaign" at creation time, spec §2 G2 / flow B5).
 * See attach-point.md for the interface contract.
 */
export async function attachLink(workspaceId: string, campaignId: string, input: AttachLinkInput) {
  return withCampaignScope(workspaceId, async (tx) => {
    const campaign = await tx.growthCampaign.findFirst({ where: { id: campaignId, workspaceId } });
    if (!campaign) throw new CampaignError("not_found", "Campaign not found");
    const fragment = await readFragment(tx, workspaceId, input.linkedType, input.linkedId);
    if (!fragment) throw new CampaignError("fragment_missing", `${linkedTypeLabel(input.linkedType)} not found in this workspace`);
    const existing = await tx.campaignLink.findUnique({
      where: {
        campaignId_linkedType_linkedId: {
          campaignId,
          linkedType: input.linkedType,
          linkedId: input.linkedId,
        },
      },
    });
    if (existing) throw new CampaignError("duplicate_link", "Fragment is already linked to this campaign");
    const stageKey = input.stageKey ?? defaultStageFor(input.linkedType);
    const link = await tx.campaignLink.create({
      data: {
        campaignId,
        linkedType: input.linkedType,
        linkedId: input.linkedId,
        role: input.role ?? "primary",
        linkSource: input.linkSource ?? "human",
        platformRef: input.platformRef ? toJson(input.platformRef) : undefined,
        linkedBy: input.linkedBy ?? null,
      },
    });
    const stages = stageWithRef(normalizeStages(campaign.stages), stageKey, {
      linkedType: input.linkedType,
      linkedId: input.linkedId,
    });
    await tx.growthCampaign.update({ where: { id: campaignId, workspaceId }, data: { stages: toJson(stages) } });
    const budgetRollupCents = await recomputeBudgetRollup(tx, workspaceId, campaignId);
    return { link, budgetRollupCents };
  });
}

/** Surgical unlink — removes the row and its stage refs; the fragment row is untouched. */
export async function detachLink(workspaceId: string, campaignId: string, linkId: string) {
  return withCampaignScope(workspaceId, async (tx) => {
    const link = await tx.campaignLink.findFirst({
      where: { id: linkId, campaignId, campaign: { workspaceId } },
      include: { campaign: { select: { id: true, workspaceId: true, stages: true } } },
    });
    if (!link || link.campaign.workspaceId !== workspaceId || link.campaign.id !== campaignId) {
      throw new CampaignError("not_found", "Link not found");
    }
    await tx.campaignLink.delete({ where: { id: linkId } });
    const stages = stageWithoutRef(normalizeStages(link.campaign.stages), link.linkedType, link.linkedId);
    await tx.growthCampaign.update({ where: { id: campaignId, workspaceId }, data: { stages: toJson(stages) } });
    const budgetRollupCents = await recomputeBudgetRollup(tx, workspaceId, campaignId);
    return { detached: linkId, budgetRollupCents };
  });
}

/** Move a link's stage ref (stage pipeline stays truthful as work shifts). */
export async function updateLinkStage(
  workspaceId: string,
  campaignId: string,
  linkId: string,
  input: { stageKey: CampaignStageKey },
) {
  return withCampaignScope(workspaceId, async (tx) => {
    const link = await tx.campaignLink.findFirst({
      where: { id: linkId, campaignId, campaign: { workspaceId } },
      include: { campaign: { select: { id: true, workspaceId: true, stages: true } } },
    });
    if (!link || link.campaign.workspaceId !== workspaceId || link.campaign.id !== campaignId) {
      throw new CampaignError("not_found", "Link not found");
    }
    const ref = { linkedType: link.linkedType as CampaignLinkedType, linkedId: link.linkedId };
    let stages = stageWithoutRef(normalizeStages(link.campaign.stages), ref.linkedType, ref.linkedId);
    stages = stageWithRef(stages, input.stageKey, ref);
    await tx.growthCampaign.update({ where: { id: campaignId, workspaceId }, data: { stages: toJson(stages) } });
    return { linkId, stageKey: input.stageKey };
  });
}

// ---------------------------------------------------------------------------
// Backfill proposer (link-not-replace; precision over recall)
// ---------------------------------------------------------------------------

const PROPOSE_CONFIDENCE_FLOOR = 0.6;

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return normalizeName(s).split(" ").filter(Boolean);
}

/** Token-set Jaccard with containment credit — conservative by design. */
function nameSimilarity(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  const jaccard = union === 0 ? 0 : inter / union;
  // Full containment of the shorter token set in the longer is a strong
  // signal (e.g. "holiday launch 2026" ⊆ "holiday launch 2026 email wave 1")
  // but only when the campaign name contributes most of its tokens.
  const shorter = Math.min(ta.size, tb.size);
  const containment = inter / shorter;
  const campaignCoverage = inter / ta.size; // campaign = `a`
  if (containment >= 0.999 && campaignCoverage >= 0.75 && shorter >= 2) return 0.95;
  return jaccard;
}

function slugify(s: string): string {
  return normalizeName(s).replace(/\s+/g, "-");
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 86_400_000;
}

/**
 * Score one (campaign, fragment) pair. Returns null when there is no
 * proposable evidence. Date proximity alone is never enough to propose —
 * it only boosts a name/utm/creative match.
 */
function scorePair(
  campaignName: string,
  campaignCreatedAt: Date,
  fragment: { displayName: string; createdAt: Date; utmCampaign: string | null; linkedType: CampaignLinkedType; linkedId: string },
  creativeLinks: Set<string>,
): { signals: MatchSignal[]; confidence: number } | null {
  const signals: MatchSignal[] = [];
  const sim = nameSimilarity(campaignName, fragment.displayName);
  if (sim >= 0.9) {
    signals.push({ signal: "name_similarity", detail: `name "${fragment.displayName}" ≈ campaign (sim ${sim.toFixed(2)})`, score: 0.9 });
  } else if (sim >= 0.75) {
    signals.push({ signal: "name_similarity", detail: `name "${fragment.displayName}" ~ campaign (sim ${sim.toFixed(2)})`, score: 0.7 });
  }
  if (fragment.utmCampaign) {
    const u = normalizeName(fragment.utmCampaign).replace(/\s+/g, "-");
    const c = slugify(campaignName);
    if (u === c || u === normalizeName(campaignName).replace(/\s+/g, "_")) {
      signals.push({ signal: "utm_campaign", detail: `utm_campaign "${fragment.utmCampaign}" matches campaign slug`, score: 1.0 });
    }
  }
  if (creativeLinks.has(`${fragment.linkedType}:${fragment.linkedId}`)) {
    signals.push({ signal: "shared_creative", detail: "fragment referenced by an already-linked recycling brief", score: 0.8 });
  }
  if (signals.length === 0) return null;
  const dateDays = daysBetween(campaignCreatedAt, fragment.createdAt);
  if (dateDays <= 21) {
    const dateScore = Math.max(0.3, 1 - dateDays / 30);
    signals.push({ signal: "date_proximity", detail: `fragment created ${dateDays.toFixed(0)}d from campaign`, score: dateScore });
  }
  // Confidence: strongest signal dominates, secondary signals add a little.
  const ranked = [...signals].sort((x, y) => y.score - x.score);
  let confidence = ranked[0].score;
  for (const s of ranked.slice(1)) confidence = Math.min(0.98, confidence + s.score * 0.1);
  if (confidence < PROPOSE_CONFIDENCE_FLOOR) return null;
  return { signals, confidence: Math.round(confidence * 100) / 100 };
}

/**
 * Scan a workspace's fragment tables and propose links to growth campaigns.
 * Writes campaign_link_proposals rows (status=pending) — NEVER campaign_links.
 * Returns the proposals created this run.
 */
export async function proposeBackfillLinks(workspaceId: string, opts?: { campaignId?: string }) {
  return withCampaignScope(workspaceId, async (tx) => {
    const campaigns = await tx.growthCampaign.findMany({
      where: { workspaceId, ...(opts?.campaignId ? { id: opts.campaignId } : {}) },
      include: { links: { select: { linkedType: true, linkedId: true } } },
    });
    if (campaigns.length === 0) return { scannedFragments: 0, proposalsCreated: 0, proposals: [] as string[] };

    const fragments = await scanWorkspaceFragments(tx, workspaceId);

    // Fragments already linked anywhere, or with a pending/decided proposal
    // for this campaign, are never re-proposed.
    const linkedKeys = new Set<string>();
    const proposalKeys = new Set<string>();
    for (const c of campaigns) for (const l of c.links) linkedKeys.add(`${l.linkedType}:${l.linkedId}`);
    const existingProposals = await tx.campaignLinkProposal.findMany({
      where: { workspaceId },
      select: { campaignId: true, linkedType: true, linkedId: true, status: true },
    });
    for (const p of existingProposals) proposalKeys.add(`${p.campaignId ?? ""}:${p.linkedType}:${p.linkedId}`);

    // Creative-sharing: briefs already linked to the campaign reference their
    // source fragments — those refs become shared_creative signals.
    const creativeLinkSets = new Map<string, Set<string>>();
    for (const c of campaigns) {
      const set = new Set<string>();
      const briefLinks = c.links.filter((l) => l.linkedType === "recycling_brief");
      for (const bl of briefLinks) {
        const brief = await tx.recyclingBrief.findFirst({ where: { id: bl.linkedId, workspaceId }, select: { sourceAssetId: true } });
        if (brief?.sourceAssetId) set.add(brief.sourceAssetId);
      }
      creativeLinkSets.set(c.id, set);
    }

    const created: string[] = [];
    let scanned = 0;
    for (const fragment of fragments) {
      const key = `${fragment.linkedType}:${fragment.linkedId}`;
      if (linkedKeys.has(key)) continue;
      scanned += 1;
      for (const campaign of campaigns) {
        if (proposalKeys.has(`${campaign.id}:${key}`)) continue;
        const scored = scorePair(
          campaign.name,
          campaign.createdAt,
          { displayName: fragment.displayName, createdAt: fragment.createdAt, utmCampaign: fragment.utmCampaign, linkedType: fragment.linkedType, linkedId: fragment.linkedId },
          creativeLinkSets.get(campaign.id) ?? new Set(),
        );
        if (!scored) continue;
        const row = await tx.campaignLinkProposal.create({
          data: {
            workspaceId,
            campaignId: campaign.id,
            linkedType: fragment.linkedType,
            linkedId: fragment.linkedId,
            matchSignals: toJson(scored.signals),
            confidence: scored.confidence,
            status: "pending",
          },
        });
        created.push(row.id);
        proposalKeys.add(`${campaign.id}:${key}`);
      }
    }
    return { scannedFragments: scanned, proposalsCreated: created.length, proposals: created };
  });
}

export async function listProposals(workspaceId: string, opts?: { status?: LinkProposalStatus; campaignId?: string }) {
  return withCampaignScope(workspaceId, async (tx) => {
    return tx.campaignLinkProposal.findMany({
      where: {
        workspaceId,
        ...(opts?.status ? { status: opts.status } : {}),
        ...(opts?.campaignId ? { campaignId: opts.campaignId } : {}),
      },
      include: {
        campaign: { select: { id: true, name: true } },
      },
      orderBy: [{ confidence: "desc" }, { createdAt: "desc" }],
      take: 200,
    });
  });
}

/**
 * Resolve a proposal. Approval materializes a real link (with link_source
 * from the winning signal); rejection records the negative signal so the
 * proposer never re-proposes it.
 */
export async function resolveProposal(
  workspaceId: string,
  proposalId: string,
  decision: "approved" | "rejected",
  decidedBy?: string,
) {
  return withCampaignScope(workspaceId, async (tx) => {
    const proposal = await tx.campaignLinkProposal.findFirst({ where: { id: proposalId, workspaceId } });
    if (!proposal) throw new CampaignError("not_found", "Proposal not found");
    if (proposal.status !== "pending") {
      throw new CampaignError("proposal_not_pending", `Proposal is already ${proposal.status}`);
    }
    if (decision === "rejected") {
      return tx.campaignLinkProposal.update({
        where: { id: proposalId, workspaceId },
        data: { status: "rejected", decidedBy: decidedBy ?? null, decidedAt: new Date() },
      });
    }
    // approved
    if (!proposal.campaignId) throw new CampaignError("validation", "Proposal has no target campaign");
    const signals = (proposal.matchSignals ?? []) as unknown as MatchSignal[];
    const kinds = new Set<MatchSignalKind>(signals.map((s) => s.signal));
    const linkSource: CampaignLinkSource = kinds.has("utm_campaign")
      ? "utm"
      : kinds.has("name_similarity")
        ? "naming_convention"
        : "human";
    const campaign = await tx.growthCampaign.findFirst({ where: { id: proposal.campaignId, workspaceId } });
    if (!campaign) throw new CampaignError("not_found", "Target campaign not found");
    const fragment = await readFragment(tx, workspaceId, proposal.linkedType, proposal.linkedId);
    if (!fragment) throw new CampaignError("fragment_missing", "Fragment no longer exists in this workspace");
    const dupe = await tx.campaignLink.findUnique({
      where: {
        campaignId_linkedType_linkedId: {
          campaignId: proposal.campaignId,
          linkedType: proposal.linkedType,
          linkedId: proposal.linkedId,
        },
      },
    });
    let linkId: string;
    if (dupe) {
      linkId = dupe.id;
    } else {
      const link = await tx.campaignLink.create({
        data: {
          campaignId: proposal.campaignId,
          linkedType: proposal.linkedType,
          linkedId: proposal.linkedId,
          role: "primary",
          linkSource,
          linkedBy: decidedBy ?? null,
        },
      });
      linkId = link.id;
      const stages = stageWithRef(normalizeStages(campaign.stages), defaultStageFor(proposal.linkedType), {
        linkedType: proposal.linkedType,
        linkedId: proposal.linkedId,
      });
      await tx.growthCampaign.update({ where: { id: campaign.id, workspaceId }, data: { stages: toJson(stages) } });
      await recomputeBudgetRollup(tx, workspaceId, campaign.id);
    }
    const updated = await tx.campaignLinkProposal.update({
      where: { id: proposalId, workspaceId },
      data: { status: "approved", decidedBy: decidedBy ?? null, decidedAt: new Date() },
    });
    return { proposal: updated, linkId };
  });
}

// ---------------------------------------------------------------------------
// Roll-up report
// ---------------------------------------------------------------------------

export interface RollupFragmentReport {
  linkId: string;
  linkedType: CampaignLinkedType;
  linkedId: string;
  displayName: string;
  role: string;
  linkSource: string;
  linkedAt: string;
  /** Platform ref is opaque — passed through, never re-modeled. */
  platformRef: unknown;
  stageKeys: CampaignStageKey[];
  status: string | null;
  metrics: FragmentMetric[];
  provenance: {
    table: string;
    fragmentId: string;
    fetchedAt: string;
    notes: string[];
  };
}

export interface RollupTotal {
  key: string;
  value: number;
  /** Explicit semantics note — totals are NEVER silently summed. */
  semantics: string;
  provenance: Array<{ from: string; value: number }>;
}

export interface CampaignReport {
  campaign: { id: string; name: string; objective: string; status: string; budgetRollupCents: number };
  generatedAt: string;
  fragments: RollupFragmentReport[];
  /** Totals are computed only within a labeled metric family, with an
   * explicit mixed-semantics disclaimer. Families whose semantics differ
   * fundamentally (e.g. Meta "conversions" vs CRM "closed-won") are never
   * totaled — they stay per-fragment. */
  totals: RollupTotal[];
  warnings: string[];
}

const SUMMABLE_METRIC_KEYS = new Set(["spend_cents", "pieces", "sends", "opens", "clicks", "prospects", "impressions", "replies", "sequences"]);

export async function campaignReport(workspaceId: string, campaignId: string): Promise<CampaignReport> {
  return withCampaignScope(workspaceId, async (tx) => {
    const campaign = await tx.growthCampaign.findFirst({
      where: { id: campaignId, workspaceId },
      include: { links: { orderBy: { linkedAt: "asc" } } },
    });
    if (!campaign) throw new CampaignError("not_found", "Campaign not found");
    const stages = normalizeStages(campaign.stages);
    const stageOf = (t: CampaignLinkedType, id: string): CampaignStageKey[] =>
      stages.filter((s) => s.linkedRefs.some((r) => r.linkedType === t && r.linkedId === id)).map((s) => s.key);

    const fragments: RollupFragmentReport[] = [];
    const warnings: string[] = [];
    for (const link of campaign.links) {
      const f = await readFragment(tx, workspaceId, link.linkedType, link.linkedId);
      if (!f) {
        warnings.push(`Linked fragment ${link.linkedType}:${link.linkedId} is missing — link left intact, flagged for review`);
        continue;
      }
      fragments.push({
        linkId: link.id,
        linkedType: link.linkedType,
        linkedId: link.linkedId,
        displayName: f.displayName,
        role: link.role,
        linkSource: link.linkSource,
        linkedAt: link.linkedAt.toISOString(),
        platformRef: link.platformRef ?? null,
        stageKeys: stageOf(link.linkedType, link.linkedId),
        status: f.status,
        metrics: f.metrics,
        provenance: {
          table: f.provenance.table,
          fragmentId: f.provenance.fragmentId,
          fetchedAt: f.provenance.fetchedAt,
          notes: f.provenance.notes,
        },
      });
    }

    // Totals: per metric family, each constituent labeled, mixed-semantics
    // disclaimer attached. Nothing is summed across incompatible semantics.
    const totals: RollupTotal[] = [];
    const byKey = new Map<string, Array<{ from: string; value: number; label: string }>>();
    for (const fr of fragments) {
      for (const m of fr.metrics) {
        if (typeof m.value !== "number" || !SUMMABLE_METRIC_KEYS.has(m.key)) continue;
        const arr = byKey.get(m.key) ?? [];
        arr.push({ from: `${linkedTypeLabel(fr.linkedType)} · ${fr.displayName}`, value: m.value, label: m.label });
        byKey.set(m.key, arr);
      }
    }
    const semanticsNotes: Record<string, string> = {
      spend_cents:
        "SUM OF LABELED FRAGMENT VALUES — mixed accounting: direct-mail cost (actual or estimate), platform-reported media spend, CTV budget (not spend). Not reconciled against CRM revenue; see per-fragment provenance.",
      pieces: "Sum of direct-mail piece counts.",
      sends: "Sum of sends across email engines — newsletter (Resend) and outreach sends use different measurement; compare with care.",
      opens: "Sum of opens across engines — newsletter pixel opens and outreach pixel opens are measured differently.",
      clicks: "Sum of clicks across engines (newsletter, outreach, social) — different tracking, do not compare as one funnel.",
      prospects: "Sum of outreach prospect counts.",
      impressions: "Sum of Buffer-cached social impressions.",
      replies: "Sum of outreach replies.",
      sequences: "Sum of outreach sequence counts.",
    };
    for (const [key, parts] of byKey) {
      totals.push({
        key,
        value: parts.reduce((a, p) => a + p.value, 0),
        semantics: semanticsNotes[key] ?? `Sum of labeled fragment values for ${key}.`,
        provenance: parts.map((p) => ({ from: `${p.from} [${p.label}]`, value: p.value })),
      });
    }

    return {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        objective: campaign.objective,
        status: campaign.status,
        budgetRollupCents: campaign.budgetRollupCents,
      },
      generatedAt: new Date().toISOString(),
      fragments,
      totals,
      warnings,
    };
  });
}

/** Money-rule self-check: the G2 engine must never touch a spending path.
 * Documents the invariant where the code lives; the battery asserts it. */
export const G2_MONEY_INVARIANT =
  "Phase 8 G2 creates no approval, budget-pool, or execution objects. " +
  "budgetRollupCents is recomputed read-only reporting. Fragment tables are read-only. " +
  "All link materialization is human-confirmed (attach) or human-resolved (proposal).";
