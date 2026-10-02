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
  validateImportBatchInput,
  validatePersonInput,
  validateRelationshipPatch,
  validateTouchInput,
  type CompanyInput,
  type ConnectorCompanySizeBand,
  type ConnectorCompanyRelationship,
  type ConnectorCompanyView,
  type ConnectorEmploymentView,
  type ConnectorGraphView,
  type ConnectorImportBatchView,
  type ConnectorImportSource,
  type ConnectorPersonView,
  type ConnectorRelationshipView,
  type EmploymentInput,
  type ImportBatchInput,
  type PersonInput,
  type RelationshipPatchInput,
  type TouchDirection,
  type TouchInput,
  type WarmthBreakdown,
} from "./types";

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
}

// ---------------------------------------------------------------------------
// View converters (module-private).
// ---------------------------------------------------------------------------

function toBatchView(row: {
  id: string;
  source: ConnectorImportSource;
  consentedBy: string;
  consentedAt: Date;
  note: string | null;
  createdAt: Date;
  _count: { persons: number };
}): ConnectorImportBatchView {
  return {
    id: row.id,
    source: row.source,
    consentedBy: row.consentedBy,
    consentedAt: row.consentedAt,
    note: row.note,
    personCount: row._count.persons,
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
    importBatch: {
      id: string;
      source: ConnectorImportSource;
      consentedBy: string;
      consentedAt: Date;
      note: string | null;
      createdAt: Date;
      _count: { persons: number };
    } | null;
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
