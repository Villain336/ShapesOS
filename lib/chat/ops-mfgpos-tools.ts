// ShapesOS — Phase 12 (mfgpos): manufacturing and point-of-sale tools for the
// agent surface. Part of OPS_TOOLS (lib/chat/ops-tools.ts spreads
// MFGPOS_OPS_TOOLS into it) — same ToolDef contract, same runOps scoping and
// the same ops services, so audit + workspace scoping + the Phase 14 gate
// apply by construction.
//
//   ops_list_manufacturing_orders     read (safe, viewer)
//   ops_create_manufacturing_order    a DRAFT order (free, logged; Tier 0)
//   ops_confirm_manufacturing_order   PROPOSE only (OPS_MO_CONFIRM; always asks)
//   ops_log_work_time                 manual time on a work order (Tier 2)
//   ops_complete_manufacturing_order  PROPOSE only (OPS_MO_COMPLETE: moves stock
//                                     and posts costing — Tier 3, never automated)
//   ops_pos_overview                  read (safe, viewer): registers + sessions
//   ops_close_pos_session             PROPOSE only (OPS_POS_SESSION_CLOSE:
//                                     posts the takings — Tier 3)
// The agent never rings up till sales and never counts the cash drawer:
// those are a person's job at the till.

import type { Prisma } from "@prisma/client";
import { opsCreate, opsEntityDef, opsPatch, type OpsActor } from "@/lib/ops/doctype";
import { listMos } from "@/lib/ops/mfg/service";
import { describeDifference } from "@/lib/ops/pos/rules";
import { sessionSummary } from "@/lib/ops/pos/service";
import type { ToolContext, ToolDef, ToolResult } from "./tools";

type Tx = Prisma.TransactionClient;

const opsTools = () => import("./ops-tools");

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function int(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) ? n : undefined;
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

function run(fn: (tx: Tx, actor: OpsActor, args: Record<string, unknown>) => Promise<ToolResult>) {
  return async (ctx: ToolContext, args: Record<string, unknown>) => (await opsTools()).runOps(ctx, (tx, actor) => fn(tx, actor, args));
}

// ---------------------------------------------------------------------------
// Manufacturing
// ---------------------------------------------------------------------------

export async function listManufacturingOrdersCore(tx: Tx, actor: OpsActor, args: Record<string, unknown>): Promise<ToolResult> {
  const status = str(args.status);
  const rows = await listMos(tx, actor.workspaceId, { status, limit: int(args.limit) ?? 25 });
  return {
    summary: `${rows.length} manufacturing order(s)${status ? ` (${status.replace("_", " ")})` : ""}`,
    details: { rows },
  };
}

export async function createManufacturingOrderCore(tx: Tx, actor: OpsActor, args: Record<string, unknown>): Promise<ToolResult> {
  const productId = str(args.productId);
  const qty = int(args.qty);
  if (!productId) throw new Error('"productId" is required');
  if (!qty || qty < 1) throw new Error('"qty" must be a whole number ≥ 1');
  const body: Record<string, unknown> = { productId, qty };
  for (const k of ["routingId", "componentLocationId", "finishedLocationId", "plannedStart", "note"]) if (str(args[k])) body[k] = str(args[k]);
  const r = await opsCreate(tx, opsEntityDef("manufacturing-orders"), actor, body);
  if (r.outcome !== "done") throw new Error("expected a draft, got an approval request");
  const row = r.row;
  return {
    summary: `Draft manufacturing order ${String(row.id)} for ${qty} unit(s) created. Confirming it (components and work orders) needs approval — use ops_confirm_manufacturing_order.`,
    details: row,
  };
}

async function proposeMoMove(tx: Tx, actor: OpsActor, body: Record<string, unknown>): Promise<ToolResult> {
  const { gatePort, moneyWriteResult } = await opsTools();
  const r = await opsPatch(tx, opsEntityDef("manufacturing-orders"), actor, body, { gatePort: gatePort() });
  return moneyWriteResult(r);
}

export async function confirmManufacturingOrderCore(tx: Tx, actor: OpsActor, args: Record<string, unknown>): Promise<ToolResult> {
  const id = str(args.id);
  if (!id) throw new Error('"id" is required');
  return proposeMoMove(tx, actor, { id, status: "confirmed" });
}

export async function completeManufacturingOrderCore(tx: Tx, actor: OpsActor, args: Record<string, unknown>): Promise<ToolResult> {
  const id = str(args.id);
  if (!id) throw new Error('"id" is required');
  const body: Record<string, unknown> = { id, status: "done" };
  const produced = int(args.producedQty);
  const scrapped = int(args.scrappedQty);
  if (produced !== undefined) body.producedQty = produced;
  if (scrapped !== undefined) body.scrappedQty = scrapped;
  return proposeMoMove(tx, actor, body);
}

export async function logWorkTimeCore(tx: Tx, actor: OpsActor, args: Record<string, unknown>): Promise<ToolResult> {
  const workOrderId = str(args.workOrderId);
  const minutes = typeof args.minutes === "number" ? args.minutes : Number(str(args.minutes));
  if (!workOrderId) throw new Error('"workOrderId" is required');
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('"minutes" must be a positive number');
  const r = await opsCreate(tx, opsEntityDef("work-time-logs"), actor, { workOrderId, minutes, ...(str(args.note) ? { note: str(args.note) } : {}) });
  if (r.outcome !== "done") throw new Error("expected a direct write, got an approval request");
  return { summary: `Logged ${minutes} min on work order ${workOrderId}.`, details: r.row };
}

// ---------------------------------------------------------------------------
// Point of sale
// ---------------------------------------------------------------------------

export async function posOverviewCore(tx: Tx, actor: OpsActor): Promise<ToolResult> {
  const registers = await tx.opsPosRegister.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { name: "asc" }, take: 50 });
  const sessions = await tx.opsPosSession.findMany({
    where: { workspaceId: actor.workspaceId },
    orderBy: { openedAt: "desc" },
    take: 20,
  });
  const live = await Promise.all(sessions.filter((s) => s.status !== "closed").map((s) => sessionSummary(tx, actor.workspaceId, s.id)));
  const lines = live.map(
    (s) =>
      `${s.number} on ${s.registerName} is ${s.status}: ${s.totals.orderCount} sale(s), ${money(s.totals.netSalesCents + s.totals.taxCents)} (${money(s.totals.cashSalesCents)} cash, ${money(s.totals.cardSalesCents)} card), expected cash ${money(s.expectedCashCents)}` +
      (s.cashDifferenceCents != null ? `, counted ${money(s.countedCashCents ?? 0)} (${describeDifference(s.cashDifferenceCents)})` : ""),
  );
  return {
    summary: `${registers.length} register(s); ${live.length} open session(s)${lines.length ? ` — ${lines.join("; ")}` : ""}.`,
    details: {
      registers: registers.map((r) => ({ id: r.id, name: r.name, active: r.active, hasReader: Boolean(r.terminalReaderId) })),
      openSessions: live,
      recentClosed: sessions.filter((s) => s.status === "closed").map((s) => ({ id: s.id, number: s.number, closedAt: s.closedAt, netSalesCents: s.netSalesCents, cashDifferenceCents: s.cashDifferenceCents, journalEntryId: s.journalEntryId })),
    },
  };
}

export async function closePosSessionCore(tx: Tx, actor: OpsActor, args: Record<string, unknown>): Promise<ToolResult> {
  const id = str(args.sessionId);
  if (!id) throw new Error('"sessionId" is required');
  const { gatePort, moneyWriteResult } = await opsTools();
  const r = await opsPatch(tx, opsEntityDef("pos-sessions"), actor, { id, status: "closed" }, { gatePort: gatePort() });
  return moneyWriteResult(r);
}

export const MFGPOS_OPS_TOOLS: ToolDef[] = [
  {
    name: "ops_list_manufacturing_orders",
    description: "List manufacturing orders (newest first) with product, quantity, status, produced/scrapped units, work-order progress and costs. Optional status filter: draft, confirmed, in_progress, done, cancelled.",
    kind: "safe",
    minRole: "viewer",
    argsSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by status (optional)." },
        limit: { type: "string", description: "Max rows, default 25 (optional)." },
      },
    },
    execute: run((tx, a, args) => listManufacturingOrdersCore(tx, a, args)),
  },
  {
    name: "ops_create_manufacturing_order",
    description:
      "Create a DRAFT manufacturing order to make a product (free, logged). It uses the product's active routing and the CAD bill of materials that routing points at. Confirming and completing it are separate steps that always ask a person.",
    kind: "publish",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        productId: { type: "string", description: "The product to make (required; must track inventory)." },
        qty: { type: "string", description: "Units to make (required)." },
        routingId: { type: "string", description: "Routing (optional; default the product's active routing)." },
        componentLocationId: { type: "string", description: "Stock location components are taken from (optional)." },
        finishedLocationId: { type: "string", description: "Stock location finished goods go to (optional)." },
        plannedStart: { type: "string", description: "ISO planned start (optional)." },
        note: { type: "string", description: "Note (optional)." },
      },
      required: ["productId", "qty"],
    },
    execute: run((tx, a, args) => createManufacturingOrderCore(tx, a, args)),
  },
  {
    name: "ops_confirm_manufacturing_order",
    description:
      "PROPOSE confirming a draft manufacturing order (snapshots its components from the CAD bill of materials and creates one work order per routing step). This only creates a Phase 14 approval — a person approves it.",
    kind: "publish",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Manufacturing order id (required)." } },
      required: ["id"],
    },
    execute: run((tx, a, args) => confirmManufacturingOrderCore(tx, a, args)),
  },
  {
    name: "ops_log_work_time",
    description: "Log minutes worked on a work order of a confirmed or in-progress manufacturing order (a manual entry; corrections are new entries). Labour cost = logged time × the work centre's hourly rate.",
    kind: "publish",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        workOrderId: { type: "string", description: "Work order id (required)." },
        minutes: { type: "string", description: "Minutes worked (required)." },
        note: { type: "string", description: "Note (optional)." },
      },
      required: ["workOrderId", "minutes"],
    },
    execute: run((tx, a, args) => logWorkTimeCore(tx, a, args)),
  },
  {
    name: "ops_complete_manufacturing_order",
    description:
      "PROPOSE completing a manufacturing order (Tier 3, never automated): on approval it uses up the components, adds the finished goods to stock (scrapped units are written off) and posts the cost of components and labour to the books. This only creates a Phase 14 approval.",
    kind: "publish",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Manufacturing order id (required)." },
        producedQty: { type: "string", description: "Good units made (optional; default the order quantity minus scrap)." },
        scrappedQty: { type: "string", description: "Units spoiled during production (optional; default 0)." },
      },
      required: ["id"],
    },
    execute: run((tx, a, args) => completeManufacturingOrderCore(tx, a, args)),
  },
  {
    name: "ops_pos_overview",
    description: "Point of sale: the registers, each open till session's sales, cash and card takings, the cash expected in the drawer (and the count, once counted), and recently closed sessions.",
    kind: "safe",
    minRole: "viewer",
    argsSchema: { type: "object", properties: {} },
    execute: run((tx, a) => posOverviewCore(tx, a)),
  },
  {
    name: "ops_close_pos_session",
    description:
      "PROPOSE closing a till session whose cash a person has already counted (Tier 3, never automated): on approval its takings — sales, tax, cash, card and any cash difference — are posted to the books as one entry. This only creates a Phase 14 approval.",
    kind: "publish",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: { sessionId: { type: "string", description: "Till session id (required; must be counted, i.e. closing)." } },
      required: ["sessionId"],
    },
    execute: run((tx, a, args) => closePosSessionCore(tx, a, args)),
  },
];
