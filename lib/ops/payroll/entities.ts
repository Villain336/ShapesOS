// ShapesOS — Phase 12 (people): the payroll entities on the Ops DocType
// convention (spread into OPS_ENTITIES), so the generic /api/ops/{entity}
// route, workspace scoping and audit apply by construction. Salaries, tax
// profiles and payslips are ADMIN-only (readRole / writeRole).
//
// Pay-run status never moves through PATCH: compute / approve / post /
// cancel are POST /api/ops/pay-runs/{id}/{action} (lib/ops/payroll/runs.ts);
// approving and posting are gated Tier-3 money writes. Payslips are only
// ever written by computing a run.
//
// PURE: zod only — server rules are lazy-imported hooks.

import { z } from "zod";
import type { OpsEntityDef } from "../entities";

const MAX_CENTS = 2_147_483_647;
const cents = z.number().int().min(0).max(MAX_CENTS);
const id = z.string().min(1).max(64);
const isoDay = z
  .string()
  .max(64)
  .refine((v) => !Number.isNaN(new Date(v).getTime()), { message: "must be an ISO-8601 date" });

const payType = z.enum(["salary", "hourly"]);
const payFrequency = z.enum(["weekly", "biweekly", "semimonthly", "monthly"]);
const filingStatus = z.enum(["single", "married_jointly", "head_of_household"]);
const stateCode = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "use a two-letter state code");
// Components are validated by lib/ops/payroll/rules.ts parseComponents.
const components = z.array(z.record(z.string(), z.unknown())).max(30);

const lazyAdmin = () => import("./admin");

export const salaryStructureDef: OpsEntityDef = {
  slug: "salary-structures",
  label: "Salary structure",
  delegate: "opsSalaryStructure",
  createSchema: z.object({
    name: z.string().trim().min(1).max(200),
    payType: payType.default("salary"),
    payFrequency: payFrequency.default("biweekly"),
    annualSalaryCents: cents.optional(),
    hourlyRateCents: cents.optional(),
    overtimeEnabled: z.boolean().default(true),
    overtimeThresholdMinutes: z.number().int().min(60).max(10_080).default(2400),
    overtimeMultiplierBps: z.number().int().min(10_000).max(30_000).default(15_000),
    components: components.default([]),
    country: z.string().trim().toUpperCase().length(2).default("US"),
  }),
  patchSchema: z
    .object({
      name: z.string().trim().min(1).max(200).optional(),
      payFrequency: payFrequency.optional(),
      annualSalaryCents: cents.nullable().optional(),
      hourlyRateCents: cents.nullable().optional(),
      overtimeEnabled: z.boolean().optional(),
      overtimeThresholdMinutes: z.number().int().min(60).max(10_080).optional(),
      overtimeMultiplierBps: z.number().int().min(10_000).max(30_000).optional(),
      components: components.optional(),
      active: z.boolean().optional(),
    })
    .strict(),
  patchable: true,
  filterable: ["payType", "country"],
  gatedTransitions: [],
  readRole: "admin",
  writeRole: "admin",
  summarize: (r) => `salary structure "${r.name}" (${r.payType}, ${r.payFrequency})`,
  hooks: {
    create: async (tx, a, b) => (await lazyAdmin()).createStructureRow(tx, a, b),
    patch: async (tx, a, i, p, e) => (await lazyAdmin()).patchStructureRow(tx, a, i, p, e),
  },
};

const assignmentFields = {
  annualSalaryCents: cents.nullable().optional(),
  hourlyRateCents: cents.nullable().optional(),
  filingStatus: filingStatus.optional(),
  w4Step2: z.boolean().optional(),
  dependentsCreditCents: cents.optional(),
  otherIncomeCents: cents.optional(),
  deductionsCents: cents.optional(),
  extraWithholdingCents: cents.optional(),
  stateCode: stateCode.nullable().optional(),
  stateRateBps: z.number().int().min(0).max(2000).nullable().optional(),
};

export const salaryAssignmentDef: OpsEntityDef = {
  slug: "salary-assignments",
  label: "Salary assignment",
  delegate: "opsSalaryAssignment",
  createSchema: z.object({
    memberId: id,
    structureId: id,
    effectiveFrom: isoDay,
    effectiveTo: isoDay.optional(),
    ...assignmentFields,
  }),
  // The structure and start date are fixed: end this assignment
  // (effectiveTo) and start a new one for a change of structure or pay.
  patchSchema: z.object({ effectiveTo: isoDay.nullable().optional(), ...assignmentFields }).strict(),
  patchable: true,
  filterable: ["memberId", "structureId"],
  gatedTransitions: [],
  readRole: "admin",
  writeRole: "admin",
  summarize: (r) => `salary assignment ${r.id ?? "(new)"}: member ${r.memberId} → structure ${r.structureId} from ${String(r.effectiveFrom ?? "").slice(0, 10)}`,
  hooks: {
    create: async (tx, a, b) => (await lazyAdmin()).createAssignmentRow(tx, a, b),
    patch: async (tx, a, i, p, e) => (await lazyAdmin()).patchAssignmentRow(tx, a, i, p, e),
  },
};

export const payRunDef: OpsEntityDef = {
  slug: "pay-runs",
  label: "Pay run",
  delegate: "opsPayRun",
  createSchema: z.object({
    periodStart: isoDay,
    periodEnd: isoDay,
    payDate: isoDay,
    notes: z.string().max(4000).optional(),
  }),
  patchSchema: z.object({ notes: z.string().max(4000).nullable().optional() }).strict(),
  patchable: true,
  filterable: ["status"],
  gatedTransitions: [],
  readRole: "admin",
  writeRole: "admin",
  summarize: (r) => `pay run ${r.number ?? r.id ?? "(new)"} ${String(r.periodStart ?? "").slice(0, 10)}…${String(r.periodEnd ?? "").slice(0, 10)} → ${r.status ?? "draft"} (net ${r.netCents ?? 0}c)`,
  hooks: {
    create: async (tx, a, b) => (await import("./runs")).createPayRunRow(tx, a, b),
    patch: async (tx, a, i, p, e) => (await import("./runs")).patchPayRunRow(tx, a, i, p, e),
  },
};

export const payslipDef: OpsEntityDef = {
  slug: "payslips",
  label: "Payslip",
  delegate: "opsPayslip",
  createSchema: z.object({ payRunId: id }).strict(),
  patchSchema: z.object({}),
  // Written only by computing a pay run; frozen once the run is approved.
  patchable: false,
  filterable: ["payRunId", "memberId"],
  gatedTransitions: [],
  readRole: "admin",
  writeRole: "admin",
  summarize: (r) => `payslip ${r.id ?? "(new)"} for ${r.memberName ?? r.memberId} (net ${r.netCents ?? 0}c)`,
  hooks: {
    create: async () => {
      const { OpsError } = await import("../doctype");
      throw new OpsError(405, "Payslips are created by computing a pay run (POST /api/ops/pay-runs/{id}/compute)");
    },
  },
};

export const PAYROLL_ENTITIES: OpsEntityDef[] = [salaryStructureDef, salaryAssignmentDef, payRunDef, payslipDef];
