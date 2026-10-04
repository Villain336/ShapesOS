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
// Phase 10 (finance): accounting, quotes, purchasing and expense entities.
import { FINANCE_ENTITIES } from "./finance/entities";
import type { Prisma } from "@prisma/client";

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
  /**
   * Allowed status moves (from → to[]). When set, every PATCH that changes
   * status must be listed here (409 otherwise) and is applied with a
   * status-guarded write, so two racing transitions can't both land.
   * Money fields (taxCents/lineItems) are editable only while "draft".
   */
  statusTransitions?: Record<string, string[]>;
  summarize: (row: Record<string, unknown>) => string;
  // ---- Phase 10 (finance) ----
  /** Create is a gated write under this money-action slug (default: a free draft-creator). */
  createGate?: string;
  /** Statuses in which money fields (taxCents/lineItems) may still change (default ["draft"]). */
  editableStatuses?: string[];
  /**
   * Phase 10 (ops-core): entity-specific create/patch rules. When set, the
   * DocType service (lib/ops/doctype.ts) calls them instead of the generic
   * insert/update — validation, audit, gating and status-transition checks
   * still run around them. Implementations live in lib/ops/* and are
   * imported lazily (they import the service themselves).
   */
  hooks?: OpsEntityHooks;
}

export interface OpsEntityHooks {
  create?: (
    tx: Prisma.TransactionClient,
    actor: { workspaceId: string; userId: string },
    body: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  patch?: (
    tx: Prisma.TransactionClient,
    actor: { workspaceId: string; userId: string },
    id: string,
    patch: Record<string, unknown>,
    existing: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** Money columns are Postgres int4 — totals beyond this would 500 at insert. */
export const OPS_MAX_CENTS = 2_147_483_647;

const centsSchema = z.number().int().min(0).max(OPS_MAX_CENTS);

/** Server-computed total (Σ qty × price + tax). */
export function opsTotalCents(lineItems: Array<{ qty: number; priceCents: number }>, taxCents: number): number {
  return lineItems.reduce((s, li) => s + li.qty * li.priceCents, 0) + taxCents;
}

/** The total must fit the int4 column (validated, never a raw Prisma 500). */
function totalFitsInt4(
  body: { lineItems: Array<{ qty: number; priceCents: number }>; taxCents?: number },
  ctx: z.RefinementCtx,
) {
  if (opsTotalCents(body.lineItems, body.taxCents ?? 0) > OPS_MAX_CENTS) {
    ctx.addIssue({
      code: "custom",
      path: ["lineItems"],
      message: `total exceeds the maximum of ${OPS_MAX_CENTS} cents`,
    });
  }
}

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
  // Phase 10 (finance): line-level tax — the server computes the line's
  // taxCents from the rate (lib/ops/finance/money.ts); client values are ignored.
  taxRateId: z.string().min(1).max(64).optional(),
});

// Phase 10 (store): an ISO-8601 date/time from the API contract, as a Date.
const isoDateValue = z
  .string()
  .max(64)
  .refine((v) => !Number.isNaN(new Date(v).getTime()), { message: "must be an ISO-8601 date" })
  .transform((v) => new Date(v));

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
    priceCents: centsSchema,
    stockQty: z.number().int().min(0).max(OPS_MAX_CENTS).default(0),
    trackInventory: z.boolean().default(true),
    // Phase 10 (store): inactive products are never sold on the storefront.
    active: z.boolean().default(true),
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
    priceCents: centsSchema.optional(),
    trackInventory: z.boolean().optional(),
    lowStockThreshold: z.number().int().min(0).optional(),
    // Phase 10 (store)
    active: z.boolean().optional(),
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
    taxCents: centsSchema.default(0),
  }).superRefine(totalFitsInt4),
  patchSchema: z.object({
    customerId: z.string().min(1).max(64).optional(),
    lineItems: z.array(lineItemSchema).min(1).max(200).optional(),
    taxCents: centsSchema.optional(),
    status: z.enum(["confirmed", "fulfilled", "cancelled"]).optional(),
  }),
  patchable: true,
  // Phase 10 (store): source = manual | web | quote | workflow; storeId.
  filterable: ["status", "source", "storeId"],
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
  statusTransitions: {
    draft: ["confirmed", "cancelled"],
    confirmed: ["fulfilled", "cancelled"],
    fulfilled: [],
    cancelled: [],
  },
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
      amountCents: z.number().int().positive().max(OPS_MAX_CENTS),
      provider: z.string().max(32).default("stripe"),
      providerRef: z.string().max(128).optional(),
      status: z.enum(["pending", "succeeded", "failed"]).default("pending"),
      // Phase 10 (finance): a (partial) payment against an invoice.
      invoiceId: z.string().min(1).max(64).optional(),
      note: z.string().max(2000).optional(),
    }),
    z.object({
      kind: z.literal("refund"),
      items: z
        .array(
          z.object({
            orderId: z.string().min(1).max(64).optional(),
            amountCents: z.number().int().positive().max(OPS_MAX_CENTS),
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
    // Phase 10 (store): optional validity window (ISO-8601).
    startsAt: isoDateValue.optional(),
    endsAt: isoDateValue.optional(),
  }).refine((b) => !b.startsAt || !b.endsAt || b.endsAt > b.startsAt, { message: "endsAt must be after startsAt", path: ["endsAt"] }),
  patchSchema: z.object({
    rules: z.record(z.string(), z.unknown()).optional(),
    usageLimit: z.number().int().positive().nullable().optional(),
    active: z.boolean().optional(),
    // Phase 10 (store)
    startsAt: isoDateValue.nullable().optional(),
    endsAt: isoDateValue.nullable().optional(),
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
    taxCents: centsSchema.default(0),
    idempotencyKey: z.string().min(1).max(128).optional(),
    // ISO-8601 payment due date (optional — defaults to sentAt + 30 days
    // when the invoice is sent). Slice 2.
    dueAt: z.string().max(64).optional(),
    // Phase 10 (finance): recipient override (else the CRM lead's email).
    customerEmail: z.string().email().max(320).optional(),
  }).superRefine(totalFitsInt4),
  patchSchema: z.object({
    customerId: z.string().min(1).max(64).optional(),
    lineItems: z.array(invoiceLineSchema).min(1).max(200).optional(),
    taxCents: centsSchema.optional(),
    status: z.enum(["sent", "paid", "overdue", "cancelled"]).optional(),
    // Phase 10 (finance)
    customerEmail: z.string().email().max(320).nullable().optional(),
  }),
  patchable: true,
  // Phase 10 (finance): kind = invoice | credit_note.
  filterable: ["status", "kind"],
  gatedTransitions: [
    // Sending an invoice is a gated write (medium, approval required —
    // money is a red lane). Same for marking paid and voiding.
    { field: "status", to: ["sent"], slug: "OPS_INVOICE_SEND", label: "Send invoice" },
    { field: "status", to: ["paid"], slug: "OPS_INVOICE_MARK_PAID", label: "Mark invoice paid" },
    { field: "status", to: ["cancelled"], slug: "OPS_RECORD_DELETE", label: "Void invoice" },
  ],
  // Overdue only follows a sent invoice (the sweep's move); paid and
  // cancelled are terminal — a paid invoice can never flip to overdue.
  statusTransitions: {
    draft: ["sent", "cancelled"],
    sent: ["paid", "overdue", "cancelled"],
    overdue: ["paid", "cancelled"],
    paid: [],
    cancelled: [],
  },
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
    // Phase 10 (ops-core): variant (default variant when omitted) + location.
    variantId: z.string().min(1).max(64).optional(),
    locationId: z.string().min(1).max(64).optional(),
  }),
  patchSchema: z.object({}),
  // Immutable ledger — PATCH returns 405.
  patchable: false,
  // Slice 3: productId filterable so the UI can show per-product history
  // through the generic route.
  filterable: ["reason", "productId", "locationId", "variantId", "transferId"],
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
  // Phase 10 (ops-core): receive into this variant / location.
  variantId: z.string().min(1).max(64).optional(),
  locationId: z.string().min(1).max(64).optional(),
});

const purchaseOrderDef: OpsEntityDef = {
  slug: "purchase-orders",
  label: "Purchase order",
  delegate: "opsPurchaseOrder",
  createSchema: z.object({
    supplierId: z.string().min(1).max(64).optional(),
    supplierName: z.string().max(200).optional(),
    lineItems: z.array(poLineItemSchema).min(1).max(200),
    taxCents: centsSchema.default(0),
    // Phase 10 (finance): the vendor record, and start as an RFQ.
    vendorId: z.string().min(1).max(64).optional(),
    rfq: z.boolean().optional(),
  }).superRefine(totalFitsInt4),
  patchSchema: z.object({
    supplierId: z.string().min(1).max(64).optional(),
    supplierName: z.string().max(200).optional(),
    lineItems: z.array(poLineItemSchema).min(1).max(200).optional(),
    taxCents: centsSchema.optional(),
    // Phase 10 (finance): rfq_sent / draft are the RFQ moves; partial
    // receipts go through POST /api/ops/purchase-orders/[id]/receipts.
    status: z.enum(["rfq_sent", "draft", "sent", "received", "cancelled"]).optional(),
    vendorId: z.string().min(1).max(64).nullable().optional(),
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
  // Received only after sent (restock books exactly once, on that move).
  // Phase 10 (finance): RFQ stage first; partial receipts in between.
  statusTransitions: {
    rfq: ["rfq_sent", "draft", "cancelled"],
    rfq_sent: ["draft", "cancelled"],
    draft: ["sent", "cancelled"],
    sent: ["received", "cancelled"],
    partially_received: ["received", "cancelled"],
    received: [],
    cancelled: [],
  },
  editableStatuses: ["draft", "rfq", "rfq_sent"],
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
    // Phase 10 (ops-core): default billing rate for logged time.
    hourlyRateCents: centsSchema.optional(),
  }),
  patchSchema: z.object({
    name: z.string().min(1).max(200).optional(),
    milestones: z.array(milestoneSchema).max(200).optional(),
    status: z.enum(["planning", "active", "on_hold", "completed", "cancelled"]).optional(),
    leadId: z.string().max(64).nullable().optional(),
    dealId: z.string().max(64).nullable().optional(),
    hourlyRateCents: centsSchema.nullable().optional(),
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
    // Phase 10 (ops-core): workspace-user link + department.
    userId: z.string().min(1).max(128).optional(),
    departmentId: z.string().min(1).max(64).optional(),
  }),
  patchSchema: z.object({
    title: z.string().max(200).nullable().optional(),
    email: z.string().email().max(320).nullable().optional(),
    startDate: z.string().max(64).nullable().optional(),
    status: z.enum(["active", "inactive"]).optional(),
    userId: z.string().min(1).max(128).nullable().optional(),
    departmentId: z.string().min(1).max(64).nullable().optional(),
  }),
  patchable: true,
  filterable: ["status", "departmentId", "userId"],
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
    // Slice 6: idempotency key — the runner requires it; one run per
    // (workspace, runKey) so an approved plan can never execute twice.
    runKey: z.string().min(1).max(64).optional(),
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

// ---------------------------------------------------------------------------
// Phase 10 (ops-core): inventory — warehouses, locations, variants,
// transfers, reorder rules (rules in lib/ops/stock.ts).
// ---------------------------------------------------------------------------

const lazyStock = () => import("./stock");

const warehouseDef: OpsEntityDef = {
  slug: "warehouses",
  label: "Warehouse",
  delegate: "opsWarehouse",
  createSchema: z.object({
    name: z.string().min(1).max(200),
    code: z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9._-]+$/, "code may use letters, digits, . _ -"),
    address: z.string().max(2000).optional(),
  }),
  // Codes are immutable (locations' paths and the digital twin key on them).
  patchSchema: z.object({
    name: z.string().min(1).max(200).optional(),
    address: z.string().max(2000).nullable().optional(),
    active: z.boolean().optional(),
  }).strict(),
  patchable: true,
  filterable: [],
  gatedTransitions: [],
  summarize: (r) => `warehouse ${r.code} "${r.name}"`,
};

const locationDef: OpsEntityDef = {
  slug: "locations",
  label: "Location",
  delegate: "opsLocation",
  createSchema: z.object({
    warehouseId: z.string().min(1).max(64),
    parentId: z.string().min(1).max(64).optional(),
    kind: z.enum(["zone", "aisle", "rack", "shelf", "bin", "dock"]),
    code: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, "code may use letters, digits, . _ -"),
    name: z.string().max(200).optional(),
  }),
  patchSchema: z.object({
    name: z.string().max(200).nullable().optional(),
    active: z.boolean().optional(),
  }).strict(),
  patchable: true,
  filterable: ["warehouseId", "parentId", "kind"],
  gatedTransitions: [],
  summarize: (r) => `location ${r.path ?? r.code} (${r.kind})`,
  hooks: { create: async (tx, a, b) => (await lazyStock()).createLocationRow(tx, a, b) },
};

const productVariantDef: OpsEntityDef = {
  slug: "product-variants",
  label: "Product variant",
  delegate: "opsProductVariant",
  createSchema: z.object({
    productId: z.string().min(1).max(64),
    sku: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(200),
    attributes: z.record(z.string().max(64), z.string().max(200)).default({}),
    priceCents: centsSchema.optional(),
  }),
  patchSchema: z.object({
    name: z.string().trim().min(1).max(200).optional(),
    attributes: z.record(z.string().max(64), z.string().max(200)).optional(),
    priceCents: centsSchema.nullable().optional(),
    active: z.boolean().optional(),
  }).strict(),
  patchable: true,
  filterable: ["productId"],
  gatedTransitions: [],
  summarize: (r) => `variant ${r.sku} "${r.name}"`,
  hooks: { create: async (tx, a, b) => (await lazyStock()).createVariantRow(tx, a, b) },
};

const transferDef: OpsEntityDef = {
  slug: "transfers",
  label: "Transfer",
  delegate: "opsTransfer",
  createSchema: z.object({
    fromLocationId: z.string().min(1).max(64),
    toLocationId: z.string().min(1).max(64),
    lines: z
      .array(
        z.object({
          productId: z.string().min(1).max(64),
          variantId: z.string().min(1).max(64).optional(),
          qty: z.number().int().min(1).max(1_000_000),
        }),
      )
      .min(1)
      .max(200),
    note: z.string().max(2000).optional(),
  }),
  patchSchema: z.object({
    status: z.enum(["done", "cancelled"]).optional(),
    note: z.string().max(2000).nullable().optional(),
  }).strict(),
  patchable: true,
  filterable: ["status", "fromLocationId", "toLocationId"],
  gatedTransitions: [],
  // Done books the paired ledger legs exactly once (status-guarded claim).
  statusTransitions: { draft: ["done", "cancelled"], done: [], cancelled: [] },
  summarize: (r) => `transfer ${r.id} → ${r.status}`,
  hooks: {
    create: async (tx, a, b) => (await lazyStock()).createTransferRow(tx, a, b),
    patch: async (tx, a, id, p, e) => (await lazyStock()).patchTransfer(tx, a, id, p, e),
  },
};

const reorderRuleDef: OpsEntityDef = {
  slug: "reorder-rules",
  label: "Reorder rule",
  delegate: "opsReorderRule",
  createSchema: z.object({
    productId: z.string().min(1).max(64),
    variantId: z.string().min(1).max(64).optional(),
    warehouseId: z.string().min(1).max(64),
    receiveLocationId: z.string().min(1).max(64).optional(),
    minQty: z.number().int().min(0).max(10_000_000),
    maxQty: z.number().int().min(1).max(10_000_000),
    supplierName: z.string().max(200).optional(),
    unitCostCents: centsSchema.optional(),
  }),
  patchSchema: z.object({
    minQty: z.number().int().min(0).max(10_000_000).optional(),
    maxQty: z.number().int().min(1).max(10_000_000).optional(),
    receiveLocationId: z.string().min(1).max(64).nullable().optional(),
    supplierName: z.string().max(200).nullable().optional(),
    unitCostCents: centsSchema.nullable().optional(),
    active: z.boolean().optional(),
  }).strict(),
  patchable: true,
  filterable: ["productId", "warehouseId"],
  gatedTransitions: [],
  summarize: (r) => `reorder rule ${r.id}: min ${r.minQty} / max ${r.maxQty}`,
  hooks: {
    create: async (tx, a, b) => (await lazyStock()).createReorderRuleRow(tx, a, b),
    patch: async (tx, a, id, p, e) => (await lazyStock()).patchReorderRule(tx, a, id, p, e),
  },
};

// ---------------------------------------------------------------------------
// Phase 10 (ops-core): CRM accounts — companies, contacts, deals (rules +
// Lead conversion in lib/ops/crm.ts).
// ---------------------------------------------------------------------------

const lazyCrm = () => import("./crm");
const isoDate = z.string().max(64).refine((v) => !Number.isNaN(new Date(v).getTime()), { message: "must be an ISO-8601 date" });

const companyDef: OpsEntityDef = {
  slug: "companies",
  label: "Company",
  delegate: "opsCompany",
  createSchema: z.object({
    name: z.string().trim().min(1).max(200),
    domain: z.string().max(253).optional(),
    website: z.string().max(500).optional(),
    phone: z.string().max(64).optional(),
    industry: z.string().max(120).optional(),
    ownerId: z.string().max(128).optional(),
    notes: z.string().max(5000).optional(),
  }),
  patchSchema: z.object({
    name: z.string().trim().min(1).max(200).optional(),
    domain: z.string().max(253).nullable().optional(),
    website: z.string().max(500).nullable().optional(),
    phone: z.string().max(64).nullable().optional(),
    industry: z.string().max(120).nullable().optional(),
    ownerId: z.string().max(128).nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
  }).strict(),
  patchable: true,
  filterable: ["ownerId"],
  gatedTransitions: [],
  summarize: (r) => `company "${r.name}"${r.domain ? ` (${r.domain})` : ""}`,
  hooks: {
    create: async (tx, a, b) => (await lazyCrm()).createCompanyRow(tx, a, b),
    patch: async (tx, a, id, p) => (await lazyCrm()).patchCompanyRow(tx, a, id, p),
  },
};

const contactDef: OpsEntityDef = {
  slug: "contacts",
  label: "Contact",
  delegate: "opsContact",
  createSchema: z.object({
    name: z.string().trim().min(1).max(200),
    email: z.string().max(320).optional(),
    phone: z.string().max(64).optional(),
    title: z.string().max(200).optional(),
    companyId: z.string().min(1).max(64).optional(),
    ownerId: z.string().max(128).optional(),
    notes: z.string().max(5000).optional(),
  }),
  patchSchema: z.object({
    name: z.string().trim().min(1).max(200).optional(),
    email: z.string().max(320).nullable().optional(),
    phone: z.string().max(64).nullable().optional(),
    title: z.string().max(200).nullable().optional(),
    companyId: z.string().min(1).max(64).nullable().optional(),
    ownerId: z.string().max(128).nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
  }).strict(),
  patchable: true,
  filterable: ["companyId", "ownerId", "leadId"],
  gatedTransitions: [],
  summarize: (r) => `contact "${r.name}"${r.email ? ` <${r.email}>` : ""}`,
  hooks: {
    create: async (tx, a, b) => (await lazyCrm()).createContactRow(tx, a, b),
    patch: async (tx, a, id, p) => (await lazyCrm()).patchContactRow(tx, a, id, p),
  },
};

const dealDef: OpsEntityDef = {
  slug: "deals",
  label: "Deal",
  delegate: "opsDeal",
  createSchema: z.object({
    title: z.string().trim().min(1).max(200),
    pipelineId: z.string().min(1).max(64).optional(),
    stage: z.string().min(1).max(64).optional(),
    valueCents: centsSchema.default(0),
    ownerId: z.string().max(128).optional(),
    ownerName: z.string().max(200).optional(),
    contactId: z.string().min(1).max(64).optional(),
    companyId: z.string().min(1).max(64).optional(),
    leadId: z.string().min(1).max(64).optional(),
    expectedCloseAt: isoDate.optional(),
  }),
  // Moving a deal between stages is a free, logged write (no money moves).
  patchSchema: z.object({
    title: z.string().trim().min(1).max(200).optional(),
    stage: z.string().min(1).max(64).optional(),
    valueCents: centsSchema.optional(),
    ownerId: z.string().max(128).nullable().optional(),
    ownerName: z.string().max(200).nullable().optional(),
    contactId: z.string().min(1).max(64).nullable().optional(),
    companyId: z.string().min(1).max(64).nullable().optional(),
    expectedCloseAt: isoDate.nullable().optional(),
    lostReason: z.string().max(500).nullable().optional(),
  }).strict(),
  patchable: true,
  filterable: ["pipelineId", "stage", "status", "contactId", "companyId", "ownerId"],
  gatedTransitions: [],
  summarize: (r) => `deal "${r.title}" → ${r.stage} (${r.valueCents}c)`,
  hooks: {
    create: async (tx, a, b) => (await lazyCrm()).createDealRow(tx, a, b),
    patch: async (tx, a, id, p, e) => (await lazyCrm()).patchDealRow(tx, a, id, p, e),
  },
};

// ---------------------------------------------------------------------------
// Phase 10 (ops-core): project tasks (rules in lib/ops/timesheets.ts).
// ---------------------------------------------------------------------------

const taskStage = z.enum(["backlog", "todo", "in_progress", "review", "done", "cancelled"]);
const taskPriority = z.enum(["low", "normal", "high", "urgent"]);

const taskDef: OpsEntityDef = {
  slug: "tasks",
  label: "Task",
  delegate: "opsTask",
  createSchema: z.object({
    projectId: z.string().min(1).max(64),
    title: z.string().trim().min(1).max(300),
    description: z.string().max(10_000).optional(),
    stage: taskStage.default("todo"),
    priority: taskPriority.default("normal"),
    assigneeId: z.string().min(1).max(128).optional(),
    dueAt: isoDate.optional(),
    estimateMinutes: z.number().int().min(1).max(100_000).optional(),
  }),
  patchSchema: z.object({
    title: z.string().trim().min(1).max(300).optional(),
    description: z.string().max(10_000).nullable().optional(),
    stage: taskStage.optional(),
    priority: taskPriority.optional(),
    assigneeId: z.string().min(1).max(128).nullable().optional(),
    dueAt: isoDate.nullable().optional(),
    estimateMinutes: z.number().int().min(1).max(100_000).nullable().optional(),
  }).strict(),
  patchable: true,
  filterable: ["projectId", "stage", "assigneeId", "priority"],
  gatedTransitions: [],
  summarize: (r) => `task "${r.title}" → ${r.stage}`,
  hooks: {
    create: async (tx, a, b) => (await import("./timesheets")).createTaskRow(tx, a, b),
    patch: async (tx, a, id, p, e) => (await import("./timesheets")).patchTaskRow(tx, a, id, p, e),
  },
};

// ---------------------------------------------------------------------------
// Phase 10 (ops-core): helpdesk — tickets + SLA policies (rules, inbound
// email threading and replies in lib/ops/helpdesk.ts).
// ---------------------------------------------------------------------------

const ticketPriority = z.enum(["low", "normal", "high", "urgent"]);

const ticketDef: OpsEntityDef = {
  slug: "tickets",
  label: "Ticket",
  delegate: "opsTicket",
  createSchema: z.object({
    subject: z.string().trim().min(1).max(300),
    body: z.string().max(50_000).optional(),
    priority: ticketPriority.default("normal"),
    channel: z.enum(["web", "phone", "chat", "agent", "email"]).default("web"),
    requesterEmail: z.string().max(320).optional(),
    requesterName: z.string().max(200).optional(),
    contactId: z.string().min(1).max(64).optional(),
    assigneeId: z.string().min(1).max(128).optional(),
  }),
  patchSchema: z.object({
    subject: z.string().trim().min(1).max(300).optional(),
    status: z.enum(["open", "pending", "solved", "closed"]).optional(),
    priority: ticketPriority.optional(),
    assigneeId: z.string().min(1).max(128).nullable().optional(),
    contactId: z.string().min(1).max(64).nullable().optional(),
  }).strict(),
  patchable: true,
  filterable: ["status", "priority", "assigneeId", "contactId", "requesterEmail"],
  gatedTransitions: [],
  statusTransitions: {
    new: ["open", "pending", "solved", "closed"],
    open: ["pending", "solved", "closed"],
    pending: ["open", "solved", "closed"],
    solved: ["open", "closed"],
    closed: [],
  },
  summarize: (r) => `ticket #${r.number ?? "?"} "${r.subject}" → ${r.status}`,
  hooks: {
    create: async (tx, a, b) => (await import("./helpdesk")).createTicketRow(tx, a, b),
    patch: async (tx, a, id, p, e) => (await import("./helpdesk")).patchTicketRow(tx, a, id, p, e),
  },
};

const slaPolicyDef: OpsEntityDef = {
  slug: "sla-policies",
  label: "SLA policy",
  delegate: "opsSlaPolicy",
  createSchema: z.object({
    priority: ticketPriority,
    firstResponseMinutes: z.number().int().min(1).max(525_600),
    resolutionMinutes: z.number().int().min(1).max(525_600),
  }).refine((b) => b.resolutionMinutes >= b.firstResponseMinutes, { message: "resolution target must be at least the first-response target" }),
  patchSchema: z.object({
    firstResponseMinutes: z.number().int().min(1).max(525_600).optional(),
    resolutionMinutes: z.number().int().min(1).max(525_600).optional(),
    active: z.boolean().optional(),
  }).strict(),
  patchable: true,
  filterable: ["priority"],
  gatedTransitions: [],
  summarize: (r) => `SLA ${r.priority}: first response ${r.firstResponseMinutes}m, resolution ${r.resolutionMinutes}m`,
};

// ---------------------------------------------------------------------------
// Phase 10 (ops-core): HR — departments, leave policies + ledger
// adjustments, recruiting (rules in lib/ops/leave.ts and lib/ops/hr.ts).
// ---------------------------------------------------------------------------

const leaveType = z.enum(["vacation", "sick", "personal"]);

const departmentDef: OpsEntityDef = {
  slug: "departments",
  label: "Department",
  delegate: "opsDepartment",
  createSchema: z.object({
    name: z.string().trim().min(1).max(200),
    managerMemberId: z.string().min(1).max(64).optional(),
  }),
  patchSchema: z.object({
    name: z.string().trim().min(1).max(200).optional(),
    managerMemberId: z.string().min(1).max(64).nullable().optional(),
  }).strict(),
  patchable: true,
  filterable: [],
  gatedTransitions: [],
  summarize: (r) => `department "${r.name}"`,
};

const leavePolicyDef: OpsEntityDef = {
  slug: "leave-policies",
  label: "Leave policy",
  delegate: "opsLeavePolicy",
  createSchema: z.object({
    type: leaveType,
    yearlyDays: z.number().int().min(0).max(366),
    carryOverCapDays: z.number().int().min(0).max(366).default(0),
  }),
  patchSchema: z.object({
    yearlyDays: z.number().int().min(0).max(366).optional(),
    carryOverCapDays: z.number().int().min(0).max(366).optional(),
    active: z.boolean().optional(),
  }).strict(),
  patchable: true,
  filterable: ["type"],
  gatedTransitions: [],
  summarize: (r) => `leave policy ${r.type}: ${r.yearlyDays} days/yr, carry ${r.carryOverCapDays}`,
};

const leaveAdjustmentDef: OpsEntityDef = {
  slug: "leave-ledger",
  label: "Leave ledger entry",
  delegate: "opsLeaveLedger",
  // Only manual ADJUSTMENTS are created here ("taken" rows come from
  // approving leave). Append-only: corrections are new signed rows.
  createSchema: z.object({
    memberId: z.string().min(1).max(64),
    type: leaveType,
    year: z.number().int().min(2000).max(2100),
    days: z.number().refine((d) => Number.isFinite(d) && d !== 0 && Math.abs(d) <= 366 && Math.round(d * 100) === d * 100, { message: "days must be non-zero with at most two decimals" }),
    note: z.string().max(500).optional(),
  }).transform((b) => ({ memberId: b.memberId, type: b.type, year: b.year, kind: "adjustment" as const, centidays: Math.round(b.days * 100), note: b.note })),
  patchSchema: z.object({}),
  patchable: false,
  filterable: ["memberId", "type", "kind"],
  gatedTransitions: [],
  summarize: (r) => `leave ${r.kind} ${r.type} ${Number(r.centidays) / 100}d (${r.year})`,
};

const jobOpeningDef: OpsEntityDef = {
  slug: "job-openings",
  label: "Job opening",
  delegate: "opsJobOpening",
  createSchema: z.object({
    title: z.string().trim().min(1).max(200),
    departmentId: z.string().min(1).max(64).optional(),
    location: z.string().max(200).optional(),
    description: z.string().max(20_000).optional(),
  }),
  patchSchema: z.object({
    title: z.string().trim().min(1).max(200).optional(),
    departmentId: z.string().min(1).max(64).nullable().optional(),
    location: z.string().max(200).nullable().optional(),
    description: z.string().max(20_000).nullable().optional(),
    status: z.enum(["open", "paused", "closed"]).optional(),
  }).strict(),
  patchable: true,
  filterable: ["status", "departmentId"],
  gatedTransitions: [],
  summarize: (r) => `job opening "${r.title}" → ${r.status}`,
};

const applicantStage = z.enum(["applied", "screening", "interview", "offer", "hired", "rejected"]);

const applicantDef: OpsEntityDef = {
  slug: "applicants",
  label: "Applicant",
  delegate: "opsApplicant",
  createSchema: z.object({
    openingId: z.string().min(1).max(64),
    name: z.string().trim().min(1).max(200),
    email: z.string().email().max(320).optional(),
    phone: z.string().max(64).optional(),
    source: z.string().max(120).optional(),
    stage: applicantStage.default("applied"),
    rating: z.number().int().min(1).max(5).optional(),
    notes: z.string().max(20_000).optional(),
  }),
  patchSchema: z.object({
    stage: applicantStage.optional(),
    rating: z.number().int().min(1).max(5).nullable().optional(),
    notes: z.string().max(20_000).nullable().optional(),
    email: z.string().email().max(320).nullable().optional(),
    phone: z.string().max(64).nullable().optional(),
  }).strict(),
  patchable: true,
  filterable: ["openingId", "stage"],
  gatedTransitions: [],
  summarize: (r) => `applicant "${r.name}" → ${r.stage}`,
  hooks: {
    create: async (tx, a, b) => (await import("./hr")).createApplicantRow(tx, a, b),
    patch: async (tx, a, id, p, e) => (await import("./hr")).patchApplicantRow(tx, a, id, p, e),
  },
};

// ---------------------------------------------------------------------------
// Phase 10 (store): the public storefront and its listings. Rules (same-
// workspace references, slugs, one store per workspace) live in
// lib/ops/store/admin.ts.
// ---------------------------------------------------------------------------

const lazyStoreAdmin = () => import("./store/admin");

const storeSlugSchema = z.string().trim().toLowerCase().min(1).max(64).regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, "use lowercase letters, digits and hyphens");
const listingSlugSchema = z.string().trim().toLowerCase().min(1).max(120).regex(/^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/, "use lowercase letters, digits and hyphens");

const storeDef: OpsEntityDef = {
  slug: "stores",
  label: "Store",
  delegate: "opsStore",
  createSchema: z.object({
    name: z.string().trim().min(1).max(200),
    slug: storeSlugSchema,
    description: z.string().max(5000).optional(),
    currency: z.string().trim().length(3).optional(),
    published: z.boolean().default(false),
    taxRateId: z.string().min(1).max(64).optional(),
    warehouseId: z.string().min(1).max(64).optional(),
    contactEmail: z.string().email().max(320).optional(),
  }),
  patchSchema: z.object({
    name: z.string().trim().min(1).max(200).optional(),
    slug: storeSlugSchema.optional(),
    description: z.string().max(5000).nullable().optional(),
    currency: z.string().trim().length(3).optional(),
    published: z.boolean().optional(),
    taxRateId: z.string().min(1).max(64).nullable().optional(),
    warehouseId: z.string().min(1).max(64).nullable().optional(),
    contactEmail: z.string().email().max(320).nullable().optional(),
  }).strict(),
  patchable: true,
  filterable: [],
  gatedTransitions: [],
  summarize: (r) => `store "${r.name}" /shop/${r.slug}${r.published ? " (published)" : " (unpublished)"}`,
  hooks: {
    create: async (tx, a, b) => (await lazyStoreAdmin()).createStoreRow(tx, a, b),
    patch: async (tx, a, id, p) => (await lazyStoreAdmin()).patchStoreRow(tx, a, id, p),
  },
};

const storeListingDef: OpsEntityDef = {
  slug: "store-listings",
  label: "Store listing",
  delegate: "opsStoreListing",
  createSchema: z.object({
    storeId: z.string().min(1).max(64),
    productId: z.string().min(1).max(64),
    slug: listingSlugSchema.optional(),
    title: z.string().trim().max(200).optional(),
    description: z.string().max(10_000).optional(),
    imageFileId: z.string().min(1).max(64).optional(),
    position: z.number().int().min(0).max(100_000).default(0),
    listed: z.boolean().default(true),
  }),
  patchSchema: z.object({
    slug: listingSlugSchema.optional(),
    title: z.string().trim().max(200).nullable().optional(),
    description: z.string().max(10_000).nullable().optional(),
    imageFileId: z.string().min(1).max(64).nullable().optional(),
    position: z.number().int().min(0).max(100_000).optional(),
    listed: z.boolean().optional(),
  }).strict(),
  patchable: true,
  filterable: ["storeId", "productId"],
  gatedTransitions: [],
  summarize: (r) => `listing /p/${r.slug} (product ${r.productId})${r.listed === false ? " unlisted" : ""}`,
  hooks: {
    create: async (tx, a, b) => (await lazyStoreAdmin()).createListingRow(tx, a, b),
    patch: async (tx, a, id, p) => (await lazyStoreAdmin()).patchListingRow(tx, a, id, p),
  },
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
  // Phase 10 (finance)
  ...FINANCE_ENTITIES,
  // Phase 10 (ops-core)
  departmentDef,
  leavePolicyDef,
  leaveAdjustmentDef,
  jobOpeningDef,
  applicantDef,
  ticketDef,
  slaPolicyDef,
  taskDef,
  companyDef,
  contactDef,
  dealDef,
  warehouseDef,
  locationDef,
  productVariantDef,
  transferDef,
  reorderRuleDef,
  // Phase 10 (store)
  storeDef,
  storeListingDef,
];

export const OPS_ENTITY_MAP: Record<string, OpsEntityDef> = Object.fromEntries(
  OPS_ENTITIES.map((d) => [d.slug, d]),
);

export const OPS_ENTITY_SLUGS = OPS_ENTITIES.map((d) => d.slug);
