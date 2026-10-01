// Marketr — Legal/Compliance slice 1: Prisma store.
// Spec: BUSINESS-OS-FEATURE-SPECS.md §4.
//
// LegalProfile is one row per workspace (upsert). ObligationTemplate rows are
// seed data (idempotent upsert by key). Obligation rows are materialized per
// tenant when the profile is saved: templates that match the profile get an
// "open" row, rows whose template no longer matches are removed, and existing
// tenant status (snoozed/dismissed/done) is preserved across re-saves.
// The computed checklist itself always comes from the pure engine in
// obligations.ts — the DB holds profiles, templates, and overrides only.

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
}
