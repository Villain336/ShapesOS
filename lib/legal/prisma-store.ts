// Marketr — Legal/Compliance: Prisma store.
// Slice 1 (obligation map): LegalProfile is one row per workspace (upsert).
// ObligationTemplate rows are seed data (idempotent upsert by key).
// Obligation rows are materialized per tenant when the profile is saved:
// templates that match the profile get an "open" row, rows whose template no
// longer matches are removed, and existing tenant status
// (snoozed/dismissed/done) is preserved across re-saves. The computed
// checklist itself always comes from the pure engine in obligations.ts — the
// DB holds profiles, templates, and overrides only.
//
// Slice 2 (deadline engine): LegalDeadline rows are per-tenant computed
// deadlines. A deadline only exists once the TENANT sets/confirms a due date
// (source "tenant_set"). Recurring reminders are computed from the tenant's
// renewal cadence anchored to that real date (source "computed", via
// nextDueDate). A null dueDate is ALWAYS "date needed" — the store never
// invents dates.

import type { PrismaClient } from "@prisma/client";
import { writeFile, FsError } from "@/lib/filesystem/service";
import { normalizeLogicalPath } from "@/lib/filesystem/paths";
import { safeFilename } from "@/lib/security/upload-safety";
import { computeObligations, validateSeedTemplates } from "./obligations";
import { OBLIGATION_TEMPLATES } from "./seeds";
import { REGULATION_CHANGE_SEEDS } from "./radar-seeds";
import {
  changeAppliesToProfile,
  changeToObligationSeed,
  triageChanges,
  validateSeedChanges,
  type ChangeTriageRow,
} from "./radar";
import {
  RADAR_TRIAGE_STATUSES,
  type RadarTriageStatus,
  type RegulationChangeCategory,
  type SeedRegulationChange,
  type TriagedChange,
} from "./radar-types";
import {
  LegalError,
  validateLegalProfileInput,
  type ComputedObligation,
  type LegalProfileInput,
  type ObligationStatus,
} from "./types";
import {
  daysUntilDue,
  isValidRecurrence,
  nextDueDate,
  tierForDeadline,
  type DeadlineRecurrence,
  type DeadlineSource,
  type EscalationTier,
} from "./deadlines";
import {
  carryForwardExpiry,
  daysUntilDue as daysUntilExpiry,
  isValidDocumentType,
  isValidExpirySource,
  planNewVersion,
  tierForExpiry,
  type ExpiryTier,
  type LegalDocumentType,
  type LegalExpirySource,
  type PreviousVersion,
} from "./documents";

export class PrismaLegalStore {
  constructor(private prisma: PrismaClient) {}

  async getProfile(workspaceId: string) {
    return this.prisma.legalProfile.findUnique({ where: { workspaceId } });
  }

  /**
   * Save the tenant's legal profile and re-materialize their obligation rows.
   * Returns the profile plus the freshly computed checklist.
   */
  async saveProfile(
    workspaceId: string,
    input: LegalProfileInput,
  ): Promise<{ profile: { industry: string; businessModel: string; jurisdictions: string[] }; obligations: ComputedObligation[] }> {
    validateLegalProfileInput(input);
    const jurisdictions = [...new Set(input.jurisdictions)];

    const profile = await this.prisma.legalProfile.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        industry: input.industry,
        businessModel: input.businessModel,
        jurisdictions,
      },
      update: {
        industry: input.industry,
        businessModel: input.businessModel,
        jurisdictions,
      },
    });

    await this.materializeObligations(workspaceId, {
      industry: profile.industry,
      businessModel: profile.businessModel,
      jurisdictions: profile.jurisdictions,
    });

    const obligations = await this.listObligations(workspaceId);
    return {
      profile: {
        industry: profile.industry,
        businessModel: profile.businessModel,
        jurisdictions: profile.jurisdictions,
      },
      obligations,
    };
  }

  /** Idempotent seed: validate, then upsert every template by key. */
  async seedTemplates(): Promise<{ seeded: number }> {
    validateSeedTemplates(OBLIGATION_TEMPLATES);
    for (const t of OBLIGATION_TEMPLATES) {
      await this.prisma.obligationTemplate.upsert({
        where: { key: t.key },
        create: {
          key: t.key,
          industries: t.industries,
          jurisdictions: t.jurisdictions,
          category: t.category,
          title: t.title,
          description: t.description,
          sourceRef: t.sourceRef,
          renewalCadence: t.renewalCadence,
          needsReview: t.needsReview,
        },
        update: {
          industries: t.industries,
          jurisdictions: t.jurisdictions,
          category: t.category,
          title: t.title,
          description: t.description,
          sourceRef: t.sourceRef,
          renewalCadence: t.renewalCadence,
          needsReview: t.needsReview,
          version: { increment: 1 },
        },
      });
    }
    return { seeded: OBLIGATION_TEMPLATES.length };
  }

  async listTemplates() {
    return this.prisma.obligationTemplate.findMany({
      orderBy: [{ category: "asc" }, { title: "asc" }],
    });
  }

  /**
   * The tenant's computed checklist: engine output over DB templates with
   * persisted Obligation rows merged as overrides.
   */
  async listObligations(workspaceId: string): Promise<ComputedObligation[]> {
    const profile = await this.getProfile(workspaceId);
    if (!profile) return [];
    const templates = await this.listTemplates();
    const overrides = await this.prisma.obligation.findMany({
      where: { workspaceId },
    });
    return computeObligations(
      {
        industry: profile.industry,
        businessModel: profile.businessModel,
        jurisdictions: profile.jurisdictions,
      },
      templates.map((t) => ({
        key: t.key,
        industries: t.industries,
        jurisdictions: t.jurisdictions,
        category: t.category,
        title: t.title,
        description: t.description,
        sourceRef: t.sourceRef,
        renewalCadence: t.renewalCadence,
        needsReview: t.needsReview,
      })),
      overrides.map((o) => ({
        templateKey: o.templateKey,
        status: o.status,
        snoozedUntil: o.snoozedUntil?.toISOString() ?? null,
        note: o.note,
      })),
    );
  }

  async setObligationStatus(
    workspaceId: string,
    templateKey: string,
    status: ObligationStatus,
    opts?: { snoozedUntil?: string | null; note?: string | null },
  ): Promise<void> {
    const valid: ObligationStatus[] = ["open", "snoozed", "dismissed", "done"];
    if (!valid.includes(status)) {
      throw new LegalError("INVALID_STATUS", `Status must be one of: ${valid.join(", ")}`);
    }
    const template = await this.prisma.obligationTemplate.findUnique({
      where: { key: templateKey },
    });
    if (!template) {
      throw new LegalError("UNKNOWN_TEMPLATE", `No obligation template: ${templateKey}`);
    }
    let snoozedUntil: Date | null = null;
    if (opts?.snoozedUntil) {
      snoozedUntil = new Date(opts.snoozedUntil);
      if (Number.isNaN(snoozedUntil.getTime())) {
        throw new LegalError("INVALID_SNOOZE", "snoozedUntil must be a valid date.");
      }
    }
    await this.prisma.obligation.upsert({
      where: { workspaceId_templateKey: { workspaceId, templateKey } },
      create: {
        workspaceId,
        templateKey,
        status,
        snoozedUntil,
        note: opts?.note ?? null,
      },
      update: {
        status,
        snoozedUntil,
        note: opts?.note ?? null,
      },
    });
  }

  private async materializeObligations(
    workspaceId: string,
    profile: LegalProfileInput,
  ): Promise<void> {
    const templates = await this.listTemplates();
    const applicable = computeObligations(profile, templates.map((t) => ({
      key: t.key,
      industries: t.industries,
      jurisdictions: t.jurisdictions,
      category: t.category,
      title: t.title,
      description: t.description,
      sourceRef: t.sourceRef,
      renewalCadence: t.renewalCadence,
      needsReview: t.needsReview,
    }))).map((o) => o.key);
    const applicableSet = new Set(applicable);

    await this.prisma.$transaction(async (tx) => {
      // Create rows for newly applicable templates (skip existing — preserves
      // tenant status).
      for (const key of applicableSet) {
        await tx.obligation.upsert({
          where: { workspaceId_templateKey: { workspaceId, templateKey: key } },
          create: { workspaceId, templateKey: key, status: "open" },
          update: {},
        });
      }
      // Remove rows whose template no longer matches the profile.
      const existing = await tx.obligation.findMany({ where: { workspaceId } });
      for (const row of existing) {
        if (!applicableSet.has(row.templateKey)) {
          await tx.obligation.delete({ where: { id: row.id } });
        }
      }
    });
  }

  // ------------------------------------------------------------------
  // Slice 2: deadline engine
  // ------------------------------------------------------------------

  /** Deadlines with computed escalation tier, soonest first ("date needed" last). */
  async listDeadlines(
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<ComputedDeadline[]> {
    const rows = await this.prisma.legalDeadline.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
    });
    const computed = rows.map((r) => toComputedDeadline(r, now));
    computed.sort((a, b) => {
      if (a.tier !== b.tier) {
        const order = (t: EscalationTier | null) =>
          t === null
            ? 99
            : (["overdue", "date_needed", "due_7", "due_30", "due_90"] as const).indexOf(t);
        return order(a.tier) - order(b.tier);
      }
      const da = a.dueDate ? new Date(a.dueDate).getTime() : Number.POSITIVE_INFINITY;
      const db = b.dueDate ? new Date(b.dueDate).getTime() : Number.POSITIVE_INFINITY;
      return da - db;
    });
    return computed;
  }

  /**
   * Tenant sets (or re-sets) the due date for an obligation. One active
   * ("open") deadline per template key — an existing open row is updated,
   * history rows (done/dismissed) are left alone. Guardrail: the due date
   * must come from the tenant's request; passing null means "date needed".
   */
  async upsertDeadline(
    workspaceId: string,
    templateKey: string,
    input: {
      dueDate?: string | null;
      recurrence?: DeadlineRecurrence;
      note?: string | null;
    },
  ): Promise<ComputedDeadline> {
    const template = await this.prisma.obligationTemplate.findUnique({
      where: { key: templateKey },
    });
    if (!template) {
      throw new LegalError("UNKNOWN_TEMPLATE", `No obligation template: ${templateKey}`);
    }
    const dueDate = parseOptionalDate(input.dueDate, "dueDate");
    const recurrence = input.recurrence ?? "none";
    if (!isValidRecurrence(recurrence)) {
      throw new LegalError("INVALID_RECURRENCE", "Recurrence must be a known cadence.");
    }

    const existing = await this.prisma.legalDeadline.findFirst({
      where: { workspaceId, templateKey, status: "open" },
    });
    const data = {
      title: template.title,
      dueDate,
      recurrence,
      source: "tenant_set" as const,
      note: input.note ?? null,
      // A re-set date resets the escalation ladder — new tier, new alerts.
      lastAlertedTier: null,
      lastAlertedAt: null,
    };
    const row = existing
      ? await this.prisma.legalDeadline.update({
          where: { id: existing.id },
          data: { ...data, title: existing.title },
        })
      : await this.prisma.legalDeadline.create({
          data: {
            workspaceId,
            templateKey,
            ...data,
          },
        });
    return toComputedDeadline(row);
  }

  /** Tenant edits one deadline (date, recurrence, note, or status). */
  async updateDeadline(
    workspaceId: string,
    id: string,
    input: {
      dueDate?: string | null;
      recurrence?: DeadlineRecurrence;
      note?: string | null;
      status?: "open" | "done" | "dismissed";
    },
  ): Promise<ComputedDeadline> {
    const existing = await this.prisma.legalDeadline.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) {
      throw new LegalError("UNKNOWN_DEADLINE", `No deadline: ${id}`);
    }
    if (input.status === "done") {
      return this.markDeadlineDone(workspaceId, id);
    }
    const data: {
      dueDate?: Date | null;
      recurrence?: DeadlineRecurrence;
      note?: string | null;
      status?: "open" | "dismissed";
    } = {};
    if (input.dueDate !== undefined) {
      // A changed date resets the escalation ladder (see the spread below).
      data.dueDate = parseOptionalDate(input.dueDate, "dueDate");
    }
    if (input.recurrence !== undefined) {
      if (!isValidRecurrence(input.recurrence)) {
        throw new LegalError("INVALID_RECURRENCE", "Recurrence must be a known cadence.");
      }
      data.recurrence = input.recurrence;
    }
    if (input.note !== undefined) data.note = input.note;
    if (input.status === "dismissed") data.status = "dismissed";
    if (input.status === "open") data.status = "open";
    const row = await this.prisma.legalDeadline.update({
      where: { id },
      data: {
        ...data,
        ...(input.dueDate !== undefined
          ? { lastAlertedTier: null, lastAlertedAt: null }
          : {}),
      },
    });
    return toComputedDeadline(row);
  }

  /**
   * Tenant marks a deadline done. When the deadline recurs, the engine
   * creates the NEXT occurrence anchored to the confirmed due date
   * (source "computed") — this is computed, never invented: the anchor is
   * always a tenant-set date.
   */
  async markDeadlineDone(
    workspaceId: string,
    id: string,
  ): Promise<ComputedDeadline> {
    const existing = await this.prisma.legalDeadline.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) {
      throw new LegalError("UNKNOWN_DEADLINE", `No deadline: ${id}`);
    }
    const next = existing.dueDate
      ? nextDueDate(existing.dueDate, existing.recurrence as DeadlineRecurrence)
      : null;

    const row = await this.prisma.$transaction(async (tx) => {
      const done = await tx.legalDeadline.update({
        where: { id },
        data: { status: "done" },
      });
      if (next) {
        await tx.legalDeadline.create({
          data: {
            workspaceId,
            templateKey: existing.templateKey,
            title: existing.title,
            dueDate: next,
            recurrence: existing.recurrence,
            source: "computed",
            status: "open",
            note: null,
          },
        });
      }
      return done;
    });
    return toComputedDeadline(row);
  }

  async deleteDeadline(workspaceId: string, id: string): Promise<void> {
    const existing = await this.prisma.legalDeadline.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) {
      throw new LegalError("UNKNOWN_DEADLINE", `No deadline: ${id}`);
    }
    await this.prisma.legalDeadline.delete({ where: { id } });
  }

  /** Sweep port: every open deadline in the workspace. */
  async listOpenDeadlines(workspaceId: string) {
    const rows = await this.prisma.legalDeadline.findMany({
      where: { workspaceId, status: "open" },
    });
    return rows.map((r) => ({
      id: r.id,
      templateKey: r.templateKey,
      title: r.title,
      dueDate: r.dueDate,
      source: r.source as "tenant_set" | "computed",
      lastAlertedTier: isEscalationTier(r.lastAlertedTier)
        ? (r.lastAlertedTier as EscalationTier)
        : null,
    }));
  }

  /** Sweep port: record that a tier was emitted so it fires only once. */
  async recordAlertedTier(
    workspaceId: string,
    deadlineId: string,
    tier: EscalationTier,
    now: Date,
  ): Promise<void> {
    await this.prisma.legalDeadline.updateMany({
      where: { id: deadlineId, workspaceId },
      data: { lastAlertedTier: tier, lastAlertedAt: now },
    });
  }

  // ------------------------------------------------------------------
  // Slice 3: document vault
  // ------------------------------------------------------------------

  /**
   * Write one vault file through the EXISTING filesystem pipeline — the same
   * writeFile the /api/files route uses, so upload safety, the 25 MB cap,
   * and quota all apply unchanged. Files land under /files/legal/<docType>/.
   */
  private async writeVaultFile(opts: {
    workspaceId: string;
    userId: string;
    docType: LegalDocumentType;
    fileName: string;
    fileBytes: Buffer;
    mimeType?: string;
  }) {
    const logicalPath = `/files/legal/${opts.docType}/${safeFilename(opts.fileName || "file")}`;
    const check = normalizeLogicalPath(logicalPath);
    if (!check.ok) throw new LegalError("INVALID_PATH", check.reason);
    if (!logicalPath.startsWith("/files/legal/")) {
      throw new LegalError("INVALID_PATH", "Vault files must live under /files/legal/.");
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
   * Create a document with its first version. The expiry is tenant-set or
   * tenant-read only — never invented.
   */
  async createDocument(
    workspaceId: string,
    userId: string,
    input: {
      docType: LegalDocumentType;
      title: string;
      notes?: string | null;
      expiryDate?: string | null;
      expirySource?: LegalExpirySource | null;
      issuer?: string | null;
      fileName: string;
      fileBytes: Buffer;
      mimeType?: string;
    },
  ): Promise<ComputedDocumentDetail> {
    if (!isValidDocumentType(input.docType)) {
      throw new LegalError(
        "INVALID_DOC_TYPE",
        `docType must be one of: ${["formation", "contract", "license", "ein_letter", "policy", "other"].join(", ")}`,
      );
    }
    const title = input.title.trim();
    if (!title) {
      throw new LegalError("INVALID_TITLE", "Title is required.");
    }
    assertNonEmptyFile(input.fileBytes);
    // Guardrail: expiry is tenant-set or tenant-read only — never invented.
    const expiry = carryForwardExpiry(
      { expiryDate: input.expiryDate, expirySource: input.expirySource },
      null,
    );

    const file = await this.writeVaultFile({
      workspaceId,
      userId,
      docType: input.docType,
      fileName: input.fileName,
      fileBytes: input.fileBytes,
      mimeType: input.mimeType,
    });

    const doc = await this.prisma.$transaction(async (tx) => {
      const created = await tx.legalDocument.create({
        data: {
          workspaceId,
          docType: input.docType,
          title,
          notes: input.notes?.trim() || null,
        },
      });
      const plan = planNewVersion(null);
      const version = await tx.legalDocumentVersion.create({
        data: {
          documentId: created.id,
          versionNumber: plan.versionNumber,
          workspaceFileId: file.id,
          uploadedBy: userId,
          expiryDate: expiry.expiryDate ? new Date(expiry.expiryDate) : null,
          expirySource: expiry.expirySource,
          issuer: input.issuer?.trim() || null,
          supersedesVersionId: plan.supersedesVersionId,
        },
      });
      await tx.legalDocument.update({
        where: { id: created.id },
        data: { currentVersionId: version.id },
      });
      return created;
    });
    const detail = await this.getDocument(workspaceId, doc.id);
    if (!detail) {
      throw new LegalError("UNKNOWN_DOCUMENT", `No document: ${doc.id}`);
    }
    return detail;
  }

  /**
   * Upload a new version of an existing document. History is preserved: the
   * new row supersedes the previous current version, and
   * currentVersionId moves to the new row. Expiry/issuer carry forward from
   * the previous version unless the upload sets them explicitly.
   */
  async addVersion(
    workspaceId: string,
    userId: string,
    documentId: string,
    input: {
      expiryDate?: string | null;
      expirySource?: LegalExpirySource | null;
      issuer?: string | null;
      fileName: string;
      fileBytes: Buffer;
      mimeType?: string;
    },
  ): Promise<ComputedDocumentDetail> {
    const doc = await this.prisma.legalDocument.findFirst({
      where: { id: documentId, workspaceId },
      include: { currentVersion: true },
    });
    if (!doc) {
      throw new LegalError("UNKNOWN_DOCUMENT", `No document: ${documentId}`);
    }
    assertNonEmptyFile(input.fileBytes);
    const rawPrev = doc.currentVersion;
    const prev: PreviousVersion | null = rawPrev
      ? {
          id: rawPrev.id,
          versionNumber: rawPrev.versionNumber,
          expiryDate: rawPrev.expiryDate?.toISOString() ?? null,
          expirySource: isValidExpirySource(rawPrev.expirySource)
            ? rawPrev.expirySource
            : null,
          issuer: rawPrev.issuer,
        }
      : null;
    // New upload = new version row; history preserved via supersedes chain.
    const plan = planNewVersion(prev);
    // Expiry carries forward from the previous version unless the upload
    // sets or clears it — never invented.
    const expiry = carryForwardExpiry(
      { expiryDate: input.expiryDate, expirySource: input.expirySource },
      prev,
    );

    const file = await this.writeVaultFile({
      workspaceId,
      userId,
      docType: doc.docType as LegalDocumentType,
      fileName: input.fileName,
      fileBytes: input.fileBytes,
      mimeType: input.mimeType,
    });

    await this.prisma.$transaction(async (tx) => {
      const version = await tx.legalDocumentVersion.create({
        data: {
          documentId: doc.id,
          versionNumber: plan.versionNumber,
          workspaceFileId: file.id,
          uploadedBy: userId,
          expiryDate: expiry.expiryDate ? new Date(expiry.expiryDate) : null,
          expirySource: expiry.expirySource,
          issuer:
            input.issuer !== undefined
              ? input.issuer?.trim() || null
              : (prev?.issuer ?? null),
          supersedesVersionId: plan.supersedesVersionId,
        },
      });
      await tx.legalDocument.update({
        where: { id: doc.id },
        data: { currentVersionId: version.id },
      });
    });

    const detail = await this.getDocument(workspaceId, doc.id);
    if (!detail) {
      throw new LegalError("UNKNOWN_DOCUMENT", `No document: ${doc.id}`);
    }
    return detail;
  }

  /** The tenant's vault: documents with their current version and expiry tier. */
  async listDocuments(
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<ComputedDocument[]> {
    const rows = await this.prisma.legalDocument.findMany({
      where: { workspaceId },
      include: {
        currentVersion: {
          include: {
            workspaceFile: true,
            supersedes: { select: { versionNumber: true } },
          },
        },
        _count: { select: { versions: true } },
      },
      orderBy: { updatedAt: "desc" },
    });
    const docs = rows.map((r) => toComputedDocument(r, now));
    docs.sort((a, b) => {
      const order = (t: ExpiryTier | null) =>
        t === null
          ? 99
          : (["overdue", "date_needed", "due_7", "due_30", "due_90"] as const).indexOf(t);
      if (a.tier !== b.tier) return order(a.tier) - order(b.tier);
      const da = a.currentVersion?.expiryDate
        ? new Date(a.currentVersion.expiryDate).getTime()
        : Number.POSITIVE_INFINITY;
      const db = b.currentVersion?.expiryDate
        ? new Date(b.currentVersion.expiryDate).getTime()
        : Number.POSITIVE_INFINITY;
      return da - db;
    });
    return docs;
  }

  /** One document with its full version history (newest first). */
  async getDocument(
    workspaceId: string,
    id: string,
    now: Date = new Date(),
  ): Promise<ComputedDocumentDetail | null> {
    const row = await this.prisma.legalDocument.findFirst({
      where: { id, workspaceId },
      include: {
        currentVersion: {
          include: {
            workspaceFile: true,
            supersedes: { select: { versionNumber: true } },
          },
        },
        versions: {
          include: {
            workspaceFile: true,
            supersedes: { select: { versionNumber: true } },
          },
          orderBy: { versionNumber: "desc" },
        },
      },
    });
    if (!row) return null;
    return {
      ...toComputedDocument(row, now),
      versions: row.versions.map(toComputedVersion),
    };
  }

  /**
   * Tenant edits document metadata. Title/notes/docType edit the document;
   * expiryDate/issuer edit the CURRENT version (history rows are immutable).
   * A changed expiry resets the escalation ladder — like deadline re-dates.
   */
  async updateDocument(
    workspaceId: string,
    id: string,
    input: {
      title?: string;
      notes?: string | null;
      docType?: LegalDocumentType;
      expiryDate?: string | null;
      expirySource?: LegalExpirySource | null;
      issuer?: string | null;
    },
  ): Promise<ComputedDocumentDetail> {
    const doc = await this.prisma.legalDocument.findFirst({
      where: { id, workspaceId },
      include: { currentVersion: true },
    });
    if (!doc) {
      throw new LegalError("UNKNOWN_DOCUMENT", `No document: ${id}`);
    }
    const data: {
      title?: string;
      notes?: string | null;
      docType?: LegalDocumentType;
    } = {};
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title) throw new LegalError("INVALID_TITLE", "Title cannot be empty.");
      data.title = title;
    }
    if (input.notes !== undefined) data.notes = input.notes?.trim() || null;
    if (input.docType !== undefined) {
      if (!isValidDocumentType(input.docType)) {
        throw new LegalError("INVALID_DOC_TYPE", "docType must be a known document type.");
      }
      data.docType = input.docType;
    }

    const versionData: {
      expiryDate?: Date | null;
      expirySource?: LegalExpirySource | null;
      issuer?: string | null;
      lastAlertedTier?: null;
      lastAlertedAt?: null;
    } = {};
    if (input.expiryDate !== undefined) {
      const prevExpiry: PreviousVersion | null = doc.currentVersion
        ? {
            id: doc.currentVersion.id,
            versionNumber: doc.currentVersion.versionNumber,
            expiryDate: doc.currentVersion.expiryDate?.toISOString() ?? null,
            expirySource: isValidExpirySource(doc.currentVersion.expirySource)
              ? doc.currentVersion.expirySource
              : null,
            issuer: doc.currentVersion.issuer,
          }
        : null;
      const expiry = carryForwardExpiry(
        { expiryDate: input.expiryDate, expirySource: input.expirySource },
        prevExpiry,
      );
      versionData.expiryDate = expiry.expiryDate ? new Date(expiry.expiryDate) : null;
      versionData.expirySource = expiry.expirySource;
      // A changed expiry resets the escalation ladder (see deadline re-dates).
      versionData.lastAlertedTier = null;
      versionData.lastAlertedAt = null;
    }
    if (input.issuer !== undefined) {
      versionData.issuer = input.issuer?.trim() || null;
    }

    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(data).length > 0) {
        await tx.legalDocument.update({ where: { id }, data });
      }
      if (doc.currentVersionId && Object.keys(versionData).length > 0) {
        await tx.legalDocumentVersion.update({
          where: { id: doc.currentVersionId },
          data: versionData,
        });
      }
    });

    const detail = await this.getDocument(workspaceId, id);
    if (!detail) {
      throw new LegalError("UNKNOWN_DOCUMENT", `No document: ${id}`);
    }
    return detail;
  }

  /** Tenant removes a document and its version history (uploaded files stay
   *  in /files/legal/ — the files trash flow owns their cleanup). */
  async deleteDocument(workspaceId: string, id: string): Promise<void> {
    const existing = await this.prisma.legalDocument.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) {
      throw new LegalError("UNKNOWN_DOCUMENT", `No document: ${id}`);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.legalDocumentVersion.deleteMany({ where: { documentId: id } });
      await tx.legalDocument.delete({ where: { id } });
    });
  }

  /** Sweep port: the current version of every document in the workspace.
   *  Older versions are history and never alert. */
  async listCurrentVersions(workspaceId: string) {
    const rows = await this.prisma.legalDocument.findMany({
      where: { workspaceId, currentVersionId: { not: null } },
      include: { currentVersion: true },
    });
    return rows.map((r) => ({
      id: r.currentVersion!.id,
      documentId: r.id,
      title: r.title,
      docType: r.docType as LegalDocumentType,
      versionNumber: r.currentVersion!.versionNumber,
      expiryDate: r.currentVersion!.expiryDate,
      lastAlertedTier: isEscalationTier(r.currentVersion!.lastAlertedTier)
        ? (r.currentVersion!.lastAlertedTier as EscalationTier)
        : null,
    }));
  }

  /** Sweep port: record that a tier was emitted so it fires only once. */
  async recordDocumentAlertedTier(
    workspaceId: string,
    versionId: string,
    tier: EscalationTier,
    now: Date,
  ): Promise<void> {
    await this.prisma.legalDocumentVersion.updateMany({
      where: { id: versionId, document: { workspaceId } },
      data: { lastAlertedTier: tier, lastAlertedAt: now },
    });
  }

  // ------------------------------------------------------------------
  // Slice 4: change radar
  // ------------------------------------------------------------------

  /** Idempotent seed: validate, then upsert every change by key. */
  async seedRadarChanges(): Promise<{ seeded: number }> {
    validateSeedChanges(REGULATION_CHANGE_SEEDS);
    for (const c of REGULATION_CHANGE_SEEDS) {
      await this.prisma.regulationChange.upsert({
        where: { key: c.key },
        create: {
          key: c.key,
          industries: c.industries,
          jurisdictions: c.jurisdictions,
          category: c.category,
          title: c.title,
          plainEnglishSummary: c.plainEnglishSummary,
          sourceRef: c.sourceRef,
          effectiveDate: c.effectiveDate ? new Date(c.effectiveDate) : null,
          publishedAt: new Date(c.publishedAt),
          seedFlag: c.seedFlag,
        },
        update: {
          industries: c.industries,
          jurisdictions: c.jurisdictions,
          category: c.category,
          title: c.title,
          plainEnglishSummary: c.plainEnglishSummary,
          sourceRef: c.sourceRef,
          effectiveDate: c.effectiveDate ? new Date(c.effectiveDate) : null,
          publishedAt: new Date(c.publishedAt),
          seedFlag: c.seedFlag,
          version: { increment: 1 },
        },
      });
    }
    return { seeded: REGULATION_CHANGE_SEEDS.length };
  }

  /** All seeded changes (read-only list, untriaged). */
  async listRadarChanges(): Promise<SeedRegulationChange[]> {
    const rows = await this.prisma.regulationChange.findMany({
      orderBy: [{ publishedAt: "desc" }, { title: "asc" }],
    });
    return rows.map(toSeedChange);
  }

  /**
   * The tenant's triaged radar: every change with a relevance verdict for
   * their LegalProfile plus their reviewed/dismissed state merged by key.
   * Returns profile: null when the tenant has no legal profile yet.
   */
  async listRadar(
    workspaceId: string,
  ): Promise<{
    profile: { industry: string; jurisdictions: string[] } | null;
    items: TriagedChange[];
  }> {
    const profile = await this.getProfile(workspaceId);
    if (!profile) return { profile: null, items: [] };
    const changes = await this.listRadarChanges();
    const rows = await this.prisma.legalRadarTriage.findMany({
      where: { workspaceId },
    });
    const triageRows: ChangeTriageRow[] = rows.map((r) => ({
      changeKey: r.changeKey,
      status: r.status as RadarTriageStatus,
    }));
    const items = triageChanges(
      changes,
      { industry: profile.industry, jurisdictions: profile.jurisdictions },
      triageRows,
    );
    return {
      profile: { industry: profile.industry, jurisdictions: profile.jurisdictions },
      items,
    };
  }

  /** Tenant marks a change reviewed or dismissed. */
  async setRadarTriage(
    workspaceId: string,
    key: string,
    status: RadarTriageStatus,
  ): Promise<TriagedChange[]> {
    if (!RADAR_TRIAGE_STATUSES.includes(status)) {
      throw new LegalError(
        "INVALID_TRIAGE_STATUS",
        `Status must be one of: ${RADAR_TRIAGE_STATUSES.join(", ")}`,
      );
    }
    const change = await this.prisma.regulationChange.findUnique({
      where: { key },
    });
    if (!change) {
      throw new LegalError("UNKNOWN_CHANGE", `No regulation change: ${key}`);
    }
    await this.prisma.legalRadarTriage.upsert({
      where: { workspaceId_changeKey: { workspaceId, changeKey: key } },
      create: { workspaceId, changeKey: key, status },
      update: { status },
    });
    return (await this.listRadar(workspaceId)).items;
  }

  /**
   * "Add to my obligations": materialize a radar change as a tenant
   * obligation. Wires into slice 1 by creating a radar-prefixed
   * ObligationTemplate row (industries/jurisdictions preserved, so profile
   * re-saves keep it via the same materialization path) plus an open
   * Obligation row. The change must be relevant to the tenant's profile —
   * "does this affect me" triage gates the conversion.
   */
  async addChangeToObligations(
    workspaceId: string,
    key: string,
  ): Promise<ComputedObligation> {
    const row = await this.prisma.regulationChange.findUnique({
      where: { key },
    });
    if (!row) {
      throw new LegalError("UNKNOWN_CHANGE", `No regulation change: ${key}`);
    }
    const profile = await this.getProfile(workspaceId);
    if (!profile) {
      throw new LegalError("NO_PROFILE", "Save a legal profile before adding obligations.");
    }
    const change = toSeedChange(row);
    if (!changeAppliesToProfile(change, profile)) {
      throw new LegalError(
        "NOT_RELEVANT",
        "This change does not match your industry or jurisdictions, so it cannot become an obligation.",
      );
    }
    const template = changeToObligationSeed(change);
    validateSeedTemplates([template]);

    await this.prisma.$transaction(async (tx) => {
      await tx.obligationTemplate.upsert({
        where: { key: template.key },
        create: {
          key: template.key,
          industries: template.industries,
          jurisdictions: template.jurisdictions,
          category: template.category,
          title: template.title,
          description: template.description,
          sourceRef: template.sourceRef,
          renewalCadence: template.renewalCadence,
          needsReview: template.needsReview,
        },
        // Never overwrite an existing radar template's content from here —
        // the seed feed is the source of truth on re-seed.
        update: {},
      });
      // Preserve an existing tenant status if the row already exists.
      await tx.obligation.upsert({
        where: {
          workspaceId_templateKey: { workspaceId, templateKey: template.key },
        },
        create: { workspaceId, templateKey: template.key, status: "open" },
        update: {},
      });
    });

    const obligations = await this.listObligations(workspaceId);
    const created = obligations.find((o) => o.key === template.key);
    if (!created) {
      throw new LegalError(
        "OBLIGATION_NOT_CREATED",
        "The obligation row could not be read back after creation.",
      );
    }
    return created;
  }
}

export type DeadlineStatus = "open" | "done" | "dismissed";

type RegulationChangeRow = {
  key: string;
  title: string;
  plainEnglishSummary: string;
  industries: string[];
  jurisdictions: string[];
  category: string;
  sourceRef: string;
  effectiveDate: Date | null;
  publishedAt: Date;
  seedFlag: boolean;
};

/** DB row → seed shape the pure engine works on. */
function toSeedChange(row: RegulationChangeRow): SeedRegulationChange {
  return {
    key: row.key,
    title: row.title,
    plainEnglishSummary: row.plainEnglishSummary,
    industries: row.industries,
    jurisdictions: row.jurisdictions,
    category: row.category as RegulationChangeCategory,
    sourceRef: row.sourceRef,
    effectiveDate: row.effectiveDate ? row.effectiveDate.toISOString() : null,
    publishedAt: row.publishedAt.toISOString(),
    seedFlag: row.seedFlag,
  };
}

export interface ComputedDeadline {
  id: string;
  templateKey: string;
  title: string;
  dueDate: string | null;
  recurrence: DeadlineRecurrence;
  source: DeadlineSource;
  status: DeadlineStatus;
  note: string | null;
  lastAlertedTier: EscalationTier | null;
  /** Escalation tier at read time; null = more than 90 days out. */
  tier: EscalationTier | null;
  daysUntilDue: number | null;
}

function isEscalationTier(value: unknown): value is EscalationTier {
  return (
    typeof value === "string" &&
    (["date_needed", "due_90", "due_30", "due_7", "overdue"] as const).includes(
      value as EscalationTier,
    )
  );
}

type LegalDeadlineRow = {
  id: string;
  templateKey: string;
  title: string;
  dueDate: Date | null;
  recurrence: string;
  source: string;
  status: string;
  note: string | null;
  lastAlertedTier: string | null;
};

function toComputedDeadline(
  row: LegalDeadlineRow,
  now: Date = new Date(),
): ComputedDeadline {
  const tier = tierForDeadline(row.dueDate, now);
  return {
    id: row.id,
    templateKey: row.templateKey,
    title: row.title,
    dueDate: row.dueDate ? row.dueDate.toISOString() : null,
    recurrence: row.recurrence as DeadlineRecurrence,
    source: row.source as DeadlineSource,
    status: row.status as DeadlineStatus,
    note: row.note,
    lastAlertedTier: isEscalationTier(row.lastAlertedTier)
      ? (row.lastAlertedTier as EscalationTier)
      : null,
    tier,
    daysUntilDue: row.dueDate ? daysUntilDue(row.dueDate, now) : null,
  };
}

/**
 * Parse a tenant-supplied date. null/undefined = "date needed" (kept as
 * null). Anything unparseable is rejected — never coerced into a guess.
 */
function parseOptionalDate(
  value: unknown,
  field: string,
): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new LegalError("INVALID_DATE", `${field} must be an ISO date string or null.`);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new LegalError("INVALID_DATE", `${field} must be a valid date.`);
  }
  return d;
}

// ------------------------------------------------------------------
// Slice 3: document vault helpers
// ------------------------------------------------------------------

export interface ComputedDocumentVersion {
  id: string;
  versionNumber: number;
  filename: string;
  logicalPath: string;
  mimeType: string;
  sizeBytes: number;
  workspaceFileId: string;
  uploadedBy: string;
  uploadedAt: string;
  expiryDate: string | null;
  expirySource: LegalExpirySource | null;
  issuer: string | null;
  supersedesVersionNumber: number | null;
}

export interface ComputedDocument {
  id: string;
  docType: LegalDocumentType;
  title: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  versionCount: number;
  currentVersion: ComputedDocumentVersion | null;
  /** Escalation tier of the current version's expiry; null = >90 days out. */
  tier: ExpiryTier | null;
  daysUntilExpiry: number | null;
}

export interface ComputedDocumentDetail extends ComputedDocument {
  /** Full version history, newest first. */
  versions: ComputedDocumentVersion[];
}

function assertNonEmptyFile(bytes: unknown): asserts bytes is Buffer {
  if (!bytes || !(bytes instanceof Buffer) || bytes.length === 0) {
    throw new LegalError("EMPTY_FILE", "Attach a file — it cannot be empty.");
  }
}

type VaultVersionRow = {
  id: string;
  versionNumber: number;
  uploadedBy: string;
  uploadedAt: Date;
  expiryDate: Date | null;
  expirySource: string | null;
  issuer: string | null;
  workspaceFileId: string;
  supersedes: { versionNumber: number } | null;
  workspaceFile: {
    filename: string;
    logicalPath: string;
    mimeType: string;
    sizeBytes: number;
  };
};

function toComputedVersion(row: VaultVersionRow): ComputedDocumentVersion {
  return {
    id: row.id,
    versionNumber: row.versionNumber,
    filename: row.workspaceFile.filename,
    logicalPath: row.workspaceFile.logicalPath,
    mimeType: row.workspaceFile.mimeType,
    sizeBytes: row.workspaceFile.sizeBytes,
    workspaceFileId: row.workspaceFileId,
    uploadedBy: row.uploadedBy,
    uploadedAt: row.uploadedAt.toISOString(),
    expiryDate: row.expiryDate ? row.expiryDate.toISOString() : null,
    expirySource: isValidExpirySource(row.expirySource)
      ? row.expirySource
      : null,
    issuer: row.issuer,
    supersedesVersionNumber: row.supersedes?.versionNumber ?? null,
  };
}

type VaultDocRow = {
  id: string;
  docType: string;
  title: string;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  currentVersion: VaultVersionRow | null;
};

function toComputedDocument(
  row: VaultDocRow & { _count?: { versions: number }; versions?: VaultVersionRow[] },
  now: Date = new Date(),
): ComputedDocument {
  const current = row.currentVersion ? toComputedVersion(row.currentVersion) : null;
  const expiryDate = row.currentVersion?.expiryDate ?? null;
  const tier = tierForExpiry(expiryDate, now);
  return {
    id: row.id,
    docType: row.docType as LegalDocumentType,
    title: row.title,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    versionCount: row._count?.versions ?? row.versions?.length ?? (current ? 1 : 0),
    currentVersion: current,
    tier,
    daysUntilExpiry: expiryDate ? daysUntilExpiry(expiryDate, now) : null,
  };
}
