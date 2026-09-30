// Marketr — Phase 17 slice 1: the DocType-style entity registry.
//
// The load-bearing idea (borrowed as a PATTERN from ERPNext's DocType,
// clean-room — no ERPNext code, schema, or UI text exists in this repo):
// every business entity is schema + auto-generated REST API + permissions
// by construction. The agent doesn't learn five APIs; it learns one
// convention: GET/POST/PATCH /api/ops/{entity}.
//
// An entity plugs into the convention by adding ONE entry to OPS_ENTITIES:
//   - slug: the URL segment (/api/ops/invoices)
//   - delegate: the Prisma delegate key (opsInvoice)
//   - createSchema / patchSchema: zod validation (the API contract)
//   - patchable: false for immutable ledgers (inventory txns, payments)
//   - gatedTransitions: PATCH moves that hit money → Phase 14 gate
//   - summarize: the one-line audit summary
//
// Money law (locked): amounts are integer minor units (cents); totals are
// server-computed from line items, never trusted from the client.

import { z } from "zod";

export interface OpsGatedTransition {
  /** The PATCH field whose move to one of `to` is a gated write. */
  field: string;
  to: string[];
  /** Phase 14 money-action slug (lib/ops/gate.ts OPS_MONEY_ACTIONS). */
  slug: string;
  label: string;
}

export interface OpsEntityDef {
  /** URL slug: /api/ops/{slug} */
  slug: string;
  label: string;
  /** Prisma delegate key, e.g. "opsInvoice". */
  delegate: string;
  createSchema: z.ZodTypeAny;
  patchSchema: z.ZodTypeAny;
  /** False for immutable ledgers — PATCH returns 405. */
  patchable: boolean;
  /** Query-param filters allowed on GET (beyond limit). */
  filterable: string[];
  gatedTransitions: OpsGatedTransition[];
  summarize: (row: Record<string, unknown>) => string;
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

const lineItemSchema = z.object({
  name: z.string().min(1).max(200),
  sku: z.string().max(64).optional(),
  qty: z.number().int().min(1).max(100_000),
  priceCents: z.number().int().min(0).max(1_000_000_000),
});

const invoiceLineSchema = z.object({
  description: z.string().min(1).max(500),
  qty: z.number().int().min(1).max(100_000),
  priceCents: z.number().int().min(0).max(1_000_000_000),
});

const milestoneSchema = z.object({
  title: z.string().min(1).max(200),
  dueAt: z.string().max(32).optional(),
  status: z.string().max(32).default("open"),
});

const workflowStepSchema = z.object({
  name: z.string().min(1).max(200),
  status: z.string().max(32).default("pending"),
  at: z.string().max(32).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const compensationEntrySchema = z.object({
  step: z.string().min(1).max(200),
  action: z.string().min(1).max(500),
  result: z.unknown().optional(),
});

// ---------------------------------------------------------------------------
// The eight slice-1 entities
// ---------------------------------------------------------------------------

const productDef: OpsEntityDef = {
  slug: "products",
  label: "Product",
  delegate: "opsProduct",
  createSchema: z.object({
    name: z.string().min(1).max(200),
    sku: z.string().min(1).max(64),
    priceCents: z.number().int().min(0),
    stockQty: z.number().int().min(0).default(0),
    trackInventory: z.boolean().default(true),
  }),
  // NOTE: stockQty is deliberately NOT patchable — stock moves only through
  // inventory-txn creation (atomic txn + balance update in the same
  // transaction), so inventory can never drift from its ledger.
  // lowStockThreshold IS patchable (free write): it only tunes alerting.
  //
  // The patch schema is strict ON PURPOSE (an exception to the codebase's
  // strip-unknown convention): a silent ignore of stockQty would let a
  // caller believe the balance was set while no ledger entry exists.
  // Direct balance writes fail loudly (400) instead.
  patchSchema: z.object({
    name: z.string().min(1).max(200).optional(),
    sku: z.string().min(1).max(64).optional(),
    priceCents: z.number().int().min(0).optional(),
    trackInventory: z.boolean().optional(),
    lowStockThreshold: z.number().int().min(0).optional(),
  }).strict(),
  patchable: true,
  filterable: [],
  gatedTransitions: [],
  summarize: (r) => `product "${r.name}" (${r.sku}) @ ${r.priceCents}c`,
};

const orderDef: OpsEntityDef = {
  slug: "orders",
  label: "Order",
  delegate: "opsOrder",
  createSchema: z.object({
    customerId: z.string().min(1).max(64).optional(),
    lineItems: z.array(lineItemSchema).min(1).max(200),
    taxCents: z.number().int().min(0).default(0),
  }),
  patchSchema: z.object({
    customerId: z.string().min(1).max(64).optional(),
    taxCents: z.number().int().min(0).optional(),
    status: z.enum(["confirmed", "fulfilled", "cancelled"]).optional(),
  }),
  patchable: true,
  filterable: ["status"],
  gatedTransitions: [
    {
      field: "status",
      to: ["cancelled"],
      slug: "OPS_ORDER_CANCEL",
      label: "Cancel order",
    },
    {
      field: "status",
      to: ["fulfilled"],
      slug: "OPS_ORDER_FULFILL",
      label: "Fulfill order",
    },
  ],
  summarize: (r) => `order ${r.id} → ${r.status} (${r.totalCents}c)`,
};

const paymentDef: OpsEntityDef = {
  slug: "payments",
  label: "Payment",
  delegate: "opsPayment",
  // RECORDS ONLY — every payment write is a gated write (medium minimum;
  // bulk refunds high). The body is either one payment or a bulk refund
  // batch ({ kind: "refund", items: [...] }).
  createSchema: z.union([
    z.object({
      orderId: z.string().min(1).max(64).optional(),
      kind: z.enum(["charge", "refund"]).default("charge"),
      amountCents: z.number().int().positive(),
      provider: z.string().max(32).default("stripe"),
      providerRef: z.string().max(128).optional(),
      status: z.enum(["pending", "succeeded", "failed"]).default("pending"),
    }),
    z.object({
      kind: z.literal("refund"),
      items: z
        .array(
          z.object({
            orderId: z.string().min(1).max(64).optional(),
            amountCents: z.number().int().positive(),
            providerRef: z.string().max(128).optional(),
          }),
        )
        .min(2)
        .max(100),
      provider: z.string().max(32).default("stripe"),
    }),
  ]),
  patchSchema: z.object({}),
  // Immutable ledger: corrections are new records (refunds), never edits.
  patchable: false,
  filterable: ["status", "kind"],
  gatedTransitions: [],
  summarize: (r) => `payment ${r.kind} ${r.amountCents}c (${r.status})`,
};

const promotionDef: OpsEntityDef = {
  slug: "promotions",
  label: "Promotion",
  delegate: "opsPromotion",
  createSchema: z.object({
    code: z.string().min(1).max(64),
    rules: z.record(z.string(), z.unknown()).default({}),
    usageLimit: z.number().int().positive().optional(),
    active: z.boolean().default(true),
  }),
  patchSchema: z.object({
    rules: z.record(z.string(), z.unknown()).optional(),
    usageLimit: z.number().int().positive().nullable().optional(),
    active: z.boolean().optional(),
  }),
  patchable: true,
  filterable: [],
  gatedTransitions: [],
  summarize: (r) => `promotion "${r.code}"`,
};

const invoiceDef: OpsEntityDef = {
  slug: "invoices",
  label: "Invoice",
  delegate: "opsInvoice",
  createSchema: z.object({
    customerId: z.string().min(1).max(64).optional(),
    lineItems: z.array(invoiceLineSchema).min(1).max(200),
    taxCents: z.number().int().min(0).default(0),
    idempotencyKey: z.string().max(128).optional(),
    // ISO-8601 payment due date (optional — defaults to sentAt + 30 days
    // when the invoice is sent). Slice 2.
    dueAt: z.string().max(64).optional(),
  }),
  patchSchema: z.object({
    customerId: z.string().min(1).max(64).optional(),
    taxCents: z.number().int().min(0).optional(),
    status: z.enum(["sent", "paid", "overdue", "cancelled"]).optional(),
  }),
  patchable: true,
  filterable: ["status"],
  gatedTransitions: [
    // Sending an invoice is a gated write (medium, approval required —
    // money is a red lane). Same for marking paid and voiding.
    { field: "status", to: ["sent"], slug: "OPS_INVOICE_SEND", label: "Send invoice" },
    { field: "status", to: ["paid"], slug: "OPS_INVOICE_MARK_PAID", label: "Mark invoice paid" },
    { field: "status", to: ["cancelled"], slug: "OPS_RECORD_DELETE", label: "Void invoice" },
  ],
  summarize: (r) => `invoice ${r.id} → ${r.status} (${r.totalCents}c)`,
};

const inventoryTxnDef: OpsEntityDef = {
  slug: "inventory-txns",
  label: "Inventory transaction",
  delegate: "opsInventoryTxn",
  createSchema: z.object({
    productId: z.string().min(1).max(64),
    delta: z.number().int().min(-1_000_000).max(1_000_000).refine((n) => n !== 0, {
      message: "delta must be non-zero",
    }),
    reason: z.enum(["sale", "restock", "adjustment"]),
    actor: z.string().max(128).optional(),
    note: z.string().max(2000).optional(),
  }),
  patchSchema: z.object({}),
  // Immutable ledger — PATCH returns 405.
  patchable: false,
  // Slice 3: productId filterable so the UI can show per-product history
  // through the generic route.
  filterable: ["reason", "productId"],
  gatedTransitions: [],
  summarize: (r) => `inventory ${r.reason} ${r.delta} on ${r.productId}`,
};

const poLineItemSchema = z.object({
  // Optional link to a catalog product: when present, receiving the PO
  // books a restock inventory txn for it (atomic, same transaction).
  productId: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(200),
  sku: z.string().max(64).optional(),
  qty: z.number().int().min(1).max(100_000),
  priceCents: z.number().int().min(0).max(1_000_000_000),
});

const purchaseOrderDef: OpsEntityDef = {
  slug: "purchase-orders",
  label: "Purchase order",
  delegate: "opsPurchaseOrder",
  createSchema: z.object({
    supplierId: z.string().min(1).max(64).optional(),
    supplierName: z.string().max(200).optional(),
    lineItems: z.array(poLineItemSchema).min(1).max(200),
    taxCents: z.number().int().min(0).default(0),
  }),
  patchSchema: z.object({
    supplierId: z.string().min(1).max(64).optional(),
    supplierName: z.string().max(200).optional(),
    taxCents: z.number().int().min(0).optional(),
    status: z.enum(["sent", "received", "cancelled"]).optional(),
  }),
  patchable: true,
  filterable: ["status"],
  gatedTransitions: [
    // Sending a PO is a money commitment (medium, approval required —
    // money is a red lane). Receiving is fulfillment: a free logged write
    // that atomically books restock txns. Cancelling deletes value.
    { field: "status", to: ["sent"], slug: "OPS_PO_SEND", label: "Send purchase order" },
    { field: "status", to: ["cancelled"], slug: "OPS_RECORD_DELETE", label: "Cancel purchase order" },
  ],
  summarize: (r) => `purchase order ${r.id} → ${r.status} (${r.totalCents}c)`,
};

const projectDef: OpsEntityDef = {
  slug: "projects",
  label: "Project",
  delegate: "opsProject",
  createSchema: z.object({
    customerId: z.string().min(1).max(64).optional(),
    name: z.string().min(1).max(200),
    milestones: z.array(milestoneSchema).max(200).default([]),
    status: z.enum(["planning", "active", "on_hold", "completed", "cancelled"]).default("planning"),
    leadId: z.string().max(64).optional(),
    dealId: z.string().max(64).optional(),
  }),
  patchSchema: z.object({
    name: z.string().min(1).max(200).optional(),
    milestones: z.array(milestoneSchema).max(200).optional(),
    status: z.enum(["planning", "active", "on_hold", "completed", "cancelled"]).optional(),
    leadId: z.string().max(64).nullable().optional(),
    dealId: z.string().max(64).nullable().optional(),
  }),
  patchable: true,
  filterable: ["status"],
  gatedTransitions: [],
  summarize: (r) => `project "${r.name}" → ${r.status}`,
};

// ---------------------------------------------------------------------------
// Slice 5: HR essentials (clean-room — original Marketr work, no ERPNext
// code/schema/UI text anywhere in this repo).
// ---------------------------------------------------------------------------

const teamMemberDef: OpsEntityDef = {
  slug: "team-members",
  label: "Team member",
  delegate: "opsTeamMember",
  createSchema: z.object({
    name: z.string().min(1).max(200),
    title: z.string().max(200).optional(),
    email: z.string().email().max(320).optional(),
    // ISO-8601 date; parsed to a Date in createRows (validated there).
    startDate: z.string().max(64).optional(),
  }),
  patchSchema: z.object({
    title: z.string().max(200).nullable().optional(),
    email: z.string().email().max(320).nullable().optional(),
    startDate: z.string().max(64).nullable().optional(),
    status: z.enum(["active", "inactive"]).optional(),
  }),
  patchable: true,
  filterable: ["status"],
  gatedTransitions: [],
  summarize: (r) => `team member "${r.name}"${r.title ? ` (${r.title})` : ""} → ${r.status}`,
};

const leaveRequestDef: OpsEntityDef = {
  slug: "leave-requests",
  label: "Leave request",
  delegate: "opsLeaveRequest",
  createSchema: z.object({
    memberId: z.string().min(1).max(64),
    type: z.enum(["vacation", "sick", "personal"]),
    // ISO-8601 dates; parsed + range-validated in createRows.
    startDate: z.string().max(64),
    endDate: z.string().max(64),
  }),
  patchSchema: z.object({
    status: z.enum(["approved", "denied", "taken"]).optional(),
  }),
  patchable: true,
  filterable: ["status", "memberId", "type"],
  gatedTransitions: [
    // Approving a leave request is a manager decision — gated (medium)
    // like other ops approvals. Denying and marking taken are free
    // logged writes.
    {
      field: "status",
      to: ["approved"],
      slug: "OPS_LEAVE_APPROVE",
      label: "Approve leave request",
    },
  ],
  summarize: (r) => `leave ${r.type} ${r.id} → ${r.status}`,
};

const workflowRunDef: OpsEntityDef = {
  slug: "workflow-runs",
  label: "Workflow run",
  delegate: "opsWorkflowRun",
  createSchema: z.object({
    workflowName: z.string().min(1).max(200),
    steps: z.array(workflowStepSchema).max(500).default([]),
    status: z.enum(["running", "succeeded", "failed", "compensated"]).default("running"),
  }),
  patchSchema: z.object({
    steps: z.array(workflowStepSchema).max(500).optional(),
    status: z.enum(["running", "succeeded", "failed", "compensated"]).optional(),
    // Append-only compensation: PATCH appends an entry to the log with a
    // timestamp — the log itself is never replaced through the API.
    compensationAppend: compensationEntrySchema.optional(),
  }),
  patchable: true,
  filterable: ["status"],
  gatedTransitions: [],
  summarize: (r) => `workflow "${r.workflowName}" → ${r.status}`,
};

export const OPS_ENTITIES: OpsEntityDef[] = [
  productDef,
  orderDef,
  paymentDef,
  promotionDef,
  invoiceDef,
  inventoryTxnDef,
  purchaseOrderDef,
  projectDef,
  workflowRunDef,
  teamMemberDef,
  leaveRequestDef,
];

export const OPS_ENTITY_MAP: Record<string, OpsEntityDef> = Object.fromEntries(
  OPS_ENTITIES.map((d) => [d.slug, d]),
);

export const OPS_ENTITY_SLUGS = OPS_ENTITIES.map((d) => d.slug);
