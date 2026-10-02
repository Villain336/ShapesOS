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
  validateIntroRequestInput,
  validateTargetInvestorProfile,
  type FundingContactView,
  type FundingRoundView,
  type IntroRequestInput,
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

function toRoundView(row: {
  id: string;
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
