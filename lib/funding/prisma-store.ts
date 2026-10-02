// Marketr — Funding/VC slice 1: Prisma store.
// Boardy is inserted as the starter contact the FIRST time a tenant's
// funding graph is initialized — idempotent (upsert on the
// (workspaceId, starterKey) key), never duplicated on re-run.
// Intro-request guardrail scaffolding: field validation + one-per-pair
// (schema unique) + per-contact 24h rate limit. Full double-opt-in
// lifecycle lands in Connector slice 4.

import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { BOARDY_STARTER_CONTACT, validateStarterSeed } from "./seeds";
import {
  BOARDY_STARTER_KEY,
  FundingError,
  MAX_INTRO_REQUESTS_PER_CONTACT_PER_24H,
  STAGE_TRANSITIONS,
  isLegalStageTransition,
  validateFollowUpInput,
  validateInteractionInput,
  validateIntroRequestInput,
  validateInvestorEnrichment,
  validateTargetInvestorProfile,
  type FollowUpInput,
  type FundingContactView,
  type FundingFollowUpView,
  type FundingInteractionView,
  type FundingInvestorView,
  type FundingRoundView,
  type InteractionInput,
  type IntroRequestInput,
  type InvestorEnrichmentInput,
  type InvestorStage,
  type TargetInvestorProfileInput,
} from "./types";

export class PrismaFundingStore {
  constructor(private prisma: PrismaClient) {}

  /**
   * Idempotent starter seeding: inserts Boardy as the tenant's starter
   * contact on first call, returns the existing row on re-runs.
   * The seed itself is validated first — a corrupted seed never writes.
   */
  async ensureStarterContact(workspaceId: string): Promise<{
    contact: FundingContactView;
    created: boolean;
  }> {
    const seedErrors = validateStarterSeed();
    if (seedErrors.length > 0) {
      throw new FundingError(
        "invalid_starter_seed",
        `Starter seed invalid: ${seedErrors.join(" ")}`,
      );
    }
    const existing = await this.prisma.fundingContact.findUnique({
      where: {
        workspaceId_starterKey: {
          workspaceId,
          starterKey: BOARDY_STARTER_KEY,
        },
      },
    });
    if (existing) {
      return { contact: toContactView(existing), created: false };
    }
    const created = await this.prisma.fundingContact.create({
      data: {
        workspaceId,
        name: BOARDY_STARTER_CONTACT.name,
        role: BOARDY_STARTER_CONTACT.role,
        handle: BOARDY_STARTER_CONTACT.handle,
        note: BOARDY_STARTER_CONTACT.note,
        source: BOARDY_STARTER_CONTACT.source,
        isStarterContact: true,
        starterKey: BOARDY_STARTER_CONTACT.starterKey,
      },
    });
    return { contact: toContactView(created), created: true };
  }

  /** The tenant's funding graph: starter contact first, then by creation. */
  async listContacts(workspaceId: string): Promise<FundingContactView[]> {
    const rows = await this.prisma.fundingContact.findMany({
      where: { workspaceId },
      orderBy: [{ isStarterContact: "desc" }, { createdAt: "asc" }],
    });
    return rows.map(toContactView);
  }

  async getActiveRound(workspaceId: string): Promise<FundingRoundView | null> {
    const row = await this.prisma.fundingRound.findFirst({
      where: { workspaceId, isActive: true },
      orderBy: { updatedAt: "desc" },
    });
    return row ? toRoundView(row) : null;
  }

  /**
   * Save the founder's target investor profile. Creates the tenant's active
   * round (or updates it); any other active round is deactivated — exactly
   * one active round per tenant.
   */
  async upsertRound(
    workspaceId: string,
    input: TargetInvestorProfileInput,
  ): Promise<FundingRoundView> {
    const errors = validateTargetInvestorProfile(input);
    if (errors.length > 0) {
      throw new FundingError("invalid_round", errors.join(" "));
    }
    const data = {
      name: input.name?.trim() || "Raise",
      checkSizeMin: input.checkSizeMin ?? null,
      checkSizeMax: input.checkSizeMax ?? null,
      stages: (input.stages ?? []).map((s) => s.trim()).filter(Boolean),
      sectors: (input.sectors ?? []).map((s) => s.trim()).filter(Boolean),
      thesisSummary: input.thesisSummary?.trim() || null,
      targetClose: input.targetClose ? new Date(input.targetClose) : null,
    };
    return this.prisma.$transaction(async (tx) => {
      await tx.fundingRound.updateMany({
        where: { workspaceId, isActive: true },
        data: { isActive: false },
      });
      const existing = await tx.fundingRound.findFirst({
        where: { workspaceId },
        orderBy: { updatedAt: "desc" },
      });
      const row = existing
        ? await tx.fundingRound.update({
            where: { id: existing.id },
            data: { ...data, isActive: true, status: "active" },
          })
        : await tx.fundingRound.create({
            data: { ...data, workspaceId, isActive: true, status: "active" },
          });
      return toRoundView(row);
    });
  }

  async listIntroRequests(workspaceId: string) {
    return this.prisma.fundingIntroRequest.findMany({
      where: { workspaceId },
      include: { contact: true, investor: true },
      orderBy: { requestedAt: "desc" },
    });
  }

  /**
   * Create an intro request. Guardrails enforced here:
   * - context-required fields (reason, founderAsk) — no context, no intro;
   * - contact and investor must belong to this workspace (tenant scoping);
   * - one request per (contact, investor) pair (schema unique; a duplicate
   *   surfaces as a FundingError, never a second row);
   * - at most MAX_INTRO_REQUESTS_PER_CONTACT_PER_24H requests through one
   *   contact in any rolling 24h window.
   * No bulk creation path exists — single create only.
   */
  async createIntroRequest(
    workspaceId: string,
    input: IntroRequestInput,
  ): Promise<{ id: string; status: string }> {
    const errors = validateIntroRequestInput(input);
    if (errors.length > 0) {
      throw new FundingError("invalid_intro_request", errors.join(" "));
    }
    const contact = await this.prisma.fundingContact.findFirst({
      where: { id: input.contactId, workspaceId },
    });
    if (!contact) {
      throw new FundingError("contact_not_found", "Contact not found in this workspace.");
    }
    const investor = await this.prisma.fundingInvestor.findFirst({
      where: { id: input.investorId, workspaceId },
    });
    if (!investor) {
      throw new FundingError("investor_not_found", "Investor not found in this workspace.");
    }
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await this.prisma.fundingIntroRequest.count({
      where: {
        workspaceId,
        contactId: input.contactId,
        requestedAt: { gte: since },
      },
    });
    if (recent >= MAX_INTRO_REQUESTS_PER_CONTACT_PER_24H) {
      throw new FundingError(
        "rate_limited",
        `At most ${MAX_INTRO_REQUESTS_PER_CONTACT_PER_24H} intro requests per contact per 24 hours — Boardy's reputation is the asset.`,
      );
    }
    try {
      const row = await this.prisma.fundingIntroRequest.create({
        data: {
          workspaceId,
          contactId: input.contactId,
          investorId: input.investorId,
          reason: input.reason.trim(),
          founderAsk: input.founderAsk.trim(),
          fitNotes: input.fitNotes?.trim() || null,
        },
      });
      return { id: row.id, status: row.status };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
      ) {
        throw new FundingError(
          "duplicate_intro_request",
          "An intro request already exists for this contact and investor — one per pair, no duplicates.",
        );
      }
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // Slice 2 — Investor CRM.
  // ---------------------------------------------------------------------------

  /** Create an investor in the pipeline. v1 = manual entry. */
  async createInvestor(
    workspaceId: string,
    input: { name?: string; firm?: string | null; email?: string | null; source?: string | null },
  ): Promise<FundingInvestorView> {
    if (!input.name?.trim()) {
      throw new FundingError("invalid_investor", "name is required.");
    }
    if (input.email != null && input.email.trim() && !/^\S+@\S+\.\S+$/.test(input.email.trim())) {
      throw new FundingError("invalid_investor", "email must be a valid email address.");
    }
    const row = await this.prisma.fundingInvestor.create({
      data: {
        workspaceId,
        name: input.name.trim(),
        firm: input.firm?.trim() || null,
        email: input.email?.trim() || null,
        source: input.source?.trim() || null,
      },
    });
    return toInvestorView(row);
  }

  /** The tenant's pipeline investors, stage-grouped at the UI. */
  async listInvestors(workspaceId: string): Promise<FundingInvestorView[]> {
    const rows = await this.prisma.fundingInvestor.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: "asc" }],
    });
    return rows.map(toInvestorView);
  }

  /** Investor detail: profile + enrichment + interactions timeline + follow-ups. */
  async getInvestorDetail(
    workspaceId: string,
    investorId: string,
  ): Promise<{
    investor: FundingInvestorView;
    interactions: FundingInteractionView[];
    followUps: FundingFollowUpView[];
  }> {
    const row = await this.prisma.fundingInvestor.findFirst({
      where: { id: investorId, workspaceId },
    });
    if (!row) {
      throw new FundingError("investor_not_found", "Investor not found in this workspace.");
    }
    const [interactions, followUps] = await Promise.all([
      this.prisma.fundingInteraction.findMany({
        where: { workspaceId, investorId },
        include: { contact: { select: { name: true } } },
        orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
      }),
      this.prisma.fundingFollowUp.findMany({
        where: { workspaceId, investorId },
        include: { investor: { select: { name: true } } },
        orderBy: [{ done: "asc" }, { dueAt: "asc" }],
      }),
    ]);
    return {
      investor: toInvestorView(row),
      interactions: interactions.map(toInteractionView),
      followUps: followUps.map(toFollowUpView),
    };
  }

  /**
   * Update an investor's enrichment fields (v1 = manual/structured entry).
   * `enriched` provenance requires fetchedAt — provenance rule enforced here.
   */
  async updateInvestorEnrichment(
    workspaceId: string,
    investorId: string,
    input: InvestorEnrichmentInput,
  ): Promise<FundingInvestorView> {
    const errors = validateInvestorEnrichment(input);
    if (errors.length > 0) {
      throw new FundingError("invalid_enrichment", errors.join(" "));
    }
    const existing = await this.prisma.fundingInvestor.findFirst({
      where: { id: investorId, workspaceId },
    });
    if (!existing) {
      throw new FundingError("investor_not_found", "Investor not found in this workspace.");
    }
    const row = await this.prisma.fundingInvestor.update({
      where: { id: investorId },
      data: {
        firm: input.firm?.trim() || null,
        title: input.title?.trim() || null,
        email: input.email?.trim() || null,
        checkSizeMin: input.checkSizeMin ?? null,
        checkSizeMax: input.checkSizeMax ?? null,
        stages: (input.stages ?? []).map((s) => s.trim()).filter(Boolean),
        sectors: (input.sectors ?? []).map((s) => s.trim()).filter(Boolean),
        thesisFit: input.thesisFit?.trim() || null,
        enrichmentSource: input.enrichmentSource ?? "self_reported",
        enrichmentFetchedAt: input.enrichmentFetchedAt ? new Date(input.enrichmentFetchedAt) : null,
        enrichmentNotes: input.enrichmentNotes?.trim() || null,
      },
    });
    return toInvestorView(row);
  }

  /**
   * Move an investor to a new pipeline stage. Only legal transitions
   * (STAGE_TRANSITIONS) are allowed — illegal moves throw. Every move is
   * recorded as a FundingInteraction (kind stage_change) with the actor and
   * timestamp, so the pipeline always has lineage: who moved what, when.
   */
  async transitionStage(
    workspaceId: string,
    investorId: string,
    toStage: InvestorStage,
    actor: string,
  ): Promise<FundingInvestorView> {
    const investor = await this.prisma.fundingInvestor.findFirst({
      where: { id: investorId, workspaceId },
    });
    if (!investor) {
      throw new FundingError("investor_not_found", "Investor not found in this workspace.");
    }
    const fromStage = investor.stage as InvestorStage;
    if (fromStage === toStage) {
      return toInvestorView(investor);
    }
    if (!isLegalStageTransition(fromStage, toStage)) {
      const legal = STAGE_TRANSITIONS[fromStage] ?? [];
      throw new FundingError(
        "illegal_stage_transition",
        `Cannot move from ${fromStage} to ${toStage}. Legal moves from ${fromStage}: ${legal.join(", ") || "none — this stage is terminal"}.`,
      );
    }
    const actorName = actor.trim() || "founder";
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.fundingInvestor.update({
        where: { id: investorId },
        data: { stage: toStage },
      });
      await tx.fundingInteraction.create({
        data: {
          workspaceId,
          investorId,
          kind: "stage_change",
          summary: `Stage: ${fromStage} → ${toStage}`,
          actor: actorName,
        },
      });
      return updated;
    });
    return toInvestorView(row);
  }

  /**
   * Log an interaction (call, email, meeting, note, ...). The investor — and
   * the linked contact, if any — must belong to this workspace.
   * stage_change rows are written by transitionStage only, never here.
   */
  async logInteraction(
    workspaceId: string,
    investorId: string,
    input: InteractionInput,
    actor?: string,
  ): Promise<FundingInteractionView> {
    const errors = validateInteractionInput(input);
    if (errors.length > 0) {
      throw new FundingError("invalid_interaction", errors.join(" "));
    }
    const investor = await this.prisma.fundingInvestor.findFirst({
      where: { id: investorId, workspaceId },
    });
    if (!investor) {
      throw new FundingError("investor_not_found", "Investor not found in this workspace.");
    }
    let contactName: string | null = null;
    if (input.contactId) {
      const contact = await this.prisma.fundingContact.findFirst({
        where: { id: input.contactId, workspaceId },
        select: { id: true, name: true },
      });
      if (!contact) {
        throw new FundingError("contact_not_found", "Contact not found in this workspace.");
      }
      contactName = contact.name;
    }
    const row = await this.prisma.fundingInteraction.create({
      data: {
        workspaceId,
        investorId,
        kind: input.kind,
        summary: input.summary.trim(),
        occurredAt: input.occurredAt ? new Date(input.occurredAt) : undefined,
        actor: actor?.trim() || "founder",
        contactId: input.contactId ?? null,
      },
    });
    return toInteractionView({ ...row, contact: contactName ? { name: contactName } : null });
  }

  /** Create a follow-up reminder on an investor. */
  async createFollowUp(
    workspaceId: string,
    investorId: string,
    input: FollowUpInput,
  ): Promise<FundingFollowUpView> {
    const errors = validateFollowUpInput(input);
    if (errors.length > 0) {
      throw new FundingError("invalid_followup", errors.join(" "));
    }
    const investor = await this.prisma.fundingInvestor.findFirst({
      where: { id: investorId, workspaceId },
      select: { id: true, name: true },
    });
    if (!investor) {
      throw new FundingError("investor_not_found", "Investor not found in this workspace.");
    }
    const row = await this.prisma.fundingFollowUp.create({
      data: {
        workspaceId,
        investorId,
        dueAt: new Date(input.dueAt),
        note: input.note.trim(),
      },
      include: { investor: { select: { name: true } } },
    });
    return toFollowUpView(row);
  }

  /** Open (not done) follow-ups — used by the dashboard and the sweep. */
  async listOpenFollowUps(
    workspaceId: string,
  ): Promise<
    (FundingFollowUpView & { lastAlertedTier: string | null })[]
  > {
    const rows = await this.prisma.fundingFollowUp.findMany({
      where: { workspaceId, done: false },
      include: { investor: { select: { name: true } } },
      orderBy: { dueAt: "asc" },
    });
    return rows.map((r) => ({
      ...toFollowUpView(r),
      lastAlertedTier: r.lastAlertedTier,
    }));
  }

  /** Mark a follow-up done. */
  async completeFollowUp(
    workspaceId: string,
    followUpId: string,
  ): Promise<FundingFollowUpView> {
    const existing = await this.prisma.fundingFollowUp.findFirst({
      where: { id: followUpId, workspaceId },
    });
    if (!existing) {
      throw new FundingError("followup_not_found", "Follow-up not found in this workspace.");
    }
    const row = await this.prisma.fundingFollowUp.update({
      where: { id: followUpId },
      data: { done: true, doneAt: new Date() },
      include: { investor: { select: { name: true } } },
    });
    return toFollowUpView(row);
  }

  /** Record that the follow-up sweep alerted a tier (dedup). */
  async recordFollowUpAlertedTier(
    workspaceId: string,
    followUpId: string,
    tier: string,
  ): Promise<void> {
    await this.prisma.fundingFollowUp.updateMany({
      where: { id: followUpId, workspaceId },
      data: { lastAlertedTier: tier },
    });
  }

  /**
   * The tenant's pipeline: investors with their open (not done) follow-ups
   * attached, for the kanban board.
   */
  async listPipelineInvestors(
    workspaceId: string,
  ): Promise<(FundingInvestorView & { openFollowUps: FundingFollowUpView[] })[]> {
    const [investors, followUps] = await Promise.all([
      this.prisma.fundingInvestor.findMany({
        where: { workspaceId },
        orderBy: [{ createdAt: "asc" }],
      }),
      this.prisma.fundingFollowUp.findMany({
        where: { workspaceId, done: false },
        include: { investor: { select: { name: true } } },
        orderBy: { dueAt: "asc" },
      }),
    ]);
    const byInvestor = new Map<string, FundingFollowUpView[]>();
    for (const f of followUps) {
      const list = byInvestor.get(f.investorId) ?? [];
      list.push(toFollowUpView(f));
      byInvestor.set(f.investorId, list);
    }
    return investors.map((i) => ({
      ...toInvestorView(i),
      openFollowUps: byInvestor.get(i.id) ?? [],
    }));
  }
}

function toContactView(row: {
  id: string;
  name: string;
  role: string | null;
  handle: string | null;
  note: string | null;
  source: string;
  isStarterContact: boolean;
  createdAt: Date;
}): FundingContactView {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    handle: row.handle,
    note: row.note,
    source: row.source as FundingContactView["source"],
    isStarterContact: row.isStarterContact,
    createdAt: row.createdAt,
  };
}

function toRoundView(row: {  id: string;
  name: string;
  status: string;
  isActive: boolean;
  checkSizeMin: number | null;
  checkSizeMax: number | null;
  stages: string[];
  sectors: string[];
  thesisSummary: string | null;
  targetClose: Date | null;
}): FundingRoundView {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    isActive: row.isActive,
    checkSizeMin: row.checkSizeMin,
    checkSizeMax: row.checkSizeMax,
    stages: row.stages,
    sectors: row.sectors,
    thesisSummary: row.thesisSummary,
    targetClose: row.targetClose,
  };
}

function toInvestorView(row: {
  id: string;
  name: string;
  firm: string | null;
  title: string | null;
  email: string | null;
  checkSizeMin: number | null;
  checkSizeMax: number | null;
  stages: string[];
  sectors: string[];
  thesisFit: string | null;
  enrichmentSource: string;
  enrichmentFetchedAt: Date | null;
  enrichmentNotes: string | null;
  stage: string;
  source: string | null;
  createdAt: Date;
}): FundingInvestorView {
  return {
    id: row.id,
    name: row.name,
    firm: row.firm,
    title: row.title,
    email: row.email,
    checkSizeMin: row.checkSizeMin,
    checkSizeMax: row.checkSizeMax,
    stages: row.stages,
    sectors: row.sectors,
    thesisFit: row.thesisFit,
    enrichmentSource: row.enrichmentSource as FundingInvestorView["enrichmentSource"],
    enrichmentFetchedAt: row.enrichmentFetchedAt,
    enrichmentNotes: row.enrichmentNotes,
    stage: row.stage as FundingInvestorView["stage"],
    source: row.source,
    createdAt: row.createdAt,
  };
}

function toInteractionView(row: {
  id: string;
  occurredAt: Date;
  kind: string;
  summary: string;
  actor: string | null;
  contactId: string | null;
  createdAt: Date;
  contact: { name: string } | null;
}): FundingInteractionView {
  return {
    id: row.id,
    occurredAt: row.occurredAt,
    kind: row.kind as FundingInteractionView["kind"],
    summary: row.summary,
    actor: row.actor,
    contactId: row.contactId,
    contactName: row.contact?.name ?? null,
    createdAt: row.createdAt,
  };
}

function toFollowUpView(row: {
  id: string;
  investorId: string;
  dueAt: Date;
  note: string;
  done: boolean;
  doneAt: Date | null;
  createdAt: Date;
  investor: { name: string };
}): FundingFollowUpView {
  return {
    id: row.id,
    investorId: row.investorId,
    investorName: row.investor.name,
    dueAt: row.dueAt,
    note: row.note,
    done: row.done,
    doneAt: row.doneAt,
    createdAt: row.createdAt,
  };
}
