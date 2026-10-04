// Marketr — Phase 17 slice 7: Operations tools on the agent surface.
//
// Registers the Operations (DocType) entities as agent tools following the
// ToolDef pattern in ./tools.ts. These flow into BOTH agent surfaces — the
// JSON chat route and the Phase 16 CopilotKit/AG-UI surface — because both
// run through runAgentTurnWithCapture, which reads TOOLS.
//
// Safety doctrine (Phase 14 + Phase 17 money red lane):
//   - Reads + draft-creators run freely (logged). Draft-creators are kind
//     "publish" so the chat agent's standard confirmation gate ("yes")
//     still applies — but they never need a Phase 14 approval.
//   - Money-moving writes (send invoice, mark paid, approve leave, launch
//     workflow) are PROPOSE-ONLY: the tool calls the ops service WITHOUT an
//     approvalId and returns the pending approval. The agent NEVER executes
//     them directly — execution happens through the ops routes after a human
//     approves in the Actions queue. If a service ever returned "done" for
//     one of these tools, the tool throws (fail-closed).
//   - Every call is audited through the ops audit trail (the ops services
//     write audit rows by construction) and is tenant-scoped via
//     withWorkspaceScope.
//
// Commerce (Medusa) is deferred to Phase 18 — no commerce tools here.

import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import {
  opsCreate,
  opsEntityDef,
  opsList,
  opsPatch,
  type OpsActor,
  type OpsWriteResult,
} from "@/lib/ops/doctype";
import { getOpsSummary } from "@/lib/ops/summary";
import { phase14GatePort, type OpsGatePort } from "@/lib/ops/gate";
import { proposeWorkflowRun, workflowDef } from "@/lib/ops/workflows";
import type { ToolContext, ToolDef, ToolResult } from "./tools";
// Phase 10 (finance): quotes, payments, vendor bills, expense claims,
// accounting reports and journal entries (lib/chat/ops-finance-tools.ts).
import { FINANCE_OPS_TOOLS } from "./ops-finance-tools";

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Injectable gate port (tests pass a stub; production uses Phase 14).
// ---------------------------------------------------------------------------

let testGatePort: OpsGatePort | null = null;

/** Test-only override for the Phase 14 gate port. */
export function __setOpsToolsTestGatePort(p: OpsGatePort | null): void {
  testGatePort = p;
}

/** Exported for the Phase 10 finance tools (same test override). */
export function gatePort(): OpsGatePort {
  return testGatePort ?? phase14GatePort;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function actorOf(ctx: ToolContext): OpsActor {
  return { userId: ctx.userId, workspaceId: ctx.workspaceId };
}

function num(v: unknown, fallback: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(Math.floor(n), max));
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function parseJsonArg(raw: unknown, name: string): unknown {
  const s = str(raw);
  if (!s) return undefined;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    throw new Error(`"${name}" must be valid JSON`);
  }
}

function fmtCents(cents: unknown): string {
  const n = typeof cents === "number" && Number.isFinite(cents) ? cents : 0;
  return `$${(n / 100).toFixed(2)}`;
}

function isLowStock(row: Record<string, unknown>): boolean {
  return (
    row.trackInventory === true &&
    typeof row.stockQty === "number" &&
    typeof row.lowStockThreshold === "number" &&
    row.stockQty <= row.lowStockThreshold
  );
}

function approvalRequiredResult(
  classificationLabel: string | undefined,
  approval: { id: string; riskTier: string },
): ToolResult {
  const label = classificationLabel ?? "operations write";
  return {
    summary:
      `Approval required — "${label}" proposed as approval ${approval.id} ` +
      `(tier ${approval.riskTier}). The human must approve it in the Actions queue ` +
      `(/dashboard/actions); the agent never executes money-moving writes directly.`,
    details: {
      approvalRequired: true,
      approvalId: approval.id,
      riskTier: approval.riskTier,
      label,
    },
  };
}

/** Handle an ops write result from a draft-creator (free writes execute; gated ones propose). */
function draftWriteResult(label: string, r: OpsWriteResult): ToolResult {
  if (r.outcome === "approval_required") {
    return approvalRequiredResult(r.classification.label, r.approval);
  }
  return { summary: `${label}: done`, details: r.row };
}

/**
 * Handle an ops write result from a MONEY-WRITE tool. Fail-closed: these
 * tools propose only — if the service ever returned "done", that is a
 * fail-open bug and the tool throws instead of reporting success.
 */
export function moneyWriteResult(r: OpsWriteResult): ToolResult {
  if (r.outcome !== "approval_required") {
    throw new Error(
      "marketr: money-moving write executed without a Phase 14 approval — refusing to report success",
    );
  }
  return approvalRequiredResult(r.classification.label, r.approval);
}

/** Exported for the Phase 10 finance tools. */
export async function runOps<T>(
  ctx: ToolContext,
  fn: (tx: Tx, actor: OpsActor) => Promise<T>,
): Promise<T> {
  const actor = actorOf(ctx);
  return withWorkspaceScope(ctx.workspaceId, (tx) => fn(tx as Tx, actor));
}

// ---------------------------------------------------------------------------
// Core logic — exported for node:test (stub tx), wrapped by execute() below.
// ---------------------------------------------------------------------------

export async function opsSummaryFor(
  tx: Tx,
  actor: OpsActor,
): Promise<ToolResult> {
  const s = await getOpsSummary(
    tx as unknown as Parameters<typeof getOpsSummary>[0],
    actor.workspaceId,
  );
  return {
    summary:
      `${s.openInvoices} open invoice(s), ${s.overdueInvoices} overdue, ` +
      `${s.lowStockCount} low-stock product(s), ${s.pendingOpsApprovals} pending ops approval(s)`,
    details: s,
  };
}

async function listCore(
  tx: Tx,
  actor: OpsActor,
  slug: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const def = opsEntityDef(slug);
  const filters: Record<string, string> = {};
  for (const f of def.filterable) {
    const v = str(args[f]);
    if (v) filters[f] = v;
  }
  const { rows } = await opsList(tx, def, actor, {
    limit: num(args.limit, 25, 100),
    filters,
  });
  let shown = rows;
  if (slug === "products" && str(args.lowStockOnly) === "true") {
    shown = rows.filter(isLowStock);
  }
  return {
    summary: `${shown.length} ${def.label.toLowerCase()}(s)`,
    details: { rows: shown.map((r) => ({ ...r })) },
  };
}

export async function draftInvoiceCore(
  tx: Tx,
  actor: OpsActor,
  args: Record<string, unknown>,
  port: OpsGatePort = gatePort(),
): Promise<ToolResult> {
  const lineItems = parseJsonArg(args.lineItems, "lineItems");
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new Error('"lineItems" is required (JSON array of {description, qty, priceCents})');
  }
  const body: Record<string, unknown> = { lineItems };
  const customerId = str(args.customerId);
  if (customerId) body.customerId = customerId;
  const tax = num(args.taxCents, NaN, 1_000_000_000);
  if (Number.isFinite(tax)) body.taxCents = tax;
  const dueAt = str(args.dueAt);
  if (dueAt) body.dueAt = dueAt;
  const r = await opsCreate(tx, opsEntityDef("invoices"), actor, body, { gatePort: port });
  const result = draftWriteResult("Draft invoice created", r);
  if (r.outcome === "done") {
    const row = r.row as Record<string, unknown>;
    result.summary = `Draft invoice ${String(row.id)} created — ${fmtCents(row.totalCents)}. Render it with the ops_invoice_card component (invoiceId).`;
  }
  return result;
}

export async function draftPurchaseOrderCore(
  tx: Tx,
  actor: OpsActor,
  args: Record<string, unknown>,
  port: OpsGatePort = gatePort(),
): Promise<ToolResult> {
  const lineItems = parseJsonArg(args.lineItems, "lineItems");
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new Error('"lineItems" is required (JSON array of {name, qty, priceCents, productId?, sku?})');
  }
  const body: Record<string, unknown> = { lineItems };
  const supplierName = str(args.supplierName);
  if (supplierName) body.supplierName = supplierName;
  const supplierId = str(args.supplierId);
  if (supplierId) body.supplierId = supplierId;
  const tax = num(args.taxCents, NaN, 1_000_000_000);
  if (Number.isFinite(tax)) body.taxCents = tax;
  const r = await opsCreate(tx, opsEntityDef("purchase-orders"), actor, body, { gatePort: port });
  return draftWriteResult("Draft purchase order created", r);
}

export async function createProjectCore(
  tx: Tx,
  actor: OpsActor,
  args: Record<string, unknown>,
  port: OpsGatePort = gatePort(),
): Promise<ToolResult> {
  const name = str(args.name);
  if (!name) throw new Error('"name" is required');
  const body: Record<string, unknown> = { name, status: "planning" };
  const customerId = str(args.customerId);
  if (customerId) body.customerId = customerId;
  const milestones = parseJsonArg(args.milestones, "milestones");
  if (milestones !== undefined) {
    if (!Array.isArray(milestones)) throw new Error('"milestones" must be a JSON array of titles');
    body.milestones = milestones.map((t) => ({ title: String(t), status: "open" }));
  }
  const r = await opsCreate(tx, opsEntityDef("projects"), actor, body, { gatePort: port });
  return draftWriteResult("Project created", r);
}

export async function requestLeaveCore(
  tx: Tx,
  actor: OpsActor,
  args: Record<string, unknown>,
  port: OpsGatePort = gatePort(),
): Promise<ToolResult> {
  const memberId = str(args.memberId);
  const type = str(args.type);
  const startDate = str(args.startDate);
  const endDate = str(args.endDate);
  if (!memberId || !type || !startDate || !endDate) {
    throw new Error('"memberId", "type" (vacation|sick|personal), "startDate" and "endDate" are required');
  }
  const r = await opsCreate(
    tx,
    opsEntityDef("leave-requests"),
    actor,
    { memberId, type, startDate, endDate },
    { gatePort: port },
  );
  return draftWriteResult("Leave request drafted", r);
}

/** Money-write: propose only — never executes. */
export async function sendInvoiceCore(
  tx: Tx,
  actor: OpsActor,
  args: Record<string, unknown>,
  port: OpsGatePort = gatePort(),
): Promise<ToolResult> {
  const invoiceId = str(args.invoiceId);
  if (!invoiceId) throw new Error('"invoiceId" is required');
  const r = await opsPatch(
    tx,
    opsEntityDef("invoices"),
    actor,
    { id: invoiceId, status: "sent" },
    { gatePort: port },
  );
  return moneyWriteResult(r);
}

/** Money-write: propose only — never executes. */
export async function markInvoicePaidCore(
  tx: Tx,
  actor: OpsActor,
  args: Record<string, unknown>,
  port: OpsGatePort = gatePort(),
): Promise<ToolResult> {
  const invoiceId = str(args.invoiceId);
  if (!invoiceId) throw new Error('"invoiceId" is required');
  const r = await opsPatch(
    tx,
    opsEntityDef("invoices"),
    actor,
    { id: invoiceId, status: "paid" },
    { gatePort: port },
  );
  return moneyWriteResult(r);
}

/** Money-write: propose only — never executes. */
export async function approveLeaveCore(
  tx: Tx,
  actor: OpsActor,
  args: Record<string, unknown>,
  port: OpsGatePort = gatePort(),
): Promise<ToolResult> {
  const requestId = str(args.requestId);
  if (!requestId) throw new Error('"requestId" is required');
  const r = await opsPatch(
    tx,
    opsEntityDef("leave-requests"),
    actor,
    { id: requestId, status: "approved" },
    { gatePort: port },
  );
  return moneyWriteResult(r);
}

/** Workflow launcher: propose only — never executes. */
export async function launchWorkflowCore(
  tx: Tx,
  actor: OpsActor,
  args: Record<string, unknown>,
  port: OpsGatePort = gatePort(),
): Promise<ToolResult> {
  const workflowName = str(args.workflowName);
  const runKey = str(args.runKey);
  if (!workflowName || !runKey) {
    throw new Error('"workflowName" and "runKey" are required');
  }
  let def;
  try {
    def = workflowDef(workflowName);
  } catch {
    throw new Error(`Unknown workflow "${workflowName}"`);
  }
  const inputs = parseJsonArg(args.inputs, "inputs");
  const { approval, summary } = await proposeWorkflowRun(
    tx,
    actor,
    def,
    { runKey, inputs: (inputs as Record<string, unknown> | undefined) ?? {} },
    { gatePort: port },
  );
  return {
    summary:
      `Workflow "${(def as { label: string }).label}" proposed as approval ${approval.id} ` +
      `(tier ${approval.riskTier}): ${summary} ` +
      `The human must approve it in the Actions queue; the agent never launches workflows directly. ` +
      `Render progress with the ops_workflow_run_card component once the run exists.`,
    details: { approvalRequired: true, approvalId: approval.id, riskTier: approval.riskTier, runKey, summary },
  };
}

// ---------------------------------------------------------------------------
// ToolDef wiring
// ---------------------------------------------------------------------------

function readTool(
  name: string,
  description: string,
  slug: string,
  extraProps: ToolDef["argsSchema"]["properties"] = {},
): ToolDef {
  return {
    name,
    description,
    kind: "safe",
    minRole: "viewer",
    argsSchema: {
      type: "object",
      properties: {
        limit: { type: "string", description: "Max rows to return (default 25, max 100)." },
        ...extraProps,
      },
    },
    async execute(ctx, args) {
      return runOps(ctx, (tx, actor) => listCore(tx, actor, slug, args));
    },
  };
}

export const OPS_TOOLS: ToolDef[] = [
  {
    name: "ops_operations_summary",
    description:
      "Operations pulse: counts of open invoices, overdue invoices, low-stock products, and pending ops approvals for this workspace. Use for status questions like 'how is the business doing'.",
    kind: "safe",
    minRole: "viewer",
    argsSchema: { type: "object", properties: {} },
    async execute(ctx) {
      return runOps(ctx, (tx, actor) => opsSummaryFor(tx, actor));
    },
  },
  readTool(
    "ops_list_invoices",
    "List invoices (id, customer, line items, tax, totals, status, due date). Render a single invoice with the ops_invoice_card generative component (props: invoiceId).",
    "invoices",
    { status: { type: "string", description: "Filter by status: draft | sent | paid | overdue | cancelled." } },
  ),
  readTool(
    "ops_list_products",
    "List catalog products (name, sku, price, stock quantity, low-stock threshold).",
    "products",
    {
      lowStockOnly: {
        type: "string",
        description: 'Set to "true" to return only products at or below their low-stock threshold.',
      },
    },
  ),
  readTool(
    "ops_list_purchase_orders",
    "List purchase orders (id, supplier, line items, totals, status).",
    "purchase-orders",
    { status: { type: "string", description: "Filter by status: draft | sent | received | cancelled." } },
  ),
  readTool(
    "ops_list_projects",
    "List projects (name, customer, milestones, status).",
    "projects",
    { status: { type: "string", description: "Filter by status: planning | active | on_hold | completed | cancelled." } },
  ),
  readTool("ops_list_team", "List team directory members (name, title).", "team-members"),
  readTool(
    "ops_list_workflow_runs",
    "List operations workflow runs (workflow name, run key, step states, status). Render a run with the ops_workflow_run_card generative component (props: runId).",
    "workflow-runs",
    {
      workflowName: { type: "string", description: "Filter by workflow name (e.g. order-payment-fulfillment)." },
      status: { type: "string", description: "Filter by status: running | done | failed | compensated." },
    },
  ),
  {
    name: "ops_draft_invoice",
    description:
      "Create a DRAFT invoice (free, logged — no approval needed). Sending it later requires human approval via ops_send_invoice. Totals are computed server-side from line items. Render the draft with ops_invoice_card (invoiceId).",
    kind: "publish",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        customerId: { type: "string", description: "CRM lead id of the customer (optional)." },
        lineItems: {
          type: "string",
          description: 'JSON array of {description, qty, priceCents} (required). Example: [{"description":"SEO retainer — Oct","qty":1,"priceCents":150000}]',
        },
        taxCents: { type: "string", description: "Tax in cents (optional, default 0)." },
        dueAt: { type: "string", description: "ISO-8601 due date (optional; defaults to sent date + 30 days when sent)." },
      },
      required: ["lineItems"],
    },
    async execute(ctx, args) {
      return runOps(ctx, (tx, actor) => draftInvoiceCore(tx, actor, args));
    },
  },
  {
    name: "ops_draft_purchase_order",
    description:
      "Create a DRAFT purchase order (free, logged — no approval needed). Sending it later requires human approval. Receiving a sent PO books restock inventory transactions automatically.",
    kind: "publish",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        supplierName: { type: "string", description: "Supplier name (free text, optional)." },
        supplierId: { type: "string", description: "Supplier id if known (optional)." },
        lineItems: {
          type: "string",
          description: 'JSON array of {name, qty, priceCents, productId?, sku?} (required). productId links the line to a catalog product for auto-restock on receive.',
        },
        taxCents: { type: "string", description: "Tax in cents (optional, default 0)." },
      },
      required: ["lineItems"],
    },
    async execute(ctx, args) {
      return runOps(ctx, (tx, actor) => draftPurchaseOrderCore(tx, actor, args));
    },
  },
  {
    name: "ops_create_project",
    description: "Create a project (free, logged — no approval needed). Milestones start open; progress is computed from them.",
    kind: "publish",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name (required)." },
        customerId: { type: "string", description: "CRM lead id of the customer (optional)." },
        milestones: { type: "string", description: 'JSON array of milestone titles (optional). Example: ["Kickoff","Design","Launch"]' },
      },
      required: ["name"],
    },
    async execute(ctx, args) {
      return runOps(ctx, (tx, actor) => createProjectCore(tx, actor, args));
    },
  },
  {
    name: "ops_request_leave",
    description: "Draft a leave request for a team member (free, logged — no approval needed). Approving it later requires human approval via ops_approve_leave.",
    kind: "publish",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        memberId: { type: "string", description: "Team member id (required)." },
        type: { type: "string", description: "vacation | sick | personal (required)." },
        startDate: { type: "string", description: "ISO-8601 start date (required)." },
        endDate: { type: "string", description: "ISO-8601 end date (required)." },
      },
      required: ["memberId", "type", "startDate", "endDate"],
    },
    async execute(ctx, args) {
      return runOps(ctx, (tx, actor) => requestLeaveCore(tx, actor, args));
    },
  },
  {
    name: "ops_send_invoice",
    description:
      "PROPOSE sending an invoice (money-moving write). This only creates a Phase 14 approval — the agent never sends directly. The human approves in the Actions queue; only then does the send execute.",
    kind: "publish",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        invoiceId: { type: "string", description: "Invoice id to send (required)." },
      },
      required: ["invoiceId"],
    },
    async execute(ctx, args) {
      return runOps(ctx, (tx, actor) => sendInvoiceCore(tx, actor, args));
    },
  },
  {
    name: "ops_mark_invoice_paid",
    description:
      "PROPOSE marking an invoice paid (money-moving write). This only creates a Phase 14 approval — the agent never records payment directly. The human approves in the Actions queue.",
    kind: "publish",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        invoiceId: { type: "string", description: "Invoice id to mark paid (required)." },
      },
      required: ["invoiceId"],
    },
    async execute(ctx, args) {
      return runOps(ctx, (tx, actor) => markInvoicePaidCore(tx, actor, args));
    },
  },
  {
    name: "ops_approve_leave",
    description:
      "PROPOSE approving a leave request (manager decision, money-adjacent). This only creates a Phase 14 approval — the agent never approves directly. The human approves in the Actions queue.",
    kind: "publish",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", description: "Leave request id to approve (required)." },
      },
      required: ["requestId"],
    },
    async execute(ctx, args) {
      return runOps(ctx, (tx, actor) => approveLeaveCore(tx, actor, args));
    },
  },
  {
    name: "ops_launch_workflow",
    description:
      "PROPOSE launching an operations workflow (e.g. order-payment-fulfillment). This only creates a Phase 14 approval carrying the full step plan + rollback plan — the agent never launches workflows directly. The human approves in the Actions queue.",
    kind: "publish",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        workflowName: { type: "string", description: 'Workflow name (required). Available: "order-payment-fulfillment".' },
        runKey: { type: "string", description: "Idempotency key for the run (required) — replaying a runKey is blocked." },
        inputs: { type: "string", description: 'JSON object of workflow inputs (optional). Example: {"orderId":"ord_123"}' },
      },
      required: ["workflowName", "runKey"],
    },
    async execute(ctx, args) {
      return runOps(ctx, (tx, actor) => launchWorkflowCore(tx, actor, args));
    },
  },
  // Phase 10 (finance)
  ...FINANCE_OPS_TOOLS,
];
