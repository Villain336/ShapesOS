// Marketr — cost reconciliation (Phase 4, Track T3; spec F7).
//
// GET /api/mail/reconcile?campaignId=<id> | ?month=YYYY-MM
//   → { scope, estimated, actual, varianceCents, lineItems[], flags[] }
//
// Compares ledger estimates (MailCampaign.estCostCents + MailPiece.costCents
// + EddmOrder.costCents) against provider actuals from two sources:
//   1. automatic: MailWebhookEvent payloads carrying `actualCostCents`
//      (and optionally `campaignId` / `providerPieceId` for attribution —
//      T1 owns webhook ingestion; this route only reads);
//   2. manual: invoice rows imported as MailWebhookEvent with
//      provider = "manual-invoice" (see ./invoices/route.ts).
//
// Variance beyond rounding is flagged. Estimates only on the ledger side —
// no spend is authorized here.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  guardWorkspace,
  httpErrorResponse,
} from "@/lib/enrichment/guard";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReconcileLineItem {
  label: string;
  estimatedCents: number;
  actualCents: number;
  varianceCents: number;
  source: "ledger" | "webhook" | "invoice";
}

export interface ReconcileFlag {
  code: string;
  severity: "warn" | "info";
  message: string;
}

export interface ReconcileReport {
  scope: { type: "campaign"; campaignId: string; campaignName: string } | { type: "month"; month: string };
  estimated: { campaignEstimateCents: number; pieceCostCents: number; eddmCents: number; totalCents: number };
  actual: { webhookCents: number; invoiceCents: number; totalCents: number };
  varianceCents: number;
  lineItems: ReconcileLineItem[];
  flags: ReconcileFlag[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Payload conventions
// ---------------------------------------------------------------------------

const INVOICE_PROVIDER = "manual-invoice";

interface WebhookPayload {
  campaignId?: unknown;
  providerPieceId?: unknown;
  actualCostCents?: unknown;
  costs?: unknown;
  kind?: unknown;
  scope?: unknown;
  totalCents?: unknown;
  vendor?: unknown;
  invoiceNo?: unknown;
}

function asPayload(row: { payload: unknown }): WebhookPayload {
  return (row.payload ?? {}) as WebhookPayload;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------------------
// Scope loading
// ---------------------------------------------------------------------------

interface ScopeData {
  campaigns: Array<{ id: string; name: string; estCostCents: number }>;
  pieceCostCents: number;
  pieceIds: Set<string>;
  piecesMissingCost: number;
  eddmCents: number;
  eddmOrders: Array<{ id: string; name: string }>;
  monthStart?: Date;
  monthEnd?: Date;
}

async function loadCampaignScope(workspaceId: string, campaignId: string): Promise<ScopeData> {
  const campaign = await prisma.mailCampaign.findFirst({
    where: { id: campaignId, workspaceId },
    include: {
      pieces: { select: { id: true, providerPieceId: true, costCents: true } },
    },
  });
  if (!campaign) throw new Error("Mail campaign not found");
  const pieceIds = new Set<string>();
  let pieceCostCents = 0;
  let piecesMissingCost = 0;
  for (const p of campaign.pieces) {
    if (p.providerPieceId) pieceIds.add(p.providerPieceId);
    if (p.costCents == null) piecesMissingCost += 1;
    else pieceCostCents += p.costCents;
  }
  return {
    campaigns: [{ id: campaign.id, name: campaign.name, estCostCents: campaign.estCostCents }],
    pieceCostCents,
    pieceIds,
    piecesMissingCost,
    eddmCents: 0,
    eddmOrders: [],
  };
}

function monthRange(month: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error('month must be "YYYY-MM".');
  const year = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) throw new Error('month must be "YYYY-MM".');
  return { start: new Date(Date.UTC(year, mo - 1, 1)), end: new Date(Date.UTC(year, mo, 1)) };
}

async function loadMonthScope(workspaceId: string, month: string): Promise<ScopeData> {
  const { start, end } = monthRange(month);
  const campaigns = await prisma.mailCampaign.findMany({
    where: {
      workspaceId,
      OR: [{ createdAt: { gte: start, lt: end } }, { mailedAt: { gte: start, lt: end } }],
    },
    include: { pieces: { select: { id: true, providerPieceId: true, costCents: true } } },
  });
  const eddmOrders = await prisma.eddmOrder.findMany({
    where: { workspaceId, createdAt: { gte: start, lt: end }, status: { not: "cancelled" } },
    select: { id: true, name: true, costCents: true },
  });
  const pieceIds = new Set<string>();
  let pieceCostCents = 0;
  let piecesMissingCost = 0;
  for (const c of campaigns) {
    for (const p of c.pieces) {
      if (p.providerPieceId) pieceIds.add(p.providerPieceId);
      if (p.costCents == null) piecesMissingCost += 1;
      else pieceCostCents += p.costCents;
    }
  }
  return {
    campaigns: campaigns.map((c) => ({ id: c.id, name: c.name, estCostCents: c.estCostCents })),
    pieceCostCents,
    pieceIds,
    piecesMissingCost,
    eddmCents: eddmOrders.reduce((s, o) => s + o.costCents, 0),
    eddmOrders: eddmOrders.map((o) => ({ id: o.id, name: o.name })),
    monthStart: start,
    monthEnd: end,
  };
}

// ---------------------------------------------------------------------------
// Actuals
// ---------------------------------------------------------------------------

interface Actuals {
  webhookCents: number;
  invoiceCents: number;
  webhookLines: ReconcileLineItem[];
  invoiceLines: ReconcileLineItem[];
  unprocessedEvents: number;
}

async function loadActuals(
  workspaceId: string,
  scope: ScopeData,
  scopeKey: { type: "campaign"; campaignId: string } | { type: "month"; month: string },
): Promise<Actuals> {
  const campaignIds = new Set(scope.campaigns.map((c) => c.id));
  const where: Prisma.MailWebhookEventWhereInput = {
    workspaceId,
    OR: [{ provider: INVOICE_PROVIDER }, { provider: { not: INVOICE_PROVIDER } }],
  };
  // Month scope: bound webhook events by creation month; campaign scope:
  // attribute by payload campaignId / providerPieceId (no time bound).
  if (scopeKey.type === "month" && scope.monthStart && scope.monthEnd) {
    where.createdAt = { gte: scope.monthStart, lt: scope.monthEnd };
  }
  const events = await prisma.mailWebhookEvent.findMany({
    where,
    select: { provider: true, eventId: true, eventType: true, payload: true, processedAt: true },
  });

  let webhookCents = 0;
  let invoiceCents = 0;
  let unprocessedEvents = 0;
  const webhookLines: ReconcileLineItem[] = [];
  const invoiceLines: ReconcileLineItem[] = [];

  for (const e of events) {
    const p = asPayload(e);
    if (e.provider === INVOICE_PROVIDER) {
      if (p.kind !== "invoice") continue;
      const sc = p.scope as { type?: string; campaignId?: string; month?: string } | undefined;
      const matches =
        scopeKey.type === "campaign"
          ? sc?.type === "campaign" && sc.campaignId === scopeKey.campaignId
          : sc?.type === "month" && sc.month === scopeKey.month;
      if (!matches) continue;
      const total = num(p.totalCents) ?? 0;
      invoiceCents += total;
      invoiceLines.push({
        label: `Invoice ${String(p.invoiceNo ?? e.eventId).slice(0, 40)} (${String(p.vendor ?? "provider").slice(0, 40)})`,
        estimatedCents: 0,
        actualCents: total,
        varianceCents: total,
        source: "invoice",
      });
      continue;
    }
    // Webhook-derived actuals.
    if (e.processedAt == null) unprocessedEvents += 1;
    const actual = num(p.actualCostCents);
    if (actual == null) continue;
    const payloadCampaign = typeof p.campaignId === "string" ? p.campaignId : null;
    const payloadPiece = typeof p.providerPieceId === "string" ? p.providerPieceId : null;
    const belongs =
      scopeKey.type === "campaign"
        ? payloadCampaign === scopeKey.campaignId || (payloadPiece != null && scope.pieceIds.has(payloadPiece))
        : campaignIds.has(payloadCampaign ?? "") || (payloadPiece != null && scope.pieceIds.has(payloadPiece));
    if (!belongs) continue;
    webhookCents += actual;
    webhookLines.push({
      label: `Webhook ${e.eventType} (${e.eventId.slice(0, 24)})`,
      estimatedCents: 0,
      actualCents: actual,
      varianceCents: actual,
      source: "webhook",
    });
  }

  return { webhookCents, invoiceCents, webhookLines, invoiceLines, unprocessedEvents };
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

/** Rounding tolerance: variances within max($1.00, 1% of estimate) are noise. */
export function reconcileFlags(varianceCents: number, estimatedCents: number): ReconcileFlag[] {
  const flags: ReconcileFlag[] = [];
  const tolerance = Math.max(100, Math.round(Math.abs(estimatedCents) * 0.01));
  if (Math.abs(varianceCents) > tolerance) {
    flags.push({
      code: "variance",
      severity: "warn",
      message: `Variance ${varianceCents >= 0 ? "+" : "−"}$${(Math.abs(varianceCents) / 100).toFixed(2)} exceeds the rounding tolerance ($${(tolerance / 100).toFixed(2)}).`,
    });
  }
  return flags;
}

export async function buildReconcileReport(
  workspaceId: string,
  scopeKey: { type: "campaign"; campaignId: string } | { type: "month"; month: string },
): Promise<ReconcileReport> {
  const scope =
    scopeKey.type === "campaign"
      ? await loadCampaignScope(workspaceId, scopeKey.campaignId)
      : await loadMonthScope(workspaceId, scopeKey.month);
  const actuals = await loadActuals(workspaceId, scope, scopeKey);

  const campaignEstimateCents = scope.campaigns.reduce((s, c) => s + c.estCostCents, 0);
  const estimatedTotal = campaignEstimateCents + scope.pieceCostCents + scope.eddmCents;
  const actualTotal = actuals.webhookCents + actuals.invoiceCents;
  const varianceCents = actualTotal - estimatedTotal;

  const lineItems: ReconcileLineItem[] = [
    {
      label: "Campaign estimates (ledger)",
      estimatedCents: campaignEstimateCents,
      actualCents: 0,
      varianceCents: -campaignEstimateCents,
      source: "ledger",
    },
    {
      label: "Per-piece costs (ledger)",
      estimatedCents: scope.pieceCostCents,
      actualCents: 0,
      varianceCents: -scope.pieceCostCents,
      source: "ledger",
    },
  ];
  if (scope.eddmCents > 0 || scope.eddmOrders.length > 0) {
    lineItems.push({
      label: `EDDM order estimates (${scope.eddmOrders.length})`,
      estimatedCents: scope.eddmCents,
      actualCents: 0,
      varianceCents: -scope.eddmCents,
      source: "ledger",
    });
  }
  lineItems.push(...actuals.webhookLines, ...actuals.invoiceLines);

  const flags = reconcileFlags(varianceCents, estimatedTotal);
  if (actualTotal === 0) {
    flags.push({
      code: "no_actuals",
      severity: "info",
      message: "No provider actuals yet — no webhook cost events or invoices in this scope.",
    });
  }
  if (scope.piecesMissingCost > 0) {
    flags.push({
      code: "missing_piece_costs",
      severity: "warn",
      message: `${scope.piecesMissingCost} piece(s) have no ledger cost — estimates are understated.`,
    });
  }
  if (actuals.unprocessedEvents > 0) {
    flags.push({
      code: "unprocessed_events",
      severity: "info",
      message: `${actuals.unprocessedEvents} webhook event(s) not yet processed — actuals may grow.`,
    });
  }

  const scopeOut: ReconcileReport["scope"] =
    scopeKey.type === "campaign"
      ? {
          type: "campaign",
          campaignId: scopeKey.campaignId,
          campaignName: scope.campaigns[0]?.name ?? scopeKey.campaignId,
        }
      : { type: "month", month: scopeKey.month };

  return {
    scope: scopeOut,
    estimated: {
      campaignEstimateCents,
      pieceCostCents: scope.pieceCostCents,
      eddmCents: scope.eddmCents,
      totalCents: estimatedTotal,
    },
    actual: {
      webhookCents: actuals.webhookCents,
      invoiceCents: actuals.invoiceCents,
      totalCents: actualTotal,
    },
    varianceCents,
    lineItems,
    flags,
    generatedAt: new Date().toISOString(),
  };
}

export async function GET(req: Request) {
  try {
    const { workspace } = await guardWorkspace();
    const url = new URL(req.url);
    const campaignId = url.searchParams.get("campaignId");
    const month = url.searchParams.get("month");
    if (campaignId) {
      return Response.json({ report: await buildReconcileReport(workspace.id, { type: "campaign", campaignId }) });
    }
    if (month) {
      return Response.json({ report: await buildReconcileReport(workspace.id, { type: "month", month }) });
    }
    return Response.json({ error: 'Pass ?campaignId=<id> or ?month=YYYY-MM.' }, { status: 400 });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
