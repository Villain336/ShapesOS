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
import { computeObligations, validateSeedTemplates } from "./obligations";
import { OBLIGATION_TEMPLATES } from "./seeds";
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
}

export type DeadlineStatus = "open" | "done" | "dismissed";

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
