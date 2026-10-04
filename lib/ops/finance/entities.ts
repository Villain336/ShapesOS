// ShapesOS — Phase 10 (finance): the finance entities on the Ops DocType
// convention. Each def plugs into OPS_ENTITIES (lib/ops/entities.ts), so the
// generic GET/POST/PATCH /api/ops/{entity} route, workspace scoping, audit
// and the money gate apply by construction. Server-side behaviour (totals,
// numbering, posting) lives in lib/ops/finance/hooks.ts.
//
// PURE: zod only — no server imports (lib/ops/entities.ts imports this).

import { z } from "zod";
import type { OpsEntityDef } from "../entities";

const MAX_CENTS = 2_147_483_647;
const cents = z.number().int().min(0).max(MAX_CENTS);
const id = z.string().min(1).max(64);
const isoDate = z.string().max(64);

const accountType = z.enum(["asset", "liability", "equity", "income", "expense"]);

export const accountDef: OpsEntityDef = {
  slug: "accounts",
  label: "Account",
  delegate: "opsAccount",
  createSchema: z.object({
    code: z.string().min(1).max(16).regex(/^[0-9A-Za-z.-]+$/, "Use letters, digits, dots or dashes"),
    name: z.string().min(1).max(200),
    type: accountType,
    parentId: id.optional(),
  }),
  // The code and type are fixed once created (reports and history key on
  // them); rename, re-parent or deactivate instead.
  patchSchema: z
    .object({
      name: z.string().min(1).max(200).optional(),
      parentId: id.nullable().optional(),
      active: z.boolean().optional(),
    })
    .strict(),
  patchable: true,
  filterable: ["type"],
  gatedTransitions: [],
  summarize: (r) => `account ${r.code} "${r.name}" (${r.type})`,
};

export const taxRateDef: OpsEntityDef = {
  slug: "tax-rates",
  label: "Tax rate",
  delegate: "opsTaxRate",
  createSchema: z.object({
    name: z.string().min(1).max(100),
    // Basis points: 825 = 8.25%.
    rateBps: z.number().int().min(0).max(10_000),
    salesAccountId: id.optional(),
    purchaseAccountId: id.optional(),
  }),
  // The rate itself is immutable (issued documents were taxed with it):
  // create a new rate and deactivate the old one.
  patchSchema: z
    .object({
      name: z.string().min(1).max(100).optional(),
      salesAccountId: id.nullable().optional(),
      purchaseAccountId: id.nullable().optional(),
      active: z.boolean().optional(),
    })
    .strict(),
  patchable: true,
  filterable: [],
  gatedTransitions: [],
  summarize: (r) => `tax rate "${r.name}" ${(Number(r.rateBps) / 100).toFixed(2)}%`,
};

const journalLineSchema = z.object({
  accountId: id,
  debitCents: cents.default(0),
  creditCents: cents.default(0),
  memo: z.string().max(500).optional(),
});

export const journalEntryDef: OpsEntityDef = {
  slug: "journal-entries",
  label: "Journal entry",
  delegate: "opsJournalEntry",
  createSchema: z.object({
    entryDate: isoDate.optional(),
    memo: z.string().max(2000).optional(),
    lines: z.array(journalLineSchema).min(2).max(100),
  }),
  patchSchema: z.object({}),
  // Append-only ledger: corrections are reversal entries, never edits.
  patchable: false,
  filterable: ["sourceType", "sourceId"],
  gatedTransitions: [],
  // A manual entry moves the books: always an approved gated write.
  createGate: "OPS_JOURNAL_POST",
  summarize: (r) => `journal entry ${r.id ?? "(new)"} (${r.totalCents ?? "?"}c)${r.memo ? ` — ${String(r.memo).slice(0, 80)}` : ""}`,
};

export const FINANCE_ENTITIES: OpsEntityDef[] = [accountDef, taxRateDef, journalEntryDef];
