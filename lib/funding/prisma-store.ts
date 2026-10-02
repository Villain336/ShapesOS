// Marketr — Funding/VC slice 1: Prisma store.
// Boardy is inserted as the starter contact the FIRST time a tenant's
// funding graph is initialized — idempotent (upsert on the
// (workspaceId, starterKey) key), never duplicated on re-run.
// Intro-request guardrail scaffolding: field validation + one-per-pair
// (schema unique) + per-contact 24h rate limit. Full double-opt-in
// lifecycle lands in Connector slice 4.

import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { writeFile, FsError } from "@/lib/filesystem/service";
import { normalizeLogicalPath } from "@/lib/filesystem/paths";
import { safeFilename } from "@/lib/security/upload-safety";
import { BOARDY_STARTER_CONTACT, validateStarterSeed } from "./seeds";
import {
  assertNonEmptyUpload,
  DATA_ROOM_DOC_KINDS,
  generateShareToken,
  normalizeViewerEmails,
  planNewDocVersion,
  validateDocInput,
  validateShareLinkInput,
  type DataRoomDocKind,
  type FundingDataRoomDocView,
  type FundingDocVersionView,
  type FundingDocViewRow,
  type FundingShareLinkView,
  type ShareLinkCreateInput,
} from "./dataroom";
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

  // ------------------------------------------------------------------
  // Slice 3: Data room (versioned docs, share links, view analytics)
  // ------------------------------------------------------------------

  /**
   * Write one data-room file through the EXISTING filesystem pipeline —
   * the same writeFile the /api/files route uses, so upload safety, the
   * 25 MB cap, and quota all apply unchanged. Files land under
   * /files/funding/<kind>/ with a version-distinct filename, so an old
   * version's bytes can never be replaced in place.
   */
  private async writeDataRoomFile(opts: {
    workspaceId: string;
    userId: string;
    kind: DataRoomDocKind;
    versionNumber: number;
    fileName: string;
    fileBytes: Buffer;
    mimeType?: string;
  }) {
    const logicalPath = `/files/funding/${opts.kind}/v${opts.versionNumber}-${safeFilename(opts.fileName || "file")}`;
    const check = normalizeLogicalPath(logicalPath);
    if (!check.ok) throw new FundingError("INVALID_PATH", check.reason);
    if (!logicalPath.startsWith("/files/funding/")) {
      throw new FundingError(
        "INVALID_PATH",
        "Data-room files must live under /files/funding/.",
      );
    }
    return writeFile({
      workspaceId: opts.workspaceId,
      logicalPath,
      kind: check.kind,
      bytes: opts.fileBytes,
      mimeType: opts.mimeType,
      createdBy: opts.userId,
    });
  }

  /**
   * Create a document with its first version. The upload becomes version 1;
   * the file goes to /files/funding/<kind>/ and is registered on the
   * version row. `fileUrl`/`version` legacy fields are kept in sync for
   * readers that still use them.
   */
  async createDoc(
    workspaceId: string,
    userId: string,
    input: {
      title: string;
      kind: DataRoomDocKind;
      notes?: string | null;
      fileName: string;
      fileBytes: Buffer;
      mimeType?: string;
    },
  ): Promise<FundingDataRoomDocView> {
    const errors = validateDocInput(input);
    if (errors.length > 0) {
      throw new FundingError("INVALID_DOC", errors.join(" "));
    }
    assertNonEmptyUpload(input.fileBytes);

    const plan = planNewDocVersion(null);
    const file = await this.writeDataRoomFile({
      workspaceId,
      userId,
      kind: input.kind,
      versionNumber: plan.versionNumber,
      fileName: input.fileName,
      fileBytes: input.fileBytes,
      mimeType: input.mimeType,
    });

    const doc = await this.prisma.$transaction(async (tx) => {
      const created = await tx.fundingDataRoomDoc.create({
        data: {
          workspaceId,
          title: input.title.trim(),
          kind: input.kind,
          notes: input.notes?.trim() || null,
        },
      });
      const version = await tx.fundingDataRoomDocVersion.create({
        data: {
          workspaceId,
          documentId: created.id,
          versionNumber: plan.versionNumber,
          workspaceFileId: file.id,
          fileName: file.filename || safeFilename(input.fileName || "file"),
          mimeType: file.mimeType ?? input.mimeType ?? null,
          sizeBytes: input.fileBytes.length,
          uploadedBy: userId,
        },
      });
      return tx.fundingDataRoomDoc.update({
        where: { id: created.id },
        data: {
          currentVersionId: version.id,
          // Legacy compat: keep the flat fields in sync.
          version: plan.versionNumber,
          fileUrl: file.logicalPath ?? null,
        },
      });
    });
    return this.getDoc(workspaceId, doc.id);
  }

  /**
   * Upload a new version of an existing document. NEVER mutates a published
   * version: it writes a new file and a new version row, then moves the
   * doc's currentVersion pointer forward.
   */
  async addDocVersion(
    workspaceId: string,
    userId: string,
    documentId: string,
    input: { fileName: string; fileBytes: Buffer; mimeType?: string },
  ): Promise<FundingDataRoomDocView> {
    assertNonEmptyUpload(input.fileBytes);
    const doc = await this.prisma.fundingDataRoomDoc.findFirst({
      where: { id: documentId, workspaceId },
      include: { currentVersion: true },
    });
    if (!doc) throw new FundingError("DOC_NOT_FOUND", "Document not found.");

    const plan = planNewDocVersion(
      doc.currentVersion
        ? {
            id: doc.currentVersion.id,
            versionNumber: doc.currentVersion.versionNumber,
          }
        : null,
    );
    const file = await this.writeDataRoomFile({
      workspaceId,
      userId,
      kind: doc.kind as DataRoomDocKind,
      versionNumber: plan.versionNumber,
      fileName: input.fileName,
      fileBytes: input.fileBytes,
      mimeType: input.mimeType,
    });

    await this.prisma.$transaction(async (tx) => {
      const version = await tx.fundingDataRoomDocVersion.create({
        data: {
          workspaceId,
          documentId: doc.id,
          versionNumber: plan.versionNumber,
          workspaceFileId: file.id,
          fileName: file.filename || safeFilename(input.fileName || "file"),
          mimeType: file.mimeType ?? input.mimeType ?? null,
          sizeBytes: input.fileBytes.length,
          uploadedBy: userId,
          supersedesVersionId: plan.supersedesVersionId,
        },
      });
      await tx.fundingDataRoomDoc.update({
        where: { id: doc.id },
        data: {
          currentVersionId: version.id,
          version: plan.versionNumber,
          fileUrl: file.logicalPath ?? null,
        },
      });
    });
    return this.getDoc(workspaceId, doc.id);
  }

  /** One doc with its current version + counts (404 if not found). */
  async getDoc(
    workspaceId: string,
    docId: string,
  ): Promise<FundingDataRoomDocView> {
    const doc = await this.prisma.fundingDataRoomDoc.findFirst({
      where: { id: docId, workspaceId },
      include: {
        currentVersion: { include: { _count: { select: { views: true } } } },
        _count: {
          select: { versions: true, shareLinks: true },
        },
      },
    });
    if (!doc) throw new FundingError("DOC_NOT_FOUND", "Document not found.");
    // Total views across all versions (room + doc links land on versions).
    const totalViews = await this.prisma.fundingDocView.count({
      where: {
        workspaceId,
        docVersion: { documentId: doc.id },
      },
    });
    return toDataRoomDocView(doc, totalViews);
  }

  /** The tenant's data-room docs, newest first. */
  async listDocs(workspaceId: string): Promise<FundingDataRoomDocView[]> {
    const docs = await this.prisma.fundingDataRoomDoc.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: "desc" },
      include: {
        currentVersion: { include: { _count: { select: { views: true } } } },
        _count: { select: { versions: true, shareLinks: true } },
      },
    });
    const docIds = docs.map((d) => d.id);
    const viewCounts = await this.prisma.fundingDocView.groupBy({
      by: ["docVersionId"],
      where: { workspaceId, docVersion: { documentId: { in: docIds } } },
      _count: { _all: true },
    });
    const byVersion = new Map<string, number>();
    const versionToDoc = new Map<string, string>();
    const versionRows = await this.prisma.fundingDataRoomDocVersion.findMany({
      where: { workspaceId, documentId: { in: docIds } },
      select: { id: true, documentId: true },
    });
    for (const v of versionRows) versionToDoc.set(v.id, v.documentId);
    for (const g of viewCounts) {
      if (!g.docVersionId) continue;
      const docId = versionToDoc.get(g.docVersionId);
      if (!docId) continue;
      byVersion.set(docId, (byVersion.get(docId) ?? 0) + g._count._all);
    }
    return docs.map((d) => toDataRoomDocView(d, byVersion.get(d.id) ?? 0));
  }

  /** Full detail: versions (newest first), share links, recent views. */
  async getDocDetail(
    workspaceId: string,
    docId: string,
  ): Promise<
    FundingDataRoomDocView & {
      versions: FundingDocVersionView[];
      shareLinks: FundingShareLinkView[];
      views: FundingDocViewRow[];
    }
  > {
    const doc = await this.prisma.fundingDataRoomDoc.findFirst({
      where: { id: docId, workspaceId },
      include: {
        versions: {
          orderBy: { versionNumber: "desc" },
          include: { _count: { select: { views: true } } },
        },
        shareLinks: {
          orderBy: { createdAt: "desc" },
          include: {
            doc: { select: { title: true } },
            docVersion: { select: { versionNumber: true } },
            _count: { select: { views: true } },
          },
        },
      },
    });
    if (!doc) throw new FundingError("DOC_NOT_FOUND", "Document not found.");
    const base = await this.getDoc(workspaceId, docId);
    const views = await this.listViews(workspaceId, { docId, limit: 100 });
    return {
      ...base,
      versions: doc.versions.map((v) =>
        toDocVersionView(v, v.id === doc.currentVersionId),
      ),
      shareLinks: doc.shareLinks.map((l) => toShareLinkView(l)),
      views,
    };
  }

  /**
   * Delete a document and everything under it (versions, share links,
   * views — schema cascades). File cleanup is owned by the files trash
   * flow, matching the Legal vault convention.
   */
  async deleteDoc(workspaceId: string, docId: string): Promise<void> {
    const result = await this.prisma.fundingDataRoomDoc.deleteMany({
      where: { id: docId, workspaceId },
    });
    if (result.count === 0) {
      throw new FundingError("DOC_NOT_FOUND", "Document not found.");
    }
  }

  /**
   * Create a share link: one doc (pinned version or current at access time)
   * or the whole room (docId = null). Expiry/allowlist validation is pure;
   * the token is unguessable and regenerated on collision.
   */
  async createShareLink(
    workspaceId: string,
    input: ShareLinkCreateInput,
    now = new Date(),
  ): Promise<FundingShareLinkView> {
    const errors = validateShareLinkInput(input, now);
    if (errors.length > 0) {
      throw new FundingError("INVALID_SHARE_LINK", errors.join(" "));
    }
    if (input.docId) {
      const doc = await this.prisma.fundingDataRoomDoc.findFirst({
        where: { id: input.docId, workspaceId },
        select: { id: true, currentVersionId: true },
      });
      if (!doc) throw new FundingError("DOC_NOT_FOUND", "Document not found.");
      if (input.docVersionId) {
        const version = await this.prisma.fundingDataRoomDocVersion.findFirst({
          where: {
            id: input.docVersionId,
            documentId: doc.id,
            workspaceId,
          },
          select: { id: true },
        });
        if (!version) {
          throw new FundingError(
            "VERSION_NOT_FOUND",
            "That version does not belong to this document.",
          );
        }
      }
    }
    const viewerEmails = normalizeViewerEmails(input.viewerEmails ?? []);
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;

    // Retry on the astronomically-unlikely token collision.
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const created = await this.prisma.fundingShareLink.create({
          data: {
            workspaceId,
            docId: input.docId,
            docVersionId: input.docVersionId,
            token: generateShareToken(),
            expiresAt,
            viewerEmails,
          },
          include: {
            doc: { select: { title: true } },
            docVersion: { select: { versionNumber: true } },
            _count: { select: { views: true } },
          },
        });
        return toShareLinkView(created);
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === "P2002"
        ) {
          lastError = e;
          continue;
        }
        throw e;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new FundingError("TOKEN_COLLISION", "Could not mint a share token.");
  }

  /** The tenant's share links, newest first (tokens included for display). */
  async listShareLinks(workspaceId: string): Promise<FundingShareLinkView[]> {
    const links = await this.prisma.fundingShareLink.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      include: {
        doc: { select: { title: true } },
        docVersion: { select: { versionNumber: true } },
        _count: { select: { views: true } },
      },
    });
    return links.map((l) => toShareLinkView(l));
  }

  /** Revoke a share link. Revoked links 404 at the public route. */
  async revokeShareLink(
    workspaceId: string,
    linkId: string,
    now = new Date(),
  ): Promise<FundingShareLinkView> {
    const link = await this.prisma.fundingShareLink.findFirst({
      where: { id: linkId, workspaceId },
      include: {
        doc: { select: { title: true } },
        docVersion: { select: { versionNumber: true } },
        _count: { select: { views: true } },
      },
    });
    if (!link) {
      throw new FundingError("LINK_NOT_FOUND", "Share link not found.");
    }
    if (link.revoked) return toShareLinkView(link);
    const updated = await this.prisma.fundingShareLink.update({
      where: { id: link.id },
      data: { revoked: true, revokedAt: now },
      include: {
        doc: { select: { title: true } },
        docVersion: { select: { versionNumber: true } },
        _count: { select: { views: true } },
      },
    });
    return toShareLinkView(updated);
  }

  /**
   * Public-route lookup by token. Returns the link with enough to serve:
   * the resolved version (pinned, or current at access time) for doc
   * links. Whole-room links resolve the version from the request's `v`
   * param (validated separately by the route).
   */
  async getShareLinkByToken(token: string, now = new Date()) {
    const link = await this.prisma.fundingShareLink.findUnique({
      where: { token },
      include: {
        doc: {
          select: { id: true, title: true, currentVersionId: true },
        },
        docVersion: {
          select: {
            id: true,
            documentId: true,
            versionNumber: true,
            workspaceFileId: true,
            fileName: true,
            mimeType: true,
            sizeBytes: true,
          },
        },
      },
    });
    if (!link) return null;
    let resolvedVersion = link.docVersion;
    if (!resolvedVersion && link.doc?.currentVersionId) {
      resolvedVersion = await this.prisma.fundingDataRoomDocVersion.findFirst({
        where: {
          id: link.doc.currentVersionId,
          workspaceId: link.workspaceId,
        },
        select: {
          id: true,
          documentId: true,
          versionNumber: true,
          workspaceFileId: true,
          fileName: true,
          mimeType: true,
          sizeBytes: true,
        },
      });
    }
    return {
      id: link.id,
      workspaceId: link.workspaceId,
      docId: link.docId,
      docTitle: link.doc?.title ?? null,
      docVersionId: link.docVersionId,
      revoked: link.revoked,
      expiresAt: link.expiresAt,
      viewerEmails: link.viewerEmails,
      resolvedVersion,
      now,
    };
  }

  /**
   * Resolve a specific version for a whole-room link request, tenant-scoped.
   * Returns null when the version does not belong to this link's workspace.
   */
  async getRoomVersion(workspaceId: string, versionId: string) {
    return this.prisma.fundingDataRoomDocVersion.findFirst({
      where: { id: versionId, workspaceId },
      select: {
        id: true,
        documentId: true,
        versionNumber: true,
        workspaceFileId: true,
        fileName: true,
        mimeType: true,
        sizeBytes: true,
        document: { select: { title: true } },
      },
    });
  }

  /**
   * Log one view BEFORE serving the file — the route calls this, then
   * streams the bytes. This is the "who opened what, when" record.
   */
  async recordDocView(
    workspaceId: string,
    input: {
      linkId: string;
      docVersionId?: string | null;
      viewerIdentity: string;
      userAgent?: string | null;
    },
  ): Promise<{ id: string }> {
    const created = await this.prisma.fundingDocView.create({
      data: {
        workspaceId,
        linkId: input.linkId,
        docVersionId: input.docVersionId ?? null,
        viewerIdentity: input.viewerIdentity,
        userAgent: input.userAgent ?? null,
      },
      select: { id: true },
    });
    return created;
  }

  /** Optional duration beacon: how long the viewer kept the doc open. */
  async updateViewDuration(
    workspaceId: string,
    viewId: string,
    durationMs: number,
  ): Promise<void> {
    if (!Number.isInteger(durationMs) || durationMs < 0) {
      throw new FundingError(
        "INVALID_DURATION",
        "durationMs must be a non-negative integer.",
      );
    }
    const result = await this.prisma.fundingDocView.updateMany({
      where: { id: viewId, workspaceId },
      data: { durationMs },
    });
    if (result.count === 0) {
      throw new FundingError("VIEW_NOT_FOUND", "View not found.");
    }
  }

  /**
   * Analytics read (spec §3: "who opened what, when"). Newest first.
   * Filter by doc or link; tenant-scoped on every path.
   */
  async listViews(
    workspaceId: string,
    opts: { docId?: string; linkId?: string; limit?: number } = {},
  ): Promise<FundingDocViewRow[]> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const rows = await this.prisma.fundingDocView.findMany({
      where: {
        workspaceId,
        ...(opts.linkId ? { linkId: opts.linkId } : {}),
        ...(opts.docId ? { docVersion: { documentId: opts.docId } } : {}),
      },
      orderBy: { openedAt: "desc" },
      take: limit,
      include: {
        link: { select: { docId: true } },
        docVersion: {
          select: {
            versionNumber: true,
            document: { select: { id: true, title: true } },
          },
        },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      linkId: r.linkId,
      docId: r.docVersion?.document.id ?? r.link.docId,
      docTitle: r.docVersion?.document.title ?? null,
      docVersionNumber: r.docVersion?.versionNumber ?? null,
      viewerIdentity: r.viewerIdentity,
      userAgent: r.userAgent,
      durationMs: r.durationMs,
      openedAt: r.openedAt,
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

// ------------------------------------------------------------------
// Slice 3: data-room view mappers.
// ------------------------------------------------------------------

function toDataRoomDocView(
  row: {
    id: string;
    title: string;
    kind: string;
    notes: string | null;
    createdAt: Date;
    currentVersion: {
      id: string;
      versionNumber: number;
      fileName: string;
      mimeType: string | null;
      sizeBytes: number;
      uploadedBy: string;
      uploadedAt: Date;
      supersedesVersionId: string | null;
      _count: { views: number };
    } | null;
    _count: { versions: number; shareLinks: number };
  },
  totalViewCount: number,
): FundingDataRoomDocView {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind as DataRoomDocKind,
    notes: row.notes,
    currentVersion: row.currentVersion
      ? toDocVersionView(row.currentVersion, true)
      : null,
    versionCount: row._count.versions,
    shareLinkCount: row._count.shareLinks,
    viewCount: totalViewCount,
    createdAt: row.createdAt,
  };
}

function toDocVersionView(
  row: {
    id: string;
    versionNumber: number;
    fileName: string;
    mimeType: string | null;
    sizeBytes: number;
    uploadedBy: string;
    uploadedAt: Date;
    supersedesVersionId: string | null;
    _count: { views: number };
  },
  isCurrent: boolean,
): FundingDocVersionView {
  return {
    id: row.id,
    versionNumber: row.versionNumber,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    uploadedBy: row.uploadedBy,
    uploadedAt: row.uploadedAt,
    isCurrent,
    supersedesVersionId: row.supersedesVersionId,
    viewCount: row._count.views,
  };
}

function toShareLinkView(
  row: {
    id: string;
    docId: string | null;
    docVersionId: string | null;
    token: string;
    expiresAt: Date | null;
    viewerEmails: string[];
    revoked: boolean;
    createdAt: Date;
    doc: { title: string } | null;
    docVersion: { versionNumber: number } | null;
    _count: { views: number };
  },
  now = new Date(),
): FundingShareLinkView {
  return {
    id: row.id,
    docId: row.docId,
    docTitle: row.doc?.title ?? null,
    docVersionId: row.docVersionId,
    pinnedVersionNumber: row.docVersion?.versionNumber ?? null,
    urlPath: `/r/funding/${row.token}`,
    expiresAt: row.expiresAt,
    expired: !!row.expiresAt && row.expiresAt.getTime() <= now.getTime(),
    viewerEmails: row.viewerEmails,
    revoked: row.revoked,
    viewCount: row._count.views,
    createdAt: row.createdAt,
  };
}
