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

// Invoice-style line (mirrors lib/ops/entities.ts invoice lines).
const docLine = z.object({
  description: z.string().min(1).max(500),
  qty: z.number().int().min(1).max(100_000),
  priceCents: z.number().int().min(0).max(1_000_000_000),
  taxRateId: id.optional(),
});

export const recurringInvoiceDef: OpsEntityDef = {
  slug: "recurring-invoices",
  label: "Recurring invoice",
  delegate: "opsRecurringInvoice",
  createSchema: z.object({
    customerId: id.optional(),
    lineItems: z.array(docLine).min(1).max(200),
    taxCents: cents.default(0),
    cadence: z.enum(["weekly", "monthly", "quarterly", "yearly"]),
    intervalCount: z.number().int().min(1).max(24).default(1),
    // First draft date (ISO); default now. The cron drafts on/after it.
    startAt: isoDate.optional(),
    endAt: isoDate.optional(),
    dueDays: z.number().int().min(0).max(365).default(30),
  }),
  patchSchema: z.object({
    customerId: id.nullable().optional(),
    lineItems: z.array(docLine).min(1).max(200).optional(),
    taxCents: cents.optional(),
    cadence: z.enum(["weekly", "monthly", "quarterly", "yearly"]).optional(),
    intervalCount: z.number().int().min(1).max(24).optional(),
    nextRunAt: isoDate.optional(),
    endAt: isoDate.nullable().optional(),
    dueDays: z.number().int().min(0).max(365).optional(),
    active: z.boolean().optional(),
  }),
  patchable: true,
  filterable: ["customerId"],
  gatedTransitions: [],
  summarize: (r) => `recurring invoice ${r.id ?? "(new)"} ${r.cadence}${r.active === false ? " (paused)" : ""}`,
};

const quoteLine = docLine.extend({ sku: z.string().max(64).optional() });

export const quoteDef: OpsEntityDef = {
  slug: "quotes",
  label: "Quote",
  delegate: "opsQuote",
  createSchema: z.object({
    customerId: id.optional(),
    customerEmail: z.string().email().max(320).optional(),
    lineItems: z.array(quoteLine).min(1).max(200),
    taxCents: cents.default(0),
    validUntil: isoDate.optional(),
    notes: z.string().max(4000).optional(),
  }),
  patchSchema: z.object({
    customerId: id.nullable().optional(),
    customerEmail: z.string().email().max(320).nullable().optional(),
    lineItems: z.array(quoteLine).min(1).max(200).optional(),
    taxCents: cents.optional(),
    validUntil: isoDate.nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
    status: z.enum(["sent", "accepted", "declined"]).optional(),
  }),
  patchable: true,
  filterable: ["status", "customerId"],
  gatedTransitions: [
    // Sending prices to a customer is outbound money comms — gated like invoices.
    { field: "status", to: ["sent"], slug: "OPS_QUOTE_SEND", label: "Send quote" },
  ],
  statusTransitions: {
    draft: ["sent"],
    sent: ["accepted", "declined", "expired"],
    accepted: [],
    declined: [],
    expired: [],
  },
  summarize: (r) => `quote ${r.number ?? r.id ?? "(new)"} → ${r.status ?? "draft"} (${r.totalCents ?? "?"}c)`,
};

export const vendorDef: OpsEntityDef = {
  slug: "vendors",
  label: "Vendor",
  delegate: "opsVendor",
  createSchema: z.object({
    name: z.string().min(1).max(200),
    email: z.string().email().max(320).optional(),
    phone: z.string().max(64).optional(),
    taxId: z.string().max(64).optional(),
    address: z.string().max(2000).optional(),
    paymentTermsDays: z.number().int().min(0).max(365).default(30),
    defaultAccountId: id.optional(),
    leadId: id.optional(),
    notes: z.string().max(4000).optional(),
  }),
  patchSchema: z.object({
    name: z.string().min(1).max(200).optional(),
    email: z.string().email().max(320).nullable().optional(),
    phone: z.string().max(64).nullable().optional(),
    taxId: z.string().max(64).nullable().optional(),
    address: z.string().max(2000).nullable().optional(),
    paymentTermsDays: z.number().int().min(0).max(365).optional(),
    defaultAccountId: id.nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
    active: z.boolean().optional(),
  }),
  patchable: true,
  filterable: [],
  gatedTransitions: [],
  summarize: (r) => `vendor "${r.name}"`,
};

const billLine = docLine.extend({ accountId: id.optional() });

export const vendorBillDef: OpsEntityDef = {
  slug: "vendor-bills",
  label: "Vendor bill",
  delegate: "opsVendorBill",
  createSchema: z.object({
    vendorId: id.optional(),
    purchaseOrderId: id.optional(),
    vendorRef: z.string().max(100).optional(),
    lineItems: z.array(billLine).min(1).max(200),
    taxCents: cents.default(0),
    billDate: isoDate.optional(),
    dueAt: isoDate.optional(),
    notes: z.string().max(4000).optional(),
  }),
  patchSchema: z.object({
    vendorId: id.nullable().optional(),
    vendorRef: z.string().max(100).nullable().optional(),
    lineItems: z.array(billLine).min(1).max(200).optional(),
    taxCents: cents.optional(),
    dueAt: isoDate.nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
    // open = post to accounts payable; paying goes through /pay (gated).
    status: z.enum(["open", "cancelled"]).optional(),
  }),
  patchable: true,
  filterable: ["status", "vendorId", "purchaseOrderId"],
  gatedTransitions: [{ field: "status", to: ["cancelled"], slug: "OPS_RECORD_DELETE", label: "Cancel vendor bill" }],
  statusTransitions: {
    draft: ["open", "cancelled"],
    open: ["cancelled"],
    paid: [],
    cancelled: [],
  },
  summarize: (r) => `vendor bill ${r.number ?? r.id ?? "(new)"} → ${r.status ?? "draft"} (${r.totalCents ?? "?"}c)`,
};

export const FINANCE_ENTITIES: OpsEntityDef[] = [
  accountDef,
  taxRateDef,
  journalEntryDef,
  recurringInvoiceDef,
  quoteDef,
  vendorDef,
  vendorBillDef,
];
