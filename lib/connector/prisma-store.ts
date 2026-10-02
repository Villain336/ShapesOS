// Marketr — Connector Agent slice 1: Prisma store.
// Tenant isolation is structural: every method takes workspaceId first and
// every query is scoped to it. A row id from another tenant passed with this
// tenant's workspaceId throws not_found — never a cross-tenant read.
// Warmth is recomputed from interaction signals via computeWarmth; no
// method hand-sets warmthScore (updateRelationship only writes notes +
// boundaries).

import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import {
  ConnectorError,
  computeWarmth,
  validateCompanyInput,
  validateEmploymentInput,
  validateExclusionInput,
  validateImportBatchInput,
  validatePersonInput,
  validateRelationshipPatch,
  validateSourceConsentInput,
  validateTouchInput,
  type CompanyInput,
  type ConnectorCompanySizeBand,
  type ConnectorCompanyRelationship,
  type ConnectorCompanyView,
  type ConnectorEmploymentView,
  type ConnectorExclusionType,
  type ConnectorExclusionView,
  type ConnectorGraphView,
  type ConnectorImportBatchStatus,
  type ConnectorImportBatchView,
  type ConnectorImportSource,
  type ConnectorImportStats,
  type ConnectorPersonView,
  type ConnectorRelationshipView,
  type ConnectorSourceConsentView,
  type EmploymentInput,
  type ExclusionInput,
  type ImportBatchInput,
  type PersonInput,
  type RelationshipPatchInput,
  type SourceConsentInput,
  type TouchDirection,
  type TouchInput,
  type WarmthBreakdown,
} from "./types";
import {
  INTRO_DEFAULT_MAX_PATHS,
  computeIntroPaths,
  getCachedIntroPaths,
  setCachedIntroPaths,
  type IntroPathResult,
  type PathCompanyInput,
  type PathPersonInput,
} from "./intro-paths";
import {
  DEFAULT_CONNECTOR_MODE,
  FUNDING_TARGET_RELATIONSHIPS,
  LEADS_TARGET_RELATIONSHIPS,
  companyRelationshipAllowedInMode,
  isConnectorMode,
  type ConnectorMode,
  type ConnectorSettingView,
  type FundingInvestorTargetView,
  type ModeTargetListView,
} from "./modes";
import {
  matchDirectoryProfiles,
  toDirectoryProfileView,
  validateDirectoryProfileInput,
  type DirectoryMatch,
  type DirectoryMatchCriteria,
  type DirectoryProfileInput,
  type DirectoryProfileRow,
  type DirectoryProfileView,
} from "./directory";
import type { InvestorStage } from "../funding/types";

type RelationshipRow = {
  id: string;
  personId: string;
  warmthScore: number;
  warmthComputedAt: Date | null;
  lastTouchAt: Date | null;
  touchCount: number;
  inboundCount: number;
  outboundCount: number;
  lastReciprocalTouchAt: Date | null;
  notes: string | null;
  boundaries: string | null;
  updatedAt: Date;
};

function toRelationshipView(row: RelationshipRow, now: Date): ConnectorRelationshipView {
  const warmthBreakdown: WarmthBreakdown = computeWarmth(
    {
      lastTouchAt: row.lastTouchAt,
      touchCount: row.touchCount,
      inboundCount: row.inboundCount,
      outboundCount: row.outboundCount,
    },
    now,
  );
  return {
    id: row.id,
    personId: row.personId,
    warmthScore: row.warmthScore,
    warmthComputedAt: row.warmthComputedAt,
    warmthBreakdown,
    lastTouchAt: row.lastTouchAt,
    touchCount: row.touchCount,
    inboundCount: row.inboundCount,
    outboundCount: row.outboundCount,
    lastReciprocalTouchAt: row.lastReciprocalTouchAt,
    notes: row.notes,
    boundaries: row.boundaries,
    updatedAt: row.updatedAt,
  };
}

export class PrismaConnectorStore {
  constructor(private prisma: PrismaClient) {}

  // ------------------------------------------------------------------
  // Import batches — consent is recorded here, before any Person row.
  // ------------------------------------------------------------------

  async createImportBatch(
    workspaceId: string,
    input: ImportBatchInput,
  ): Promise<ConnectorImportBatchView> {
    const { errors, value } = validateImportBatchInput(input);
    if (!value) {
      throw new ConnectorError("invalid_import_batch", errors.join(" "));
    }
    const row = await this.prisma.connectorImportBatch.create({
      data: {
        workspaceId,
        source: value.source,
        consentedBy: value.consentedBy,
        consentedAt: value.consentedAt,
        note: value.note,
      },
      include: { _count: { select: { persons: true } } },
    });
    return toBatchView(row);
  }

  async listImportBatches(workspaceId: string): Promise<ConnectorImportBatchView[]> {
    const rows = await this.prisma.connectorImportBatch.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { persons: true } } },
    });
    return rows.map(toBatchView);
  }

  // ------------------------------------------------------------------
  // Persons — provenance mandatory on every row.
  // ------------------------------------------------------------------

  async addPerson(
    workspaceId: string,
    input: PersonInput,
  ): Promise<ConnectorPersonView> {
    const { errors, value } = validatePersonInput(input);
    if (!value) {
      throw new ConnectorError("invalid_person", errors.join(" "));
    }
    if (value.importBatchId) {
      const batch = await this.prisma.connectorImportBatch.findFirst({
        where: { id: value.importBatchId, workspaceId },
        select: { id: true },
      });
      if (!batch) {
        throw new ConnectorError(
          "batch_not_found",
          "Import batch not found in this workspace.",
        );
      }
    }
    const row = await this.prisma.connectorPerson.create({
      data: {
        workspaceId,
        name: value.name,
        roles: value.roles,
        handles: value.handles,
        importBatchId: value.importBatchId,
        consentedBy: value.consentedBy,
        consentedAt: value.consentedAt,
        // Slice 2: provider dedup key (null for manual adds).
        externalId: value.externalId,
      },
    });
    const detail = await this.getPersonDetail(workspaceId, row.id);
    if (!detail) {
      throw new ConnectorError("person_not_found", "Person could not be read back.");
    }
    return detail;
  }

  async listPersons(workspaceId: string, now = new Date()): Promise<ConnectorPersonView[]> {
    const rows = await this.prisma.connectorPerson.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: "asc" }],
      include: {
        relationship: true,
        employments: { include: { company: true } },
        importBatch: { include: { _count: { select: { persons: true } } } },
      },
    });
    return rows.map((r) => toPersonView(r, now));
  }

  /**
   * Full detail, tenant-scoped. Returns null (never another tenant's row)
   * when the person does not belong to this workspace.
   */
  async getPersonDetail(
    workspaceId: string,
    personId: string,
    now = new Date(),
  ): Promise<ConnectorPersonView | null> {
    const row = await this.prisma.connectorPerson.findFirst({
      where: { id: personId, workspaceId },
      include: {
        relationship: true,
        employments: { include: { company: true } },
        importBatch: { include: { _count: { select: { persons: true } } } },
      },
    });
    return row ? toPersonView(row, now) : null;
  }

  /**
   * Same as getPersonDetail but throws — for mutation paths where a
   * missing row is an error, not an empty state.
   */
  private async requirePerson(workspaceId: string, personId: string) {
    const person = await this.prisma.connectorPerson.findFirst({
      where: { id: personId, workspaceId },
      select: { id: true },
    });
    if (!person) {
      throw new ConnectorError("person_not_found", "Person not found in this workspace.");
    }
    return person;
  }

  // ------------------------------------------------------------------
  // Companies + employment links.
  // ------------------------------------------------------------------

  async addCompany(
    workspaceId: string,
    input: CompanyInput,
  ): Promise<ConnectorCompanyView> {
    const { errors, value } = validateCompanyInput(input);
    if (!value) {
      throw new ConnectorError("invalid_company", errors.join(" "));
    }
    try {
      const row = await this.prisma.connectorCompany.create({
        data: {
          workspaceId,
          name: value.name,
          industry: value.industry,
          sizeBand: value.sizeBand,
          relationship: value.relationship,
        },
        include: { _count: { select: { employments: true } } },
      });
      return toCompanyView(row);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConnectorError(
          "duplicate_company",
          "A company with this name already exists in this workspace.",
        );
      }
      throw e;
    }
  }

  async listCompanies(workspaceId: string): Promise<ConnectorCompanyView[]> {
    const rows = await this.prisma.connectorCompany.findMany({
      where: { workspaceId },
      orderBy: [{ name: "asc" }],
      include: { _count: { select: { employments: true } } },
    });
    return rows.map(toCompanyView);
  }

  /**
   * Link a person to a company (employment history). Both nodes must belong
   * to this workspace; one row per (person, company).
   */
  async linkEmployment(
    workspaceId: string,
    input: EmploymentInput,
  ): Promise<ConnectorEmploymentView> {
    const { errors, value } = validateEmploymentInput(input);
    if (!value) {
      throw new ConnectorError("invalid_employment", errors.join(" "));
    }
    await this.requirePerson(workspaceId, value.personId);
    const company = await this.prisma.connectorCompany.findFirst({
      where: { id: value.companyId, workspaceId },
      select: { id: true },
    });
    if (!company) {
      throw new ConnectorError("company_not_found", "Company not found in this workspace.");
    }
    try {
      const row = await this.prisma.connectorEmployment.create({
        data: {
          workspaceId,
          personId: value.personId,
          companyId: value.companyId,
          title: value.title,
          startYear: value.startYear,
          endYear: value.endYear,
          isCurrent: value.isCurrent,
        },
        include: { company: true },
      });
      return toEmploymentView(row);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConnectorError(
          "duplicate_employment",
          "This person is already linked to this company.",
        );
      }
      throw e;
    }
  }

  // ------------------------------------------------------------------
  // Relationships — the tenant↔Person edge.
  // ------------------------------------------------------------------

  /**
   * Get or create the tenant's relationship edge to a person. The person
   * must belong to this workspace.
   */
  async ensureRelationship(
    workspaceId: string,
    personId: string,
    now = new Date(),
  ): Promise<ConnectorRelationshipView> {
    await this.requirePerson(workspaceId, personId);
    const row = await this.prisma.connectorRelationship.upsert({
      where: { personId },
      update: {},
      create: { workspaceId, personId },
    });
    return toRelationshipView(row, now);
  }

  /**
   * Update context notes / boundaries on a relationship. Warmth is NEVER
   * written here — it is recomputed from signals only.
   */
  async updateRelationship(
    workspaceId: string,
    personId: string,
    input: RelationshipPatchInput,
    now = new Date(),
  ): Promise<ConnectorRelationshipView> {
    const { errors, value } = validateRelationshipPatch(input);
    if (!value) {
      throw new ConnectorError("invalid_relationship", errors.join(" "));
    }
    await this.requirePerson(workspaceId, personId);
    const rel = await this.prisma.connectorRelationship.findUnique({
      where: { personId },
    });
    if (!rel || rel.workspaceId !== workspaceId) {
      throw new ConnectorError(
        "relationship_not_found",
        "Relationship not found in this workspace.",
      );
    }
    const updated = await this.prisma.connectorRelationship.update({
      where: { personId },
      data: { notes: value.notes, boundaries: value.boundaries },
    });
    return toRelationshipView(updated, now);
  }

  /**
   * Record one interaction touch with a person. Updates the interaction
   * signals and recomputes warmth from them in the same transaction.
   * inbound = they reached out (reciprocity signal); outbound = we did.
   */
  async recordTouch(
    workspaceId: string,
    input: TouchInput,
    now = new Date(),
  ): Promise<ConnectorRelationshipView> {
    const { errors, value } = validateTouchInput(input);
    if (!value) {
      throw new ConnectorError("invalid_touch", errors.join(" "));
    }
    return this.recordTouchValue(workspaceId, value.personId, value.direction, value.at, now);
  }

  async recordTouchValue(
    workspaceId: string,
    personId: string,
    direction: TouchDirection,
    at: Date,
    now = new Date(),
  ): Promise<ConnectorRelationshipView> {
    await this.requirePerson(workspaceId, personId);
    const row = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.connectorRelationship.findUnique({
        where: { personId },
      });
      if (existing && existing.workspaceId !== workspaceId) {
        throw new ConnectorError(
          "relationship_not_found",
          "Relationship not found in this workspace.",
        );
      }
      const prev = existing ?? {
        touchCount: 0,
        inboundCount: 0,
        outboundCount: 0,
        lastTouchAt: null as Date | null,
        lastReciprocalTouchAt: null as Date | null,
      };
      const touchCount = prev.touchCount + 1;
      const inboundCount = prev.inboundCount + (direction === "inbound" ? 1 : 0);
      const outboundCount = prev.outboundCount + (direction === "outbound" ? 1 : 0);
      const lastTouchAt =
        !prev.lastTouchAt || at.getTime() > prev.lastTouchAt.getTime() ? at : prev.lastTouchAt;
      const lastReciprocalTouchAt =
        direction === "inbound" &&
        (!prev.lastReciprocalTouchAt || at.getTime() > prev.lastReciprocalTouchAt.getTime())
          ? at
          : prev.lastReciprocalTouchAt;
      const { score } = computeWarmth(
        { lastTouchAt, touchCount, inboundCount, outboundCount },
        now,
      );
      const data = {
        touchCount,
        inboundCount,
        outboundCount,
        lastTouchAt,
        lastReciprocalTouchAt,
        warmthScore: score,
        warmthComputedAt: now,
      };
      return existing
        ? await tx.connectorRelationship.update({ where: { personId }, data })
        : await tx.connectorRelationship.create({
            data: { workspaceId, personId, ...data },
          });
    });
    return toRelationshipView(row, now);
  }

  /**
   * The warmth sweep: recompute every relationship's score in this tenant
   * from its stored interaction signals. Tenant-scoped — other tenants'
   * rows are never touched.
   */
  async recomputeAllWarmth(
    workspaceId: string,
    now = new Date(),
  ): Promise<{ recomputed: number; scores: Array<{ personId: string; score: number }> }> {
    const rows = await this.prisma.connectorRelationship.findMany({
      where: { workspaceId },
      select: {
        personId: true,
        lastTouchAt: true,
        touchCount: true,
        inboundCount: true,
        outboundCount: true,
      },
    });
    const scores = rows.map((r) => ({
      personId: r.personId,
      score: computeWarmth(
        {
          lastTouchAt: r.lastTouchAt,
          touchCount: r.touchCount,
          inboundCount: r.inboundCount,
          outboundCount: r.outboundCount,
        },
        now,
      ).score,
    }));
    await this.prisma.$transaction(
      scores.map((s) =>
        this.prisma.connectorRelationship.update({
          where: { personId: s.personId },
          data: { warmthScore: s.score, warmthComputedAt: now },
        }),
      ),
    );
    return { recomputed: scores.length, scores };
  }

  // ------------------------------------------------------------------
  // Graph read (the Network home payload).
  // ------------------------------------------------------------------

  async listGraph(workspaceId: string, now = new Date()): Promise<ConnectorGraphView> {
    const [persons, companies, batches] = await Promise.all([
      this.listPersons(workspaceId, now),
      this.listCompanies(workspaceId),
      this.listImportBatches(workspaceId),
    ]);
    return { persons, companies, batches };
  }

  // ------------------------------------------------------------------
  // Slice 5 — modes. Tenant-level preference (ConnectorSetting) +
  // mode-scoped target lists. FUNDING mode reads the Funding/VC
  // investor CRM directly (read-only; investor data is never duplicated
  // into connector rows).
  // ------------------------------------------------------------------

  /** The tenant's connector mode; defaults to LEADS when never set. */
  async getMode(workspaceId: string): Promise<ConnectorSettingView> {
    const row = await this.prisma.connectorSetting.findUnique({
      where: { workspaceId },
    });
    const mode: ConnectorMode =
      row && isConnectorMode(row.mode) ? row.mode : DEFAULT_CONNECTOR_MODE;
    return { mode, updatedAt: row?.updatedAt ?? new Date(0) };
  }

  /** Set the tenant's connector mode (the UI's LEADS/FUNDING switch). */
  async setMode(workspaceId: string, mode: ConnectorMode): Promise<ConnectorSettingView> {
    if (!isConnectorMode(mode)) {
      throw new ConnectorError("invalid_mode", "mode must be leads or funding.");
    }
    const row = await this.prisma.connectorSetting.upsert({
      where: { workspaceId },
      create: { workspaceId, mode },
      update: { mode },
    });
    return { mode: row.mode as ConnectorMode, updatedAt: row.updatedAt };
  }

  /**
   * Mode-scoped intro targets. When `mode` is absent, the tenant's
   * setting decides. LEADS → buyer/partner companies; FUNDING →
   * investor companies + the Funding/VC investor CRM (read-only).
   * Every query is tenant-scoped; nothing crosses workspaces.
   */
  async listTargets(
    workspaceId: string,
    modeInput?: ConnectorMode,
  ): Promise<ModeTargetListView> {
    const mode = modeInput ?? (await this.getMode(workspaceId)).mode;
    const relationships =
      mode === "funding"
        ? ([...FUNDING_TARGET_RELATIONSHIPS] as ConnectorCompanyRelationship[])
        : ([...LEADS_TARGET_RELATIONSHIPS] as ConnectorCompanyRelationship[]);

    const companyRows = await this.prisma.connectorCompany.findMany({
      where: { workspaceId, relationship: { in: relationships } },
      orderBy: { name: "asc" },
      include: { _count: { select: { employments: true } } },
    });

    let investors: FundingInvestorTargetView[] = [];
    if (mode === "funding") {
      const investorRows = await this.prisma.fundingInvestor.findMany({
        where: { workspaceId },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          firm: true,
          title: true,
          email: true,
          checkSizeMin: true,
          checkSizeMax: true,
          stages: true,
          sectors: true,
          thesisFit: true,
          stage: true,
        },
      });
      investors = investorRows.map((r) => ({
        id: r.id,
        name: r.name,
        firm: r.firm,
        title: r.title,
        email: r.email,
        checkSizeMin: r.checkSizeMin,
        checkSizeMax: r.checkSizeMax,
        stages: r.stages,
        sectors: r.sectors,
        thesisFit: r.thesisFit,
        stage: r.stage as InvestorStage,
      }));
    }

    return {
      mode,
      companies: companyRows.map((r) => ({
        id: r.id,
        name: r.name,
        industry: r.industry,
        sizeBand: r.sizeBand,
        relationship: r.relationship,
        employeeCount: r._count.employments,
      })),
      investors,
    };
  }

  // ------------------------------------------------------------------
  // Slice 2 — source consent. One row per (workspace, source); the import
  // job refuses to run without it. Deleting = revoking.
  // ------------------------------------------------------------------

  async recordSourceConsent(
    workspaceId: string,
    input: SourceConsentInput,
    now = new Date(),
  ): Promise<ConnectorSourceConsentView> {
    const { errors, value } = validateSourceConsentInput(input);
    if (!value) {
      throw new ConnectorError("invalid_source_consent", errors.join(" "));
    }
    const row = await this.prisma.connectorSourceConsent.upsert({
      where: { workspaceId_source: { workspaceId, source: value.source } },
      update: {
        consentedBy: value.consentedBy,
        consentedAt: now,
        scopes: value.scopes,
        note: value.note,
      },
      create: {
        workspaceId,
        source: value.source,
        consentedBy: value.consentedBy,
        consentedAt: now,
        scopes: value.scopes,
        note: value.note,
      },
    });
    return toSourceConsentView(row);
  }

  async revokeSourceConsent(
    workspaceId: string,
    source: ConnectorImportSource,
  ): Promise<{ revoked: boolean }> {
    const res = await this.prisma.connectorSourceConsent.deleteMany({
      where: { workspaceId, source },
    });
    return { revoked: res.count > 0 };
  }

  async getSourceConsent(
    workspaceId: string,
    source: ConnectorImportSource,
  ): Promise<ConnectorSourceConsentView | null> {
    const row = await this.prisma.connectorSourceConsent.findFirst({
      where: { workspaceId, source },
    });
    return row ? toSourceConsentView(row) : null;
  }

  async listSourceConsents(
    workspaceId: string,
  ): Promise<ConnectorSourceConsentView[]> {
    const rows = await this.prisma.connectorSourceConsent.findMany({
      where: { workspaceId },
      orderBy: { source: "asc" },
    });
    return rows.map(toSourceConsentView);
  }

  // ------------------------------------------------------------------
  // Slice 2 — exclusion lists. Checked BEFORE any Person row is created.
  // ------------------------------------------------------------------

  async listExclusions(workspaceId: string): Promise<ConnectorExclusionView[]> {
    const rows = await this.prisma.connectorExclusion.findMany({
      where: { workspaceId },
      orderBy: [{ type: "asc" }, { value: "asc" }],
    });
    return rows.map(toExclusionView);
  }

  async addExclusion(
    workspaceId: string,
    input: ExclusionInput,
  ): Promise<ConnectorExclusionView> {
    const { errors, value } = validateExclusionInput(input);
    if (!value) {
      throw new ConnectorError("invalid_exclusion", errors.join(" "));
    }
    try {
      const row = await this.prisma.connectorExclusion.create({
        data: {
          workspaceId,
          type: value.type,
          value: value.value,
          note: value.note,
        },
      });
      return toExclusionView(row);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConnectorError(
          "duplicate_exclusion",
          "This exclusion rule already exists in this workspace.",
        );
      }
      throw e;
    }
  }

  async removeExclusion(
    workspaceId: string,
    exclusionId: string,
  ): Promise<{ removed: boolean }> {
    const res = await this.prisma.connectorExclusion.deleteMany({
      where: { id: exclusionId, workspaceId },
    });
    return { removed: res.count > 0 };
  }

  // ------------------------------------------------------------------
  // Slice 2 — import batch lifecycle + relationship signal seeding.
  // ------------------------------------------------------------------

  /**
   * Update a batch's run lifecycle fields. Tenant-scoped: a batch id from
   * another workspace throws batch_not_found.
   */
  async updateImportBatch(
    workspaceId: string,
    batchId: string,
    patch: {
      status: ConnectorImportBatchStatus;
      cursor?: string | null;
      stats?: ConnectorImportStats | null;
      error?: string | null;
      completedAt?: Date | null;
    },
  ): Promise<ConnectorImportBatchView> {
    const batch = await this.prisma.connectorImportBatch.findFirst({
      where: { id: batchId, workspaceId },
      select: { id: true },
    });
    if (!batch) {
      throw new ConnectorError("batch_not_found", "Import batch not found in this workspace.");
    }
    const row = await this.prisma.connectorImportBatch.update({
      where: { id: batchId },
      data: {
        status: patch.status,
        ...(patch.cursor !== undefined ? { cursor: patch.cursor } : {}),
        ...(patch.stats !== undefined
          ? { stats: patch.stats as unknown as Prisma.InputJsonValue }
          : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
      },
      include: { _count: { select: { persons: true } } },
    });
    return toBatchView(row);
  }

  /**
   * Merge aggregated interaction signals into a person's relationship edge
   * (seed on first import, merge on re-import). Warmth is RECOMPUTED from
   * the merged signals via computeWarmth — never hand-set.
   */
  async addRelationshipSignals(
    workspaceId: string,
    personId: string,
    signals: {
      touchCount: number;
      inboundCount: number;
      outboundCount: number;
      lastTouchAt: Date | null;
    },
    now = new Date(),
  ): Promise<ConnectorRelationshipView> {
    await this.requirePerson(workspaceId, personId);
    const row = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.connectorRelationship.findUnique({
        where: { personId },
      });
      if (existing && existing.workspaceId !== workspaceId) {
        throw new ConnectorError(
          "relationship_not_found",
          "Relationship not found in this workspace.",
        );
      }
      const prev = existing ?? {
        touchCount: 0,
        inboundCount: 0,
        outboundCount: 0,
        lastTouchAt: null as Date | null,
        lastReciprocalTouchAt: null as Date | null,
      };
      const touchCount = prev.touchCount + signals.touchCount;
      const inboundCount = prev.inboundCount + signals.inboundCount;
      const outboundCount = prev.outboundCount + signals.outboundCount;
      const lastTouchAt =
        signals.lastTouchAt &&
        (!prev.lastTouchAt || signals.lastTouchAt.getTime() > prev.lastTouchAt.getTime())
          ? signals.lastTouchAt
          : prev.lastTouchAt;
      const lastReciprocalTouchAt =
        signals.inboundCount > 0 &&
        signals.lastTouchAt &&
        (!prev.lastReciprocalTouchAt ||
          signals.lastTouchAt.getTime() > prev.lastReciprocalTouchAt.getTime())
          ? signals.lastTouchAt
          : prev.lastReciprocalTouchAt;
      const { score } = computeWarmth(
        { lastTouchAt, touchCount, inboundCount, outboundCount },
        now,
      );
      const data = {
        touchCount,
        inboundCount,
        outboundCount,
        lastTouchAt,
        lastReciprocalTouchAt,
        warmthScore: score,
        warmthComputedAt: now,
      };
      return existing
        ? await tx.connectorRelationship.update({ where: { personId }, data })
        : await tx.connectorRelationship.create({
            data: { workspaceId, personId, ...data },
          });
    });
    return toRelationshipView(row, now);
  }

  /**
   * Latest completed batch cursor for (workspace, source) — the
   * incremental-sync watermark. The next run fetches only newer contacts.
   */
  async getImportCursor(
    workspaceId: string,
    source: ConnectorImportSource,
  ): Promise<string | null> {
    const row = await this.prisma.connectorImportBatch.findFirst({
      where: { workspaceId, source, status: "completed", cursor: { not: null } },
      orderBy: { completedAt: "desc" },
      select: { cursor: true },
    });
    return row?.cursor ?? null;
  }

  /**
   * Find a person by the provider dedup key. Tenant-scoped — another
   * tenant's externalId never matches.
   */
  async findPersonByExternalId(
    workspaceId: string,
    externalId: string,
  ): Promise<{ id: string } | null> {
    return this.prisma.connectorPerson.findFirst({
      where: { workspaceId, externalId },
      select: { id: true },
    });
  }

  // ------------------------------------------------------------------
  // Slice 3 — IntroPath engine. Paths are COMPUTED over a tenant-scoped
  // snapshot and served from a bounded TTL cache — never persisted.
  // ------------------------------------------------------------------

  /**
   * Load the per-tenant graph snapshot the IntroPath engine walks.
   * Tenant-scoped: persons (with their relationship edge + employments),
   * companies, and exclusion rules. No cross-tenant rows by construction.
   */
  async loadPathInputs(
    workspaceId: string,
  ): Promise<{
    persons: PathPersonInput[];
    companies: PathCompanyInput[];
    exclusions: Array<{ type: ConnectorExclusionType; value: string }>;
  }> {
    const [personRows, companyRows, exclusionRows] = await Promise.all([
      this.prisma.connectorPerson.findMany({
        where: { workspaceId },
        orderBy: [{ createdAt: "asc" }],
        select: {
          id: true,
          name: true,
          handles: true,
          relationship: {
            select: {
              warmthScore: true,
              lastTouchAt: true,
              notes: true,
              boundaries: true,
            },
          },
          employments: {
            select: {
              companyId: true,
              title: true,
              startYear: true,
              endYear: true,
              isCurrent: true,
              company: { select: { name: true } },
            },
          },
        },
      }),
      this.prisma.connectorCompany.findMany({
        where: { workspaceId },
        orderBy: [{ name: "asc" }],
        select: { id: true, name: true },
      }),
      this.prisma.connectorExclusion.findMany({
        where: { workspaceId },
        select: { type: true, value: true },
      }),
    ]);
    return {
      persons: personRows.map((p) => ({
        id: p.id,
        name: p.name,
        handles: p.handles,
        relationship: p.relationship
          ? {
              warmthScore: p.relationship.warmthScore,
              lastTouchAt: p.relationship.lastTouchAt,
              notes: p.relationship.notes,
              boundaries: p.relationship.boundaries,
            }
          : null,
        employments: p.employments.map((e) => ({
          companyId: e.companyId,
          companyName: e.company.name,
          title: e.title,
          startYear: e.startYear,
          endYear: e.endYear,
          isCurrent: e.isCurrent,
        })),
      })),
      companies: companyRows.map((c) => ({ id: c.id, name: c.name })),
      exclusions: exclusionRows,
    };
  }

  /**
   * Compute ranked intro paths to a target person or company. Serves from
   * the per-tenant TTL cache unless recompute is requested. The target id
   * must belong to this tenant — a foreign id reads as target_not_found,
   * never as another tenant's data. Slice 5: when `mode` is provided,
   * company targets are mode-scoped (a buyer company is not a legal
   * FUNDING-mode target, an investor company is not a legal LEADS target).
   */
  async computeIntroPaths(
    workspaceId: string,
    input: {
      targetPersonId?: string;
      targetCompanyId?: string;
      maxPaths?: number;
      recompute?: boolean;
      now?: Date;
      /** Slice 5: per-query mode override (default: tenant setting). */
      mode?: ConnectorMode;
    },
  ): Promise<{ result: IntroPathResult; cached: boolean; computedAt: Date }> {
    const now = input.now ?? new Date();
    const hasPerson = !!input.targetPersonId;
    const hasCompany = !!input.targetCompanyId;
    if (hasPerson === hasCompany) {
      throw new ConnectorError(
        "invalid_target",
        "Exactly one of targetPersonId or targetCompanyId is required.",
      );
    }
    const kind = hasPerson ? ("person" as const) : ("company" as const);
    const targetId = (input.targetPersonId ?? input.targetCompanyId) as string;

    // Slice 5: mode-scoped path-finding. The effective mode is the
    // per-query override or the tenant's setting.
    const effectiveMode = input.mode ?? (await this.getMode(workspaceId)).mode;
    if (hasCompany && input.targetCompanyId) {
      const company = await this.prisma.connectorCompany.findFirst({
        where: { id: input.targetCompanyId, workspaceId },
        select: { id: true, name: true, relationship: true },
      });
      if (!company) {
        throw new ConnectorError("target_not_found", "Target company not found in this workspace.");
      }
      if (!companyRelationshipAllowedInMode(company.relationship, effectiveMode)) {
        throw new ConnectorError(
          "mode_target_mismatch",
          `${company.name} is a ${company.relationship ?? "unclassified"} company — not a legal target in ${effectiveMode.toUpperCase()} mode.`,
        );
      }
    }

    if (!input.recompute) {
      const hit = getCachedIntroPaths(workspaceId, kind, targetId, now);
      if (hit) {
        return { result: hit, cached: true, computedAt: now };
      }
    }

    const snapshot = await this.loadPathInputs(workspaceId);
    const result = computeIntroPaths({
      persons: snapshot.persons,
      companies: snapshot.companies,
      exclusions: snapshot.exclusions,
      targetPersonId: input.targetPersonId,
      targetCompanyId: input.targetCompanyId,
      maxPaths: input.maxPaths,
      now,
    });
    if (!result.blocked) {
      setCachedIntroPaths(workspaceId, kind, targetId, result, now);
    }
    return { result, cached: false, computedAt: now };
  }

  /**
   * Bounded sweep: refresh cached top paths per tenant. Warms at most
   * maxTargets candidate targets (persons with a relationship edge first,
   * then companies), capped to maxPaths paths each. Used by the scheduled
   * recompute and the manual recompute trigger.
   */
  async warmPathCache(
    workspaceId: string,
    opts: { maxTargets?: number; maxPaths?: number; now?: Date } = {},
  ): Promise<{ targetsWarmed: number; pathsCached: number }> {
    const now = opts.now ?? new Date();
    const maxTargets = Math.max(1, Math.min(50, opts.maxTargets ?? 25));
    const maxPaths = Math.max(1, Math.min(25, opts.maxPaths ?? INTRO_DEFAULT_MAX_PATHS));
    const snapshot = await this.loadPathInputs(workspaceId);

    // Candidate targets: people the tenant actually has a relationship
    // edge to (warmest first), then companies. Bounded.
    const rankedPersons = [...snapshot.persons]
      .filter((p) => p.relationship)
      .sort(
        (a, b) =>
          (b.relationship?.warmthScore ?? 0) - (a.relationship?.warmthScore ?? 0),
      );
    const employedCompanyIds = new Set<string>();
    for (const p of snapshot.persons) {
      for (const e of p.employments) employedCompanyIds.add(e.companyId);
    }
    const rankedCompanies = snapshot.companies.filter((c) =>
      employedCompanyIds.has(c.id),
    );
    const targets: Array<{ kind: "person" | "company"; id: string }> = [
      ...rankedPersons.map((p) => ({ kind: "person" as const, id: p.id })),
      ...rankedCompanies.map((c) => ({ kind: "company" as const, id: c.id })),
    ].slice(0, maxTargets);

    let pathsCached = 0;
    for (const t of targets) {
      const result = computeIntroPaths({
        persons: snapshot.persons,
        companies: snapshot.companies,
        exclusions: snapshot.exclusions,
        targetPersonId: t.kind === "person" ? t.id : undefined,
        targetCompanyId: t.kind === "company" ? t.id : undefined,
        maxPaths,
        now,
      });
      if (!result.blocked) {
        setCachedIntroPaths(workspaceId, t.kind, t.id, result, now);
        pathsCached += result.paths.length;
      }
    }
    return { targetsWarmed: targets.length, pathsCached };
  }

  // ------------------------------------------------------------------
  // Slice 6 — opt-in discoverability.
  //
  // The directory profile is the ONLY cross-tenant-readable connector
  // data. Opt-in only: a tenant with no profile (or discoverable=false)
  // is invisible to matching. Reversible: flipping discoverable to false
  // unpublishes instantly. findDirectoryMatches throws not_discoverable
  // when the VIEWER isn't discoverable (mutual-discoverability gate) and
  // never reads the private graph across tenants — only directory rows.
  // ------------------------------------------------------------------

  /** The tenant's own directory profile. Null when never set (invisible). */
  async getDirectoryProfile(workspaceId: string): Promise<DirectoryProfileView | null> {
    const row = (await this.prisma.connectorDirectoryProfile.findUnique({
      where: { workspaceId },
    })) as DirectoryProfileRow | null;
    if (!row) return null;
    return toDirectoryProfileView(row);
  }

  /**
   * Publish / edit / unpublish the tenant's directory profile (upsert —
   * partial input merges with the existing row). Publishing
   * (discoverable=true) requires a name (the name+role facet needs an
   * identity). Unpublishing (discoverable=false) is a plain update and
   * hides the profile immediately — fully reversible.
   */
  async setDirectoryProfile(
    workspaceId: string,
    input: DirectoryProfileInput,
  ): Promise<DirectoryProfileView> {
    const { errors, value } = validateDirectoryProfileInput(input);
    if (!value) {
      throw new ConnectorError("invalid_directory_profile", errors.join(" "));
    }
    const existing = (await this.prisma.connectorDirectoryProfile.findUnique({
      where: { workspaceId },
    })) as DirectoryProfileRow | null;

    // Merge: undefined = not provided (keep current). Publishing requires a
    // merged name — the name+role facet needs an identity.
    const discoverable = value.discoverable ?? existing?.discoverable ?? false;
    const name = value.name !== undefined ? value.name : (existing?.name ?? null);

    // The merged-name rule: no nameless publishing, even when the name
    // would have come from the existing row.
    if (discoverable && !name) {
      throw new ConnectorError(
        "publish_requires_name",
        "name is required to publish — the directory needs an identity.",
      );
    }

    const row = (await this.prisma.connectorDirectoryProfile.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        discoverable,
        name: value.name ?? null,
        role: value.role ?? null,
        company: value.company ?? null,
        bio: value.bio ?? null,
        industries: value.industries ?? [],
        lookingFor: value.lookingFor ?? null,
        shareNameRole: value.shareNameRole ?? true,
        shareFull: value.shareFull ?? false,
      },
      update: {
        ...(value.discoverable !== undefined ? { discoverable: value.discoverable } : {}),
        ...(value.name !== undefined ? { name: value.name } : {}),
        ...(value.role !== undefined ? { role: value.role } : {}),
        ...(value.company !== undefined ? { company: value.company } : {}),
        ...(value.bio !== undefined ? { bio: value.bio } : {}),
        ...(value.industries !== undefined ? { industries: value.industries } : {}),
        ...(value.lookingFor !== undefined ? { lookingFor: value.lookingFor } : {}),
        ...(value.shareNameRole !== undefined ? { shareNameRole: value.shareNameRole } : {}),
        ...(value.shareFull !== undefined ? { shareFull: value.shareFull } : {}),
      },
    })) as DirectoryProfileRow;
    return toDirectoryProfileView(row);
  }

  /**
   * Mutual-discoverability matching. The viewer's own profile must be
   * published (else not_discoverable). Candidate rows are read directly —
   * directory profiles only, NEVER the private graph. Non-discoverable
   * candidates are filtered by the pure matcher (never matched).
   */
  async findDirectoryMatches(
    workspaceId: string,
    criteria?: DirectoryMatchCriteria,
  ): Promise<DirectoryMatch[]> {
    const own = (await this.prisma.connectorDirectoryProfile.findUnique({
      where: { workspaceId },
    })) as DirectoryProfileRow | null;
    if (!own?.discoverable) {
      throw new ConnectorError(
        "not_discoverable",
        "Directory matching requires mutual discoverability: publish your own profile before matching against other discoverable users.",
      );
    }
    // Bound the candidate set; the pure matcher applies the gates.
    const candidates = (await this.prisma.connectorDirectoryProfile.findMany({
      where: { discoverable: true, NOT: { workspaceId } },
      take: 500,
      orderBy: { updatedAt: "desc" },
    })) as DirectoryProfileRow[];
    return matchDirectoryProfiles({
      viewerWorkspaceId: workspaceId,
      viewerDiscoverable: true,
      candidates,
      criteria,
    });
  }
}

// ---------------------------------------------------------------------------
// View converters (module-private).
// ---------------------------------------------------------------------------

/** The batch row shape every include/select in this store returns. */
type ImportBatchRow = {
  id: string;
  source: ConnectorImportSource;
  consentedBy: string;
  consentedAt: Date;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
  status: ConnectorImportBatchStatus;
  cursor: string | null;
  stats: unknown;
  completedAt: Date | null;
  error: string | null;
  _count: { persons: number };
};

function toBatchView(row: ImportBatchRow): ConnectorImportBatchView {
  return {
    id: row.id,
    source: row.source,
    consentedBy: row.consentedBy,
    consentedAt: row.consentedAt,
    note: row.note,
    personCount: row._count.persons,
    createdAt: row.createdAt,
    status: row.status,
    cursor: row.cursor,
    stats: (row.stats ?? null) as ConnectorImportStats | null,
    completedAt: row.completedAt,
    error: row.error,
    updatedAt: row.updatedAt,
  };
}

function toSourceConsentView(row: {
  id: string;
  source: ConnectorImportSource;
  consentedBy: string;
  consentedAt: Date;
  scopes: string[];
  note: string | null;
  updatedAt: Date;
}): ConnectorSourceConsentView {
  return {
    id: row.id,
    source: row.source,
    consentedBy: row.consentedBy,
    consentedAt: row.consentedAt,
    scopes: row.scopes,
    note: row.note,
    updatedAt: row.updatedAt,
  };
}

function toExclusionView(row: {
  id: string;
  type: ConnectorExclusionType;
  value: string;
  note: string | null;
  createdAt: Date;
}): ConnectorExclusionView {
  return {
    id: row.id,
    type: row.type,
    value: row.value,
    note: row.note,
    createdAt: row.createdAt,
  };
}

function toCompanyView(row: {
  id: string;
  name: string;
  industry: string | null;
  sizeBand: ConnectorCompanySizeBand | null;
  relationship: ConnectorCompanyRelationship | null;
  createdAt: Date;
  updatedAt: Date;
  _count: { employments: number };
}): ConnectorCompanyView {
  return {
    id: row.id,
    name: row.name,
    industry: row.industry,
    sizeBand: row.sizeBand,
    relationship: row.relationship,
    employeeCount: row._count.employments,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toEmploymentView(row: {
  id: string;
  companyId: string;
  title: string | null;
  startYear: number | null;
  endYear: number | null;
  isCurrent: boolean;
  company: {
    name: string;
    industry: string | null;
    sizeBand: ConnectorCompanySizeBand | null;
    relationship: ConnectorCompanyRelationship | null;
  };
}): ConnectorEmploymentView {
  return {
    id: row.id,
    companyId: row.companyId,
    companyName: row.company.name,
    companyIndustry: row.company.industry,
    companySizeBand: row.company.sizeBand,
    companyRelationship: row.company.relationship,
    title: row.title,
    startYear: row.startYear,
    endYear: row.endYear,
    isCurrent: row.isCurrent,
  };
}

function toPersonView(
  row: {
    id: string;
    name: string;
    roles: string[];
    handles: string[];
    importBatchId: string | null;
    consentedBy: string;
    consentedAt: Date;
    createdAt: Date;
    updatedAt: Date;
    relationship: RelationshipRow | null;
    employments: Array<Parameters<typeof toEmploymentView>[0]>;
    importBatch: ImportBatchRow | null;
  },
  now: Date,
): ConnectorPersonView {
  return {
    id: row.id,
    name: row.name,
    roles: row.roles,
    handles: row.handles,
    importBatchId: row.importBatchId,
    importBatch: row.importBatch ? toBatchView(row.importBatch) : null,
    consentedBy: row.consentedBy,
    consentedAt: row.consentedAt,
    relationship: row.relationship ? toRelationshipView(row.relationship, now) : null,
    employments: row.employments.map(toEmploymentView),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
