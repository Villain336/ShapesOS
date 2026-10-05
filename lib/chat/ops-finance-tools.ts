// ShapesOS — Phase 10 (finance): finance tools for the agent surface.
//
// These are part of OPS_TOOLS (lib/chat/ops-tools.ts spreads
// FINANCE_OPS_TOOLS into it) — same ToolDef contract, same gates, no new
// registry. The shared helpers (runOps, moneyWriteResult, the injectable
// gate port) are reused from ops-tools.ts, imported lazily so the two
// modules never form an initialization cycle.
//
// Safety doctrine (Phase 14 + the money red lane):
//   - ops_accounting_report is a read (safe, viewer).
//   - Drafts (quote, vendor bill) are free logged writes; they ask the chat
//     confirmation like every non-safe tool and can be auto-approved per
//     agent (Tier 0 draft_* kinds).
//   - ops_record_payment and ops_post_journal_entry move money / the books:
//     PROPOSE-ONLY (a Phase 14 approval; the tool throws if anything ever
//     executed) and Tier 3 kinds, so no automation rule can auto-run them.
//   - ops_submit_expense_claim proposes the approval as the claimant;
//     ops_convert_quote creates drafts only (Tier 2, always asks).

import type { Prisma } from "@prisma/client";
import { opsCreate, opsEntityDef, OpsError, type OpsActor } from "@/lib/ops/doctype";
import type { OpsGatePort } from "@/lib/ops/gate";
import { runReport, type BalanceSheet, type ProfitAndLoss, type ReportKind, type TrialBalance, parseReportDate } from "@/lib/ops/accounting";
import { convertQuote } from "@/lib/ops/finance/quotes";
import { billFromPurchaseOrder } from "@/lib/ops/finance/purchasing";
import { submitExpenseClaim } from "@/lib/ops/finance/expenses";
import { fmtMoney } from "@/lib/ops/finance/money";
import type { ToolContext, ToolDef, ToolResult } from "./tools";

type Tx = Prisma.TransactionClient;

const opsTools = () => import("./ops-tools");

async function port(p?: OpsGatePort): Promise<OpsGatePort> {
  return p ?? (await opsTools()).gatePort();
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function int(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) ? n : undefined;
}

function json(raw: unknown, name: string): unknown {
  const s = str(raw);
  if (!s) return undefined;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    throw new Error(`"${name}" must be valid JSON`);
  }
}

function row(r: Awaited<ReturnType<typeof opsCreate>>): Record<string, unknown> {
  if (r.outcome !== "done") throw new Error("expected a draft, got an approval request");
  return r.row;
}

// ---------------------------------------------------------------------------
// Cores — exported for node:test (stub tx + stub gate port).
// ---------------------------------------------------------------------------

export async function draftQuoteCore(tx: Tx, actor: OpsActor, args: Record<string, unknown>, p?: OpsGatePort): Promise<ToolResult> {
  const lineItems = json(args.lineItems, "lineItems");
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new Error('"lineItems" is required (JSON array of {description, qty, priceCents, taxRateId?})');
  }
  const body: Record<string, unknown> = { lineItems };
  for (const k of ["customerId", "customerEmail", "validUntil", "notes"]) if (str(args[k])) body[k] = str(args[k]);
  const tax = int(args.taxCents);
  if (tax !== undefined) body.taxCents = tax;
  const r = row(await opsCreate(tx, opsEntityDef("quotes"), actor, body, { gatePort: await port(p) }));
  return {
    summary: `Draft quote ${String(r.id)} created — ${fmtMoney(Number(r.totalCents))}. Sending it to the customer needs a human approval (Quotes page).`,
    details: r,
  };
}

export async function convertQuoteCore(tx: Tx, actor: OpsActor, args: Record<string, unknown>): Promise<ToolResult> {
  const quoteId = str(args.quoteId);
  const target = str(args.target);
  if (!quoteId || (target !== "invoice" && target !== "order")) throw new Error('"quoteId" and "target" ("invoice" | "order") are required');
  const r = await convertQuote(tx, actor, quoteId, target);
  return {
    summary: r.created
      ? `Quote converted to draft ${target} ${r.id}.${target === "invoice" ? " Sending the invoice still needs approval (ops_send_invoice)." : ""}`
      : `This quote was already converted to ${target} ${r.id}.`,
    details: { target, id: r.id, created: r.created, quoteStatus: r.quote.status },
  };
}

/** Money-write: propose only — never records a payment directly. */
export async function recordPaymentCore(tx: Tx, actor: OpsActor, args: Record<string, unknown>, p?: OpsGatePort): Promise<ToolResult> {
  const invoiceId = str(args.invoiceId);
  const amountCents = int(args.amountCents);
  if (!invoiceId || !amountCents || amountCents <= 0) throw new Error('"invoiceId" and a positive "amountCents" are required');
  const r = await opsCreate(
    tx,
    opsEntityDef("payments"),
    actor,
    { invoiceId, amountCents, kind: "charge", status: "succeeded", provider: str(args.provider) ?? "manual", ...(str(args.note) ? { note: str(args.note) } : {}) },
    { gatePort: await port(p) },
  );
  return (await opsTools()).moneyWriteResult(r);
}

export async function draftVendorBillCore(tx: Tx, actor: OpsActor, args: Record<string, unknown>, p?: OpsGatePort): Promise<ToolResult> {
  const purchaseOrderId = str(args.purchaseOrderId);
  const lineItems = json(args.lineItems, "lineItems");
  if (purchaseOrderId && lineItems === undefined) {
    const { bill, created } = await billFromPurchaseOrder(tx, actor, purchaseOrderId);
    return { summary: `${created ? "Draft bill created" : "Existing bill"} ${bill.id} from purchase order ${purchaseOrderId} — ${fmtMoney(bill.totalCents)}. Posting and paying it are done by a person.`, details: bill };
  }
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new Error('"lineItems" (JSON array of {description, qty, priceCents, taxRateId?, accountId?}) or "purchaseOrderId" is required');
  }
  const body: Record<string, unknown> = { lineItems };
  for (const k of ["vendorId", "purchaseOrderId", "vendorRef", "dueAt", "notes"]) if (str(args[k])) body[k] = str(args[k]);
  const tax = int(args.taxCents);
  if (tax !== undefined) body.taxCents = tax;
  const r = row(await opsCreate(tx, opsEntityDef("vendor-bills"), actor, body, { gatePort: await port(p) }));
  return { summary: `Draft vendor bill ${String(r.id)} created — ${fmtMoney(Number(r.totalCents))}. Posting and paying it are done by a person.`, details: r };
}

export async function submitExpenseClaimCore(tx: Tx, actor: OpsActor, args: Record<string, unknown>, p?: OpsGatePort): Promise<ToolResult> {
  const title = str(args.title);
  const lines = json(args.lines, "lines");
  if (!title || !Array.isArray(lines) || lines.length === 0) {
    throw new Error('"title" and "lines" (JSON array of {spentAt, description, category, amountCents, taxCents?, receiptFileId?}) are required');
  }
  const claim = row(await opsCreate(tx, opsEntityDef("expense-claims"), actor, { title, lines, ...(str(args.notes) ? { notes: str(args.notes) } : {}) }, { gatePort: await port(p) }));
  const { approval, number } = await submitExpenseClaim(tx, actor, String(claim.id), await port(p));
  return {
    summary:
      `Expense claim ${number} (${fmtMoney(Number(claim.totalCents))}) submitted; approval ${approval.id} proposed. ` +
      `Someone other than the claimant approves it in the Actions queue (/dashboard/actions); nothing is posted until then.`,
    details: { approvalRequired: true, approvalId: approval.id, riskTier: approval.riskTier, claimId: claim.id, number },
  };
}

export async function accountingReportCore(tx: Tx, actor: OpsActor, args: Record<string, unknown>): Promise<ToolResult> {
  const kind = (str(args.kind) ?? "profit_and_loss") as ReportKind;
  if (!["trial_balance", "profit_and_loss", "balance_sheet"].includes(kind)) {
    throw new Error('"kind" must be trial_balance, profit_and_loss or balance_sheet');
  }
  const from = parseReportDate(str(args.from), false);
  const to = parseReportDate(str(args.to), true);
  const report = await runReport(tx, actor.workspaceId, kind, { from, to });
  let summary: string;
  if (kind === "profit_and_loss") {
    const r = report as ProfitAndLoss;
    summary = `P&L${from ? ` from ${str(args.from)}` : ""}${to ? ` to ${str(args.to)}` : ""}: income ${fmtMoney(r.totalIncomeCents)}, expenses ${fmtMoney(r.totalExpenseCents)}, net ${fmtMoney(r.netIncomeCents)}.`;
  } else if (kind === "balance_sheet") {
    const r = report as BalanceSheet;
    summary = `Balance sheet${to ? ` as of ${str(args.to)}` : ""}: assets ${fmtMoney(r.totalAssetsCents)}, liabilities ${fmtMoney(r.totalLiabilitiesCents)}, equity ${fmtMoney(r.totalEquityCents)} (incl. current earnings ${fmtMoney(r.currentEarningsCents)}).`;
  } else {
    const r = report as TrialBalance;
    summary = `Trial balance: ${r.rows.length} account(s), debits ${fmtMoney(r.totalDebitCents)} = credits ${fmtMoney(r.totalCreditCents)}${r.balanced ? "" : " — OUT OF BALANCE"}.`;
  }
  return { summary, details: { kind, report } };
}

/** Money-write: propose only — never posts directly. */
export async function postJournalEntryCore(tx: Tx, actor: OpsActor, args: Record<string, unknown>, p?: OpsGatePort): Promise<ToolResult> {
  const lines = json(args.lines, "lines");
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new Error('"lines" is required: JSON array (2+) of {accountCode | accountId, debitCents, creditCents, memo?}');
  }
  const codes = lines.map((l) => str((l as Record<string, unknown>).accountCode)).filter((c): c is string => Boolean(c));
  const byCode = new Map(
    codes.length
      ? (await tx.opsAccount.findMany({ where: { workspaceId: actor.workspaceId, code: { in: codes } }, select: { id: true, code: true } })).map((a) => [a.code, a.id])
      : [],
  );
  const resolved = lines.map((raw, i) => {
    const l = raw as Record<string, unknown>;
    const accountId = str(l.accountId) ?? byCode.get(str(l.accountCode) ?? "");
    if (!accountId) throw new OpsError(400, `Line ${i + 1}: unknown account ${str(l.accountCode) ?? ""}`.trim());
    return { accountId, debitCents: int(l.debitCents) ?? 0, creditCents: int(l.creditCents) ?? 0, ...(str(l.memo) ? { memo: str(l.memo) } : {}) };
  });
  const body: Record<string, unknown> = { lines: resolved };
  if (str(args.memo)) body.memo = str(args.memo);
  if (str(args.entryDate)) body.entryDate = str(args.entryDate);
  const r = await opsCreate(tx, opsEntityDef("journal-entries"), actor, body, { gatePort: await port(p) });
  return (await opsTools()).moneyWriteResult(r);
}

// ---------------------------------------------------------------------------
// ToolDefs
// ---------------------------------------------------------------------------

function run(core: (tx: Tx, actor: OpsActor, args: Record<string, unknown>) => Promise<ToolResult>) {
  return async (ctx: ToolContext, args: Record<string, unknown>) => (await opsTools()).runOps(ctx, (tx, actor) => core(tx, actor, args));
}

export const FINANCE_OPS_TOOLS: ToolDef[] = [
  {
    name: "ops_accounting_report",
    description:
      "Financial report from the books: profit_and_loss (income, expenses, net for a date range), balance_sheet (as of a date) or trial_balance. Read-only.",
    kind: "safe",
    minRole: "viewer",
    argsSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "profit_and_loss (default) | balance_sheet | trial_balance." },
        from: { type: "string", description: "Start date YYYY-MM-DD (P&L only, optional)." },
        to: { type: "string", description: "End / as-of date YYYY-MM-DD (optional, default today)." },
      },
    },
    execute: run(accountingReportCore),
  },
  {
    name: "ops_draft_quote",
    description:
      "Create a DRAFT quote / estimate (free, logged). Totals and per-line tax are computed server-side. Sending it to the customer needs a human approval; accepted quotes convert with ops_convert_quote.",
    kind: "publish",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        lineItems: { type: "string", description: 'JSON array of {description, qty, priceCents, taxRateId?, sku?} (required). Example: [{"description":"Design — 20h","qty":20,"priceCents":15000}]' },
        customerId: { type: "string", description: "CRM lead id of the customer (optional)." },
        customerEmail: { type: "string", description: "Recipient email override (optional)." },
        validUntil: { type: "string", description: "ISO date the quote is valid until (optional)." },
        notes: { type: "string", description: "Notes shown on the quote (optional)." },
        taxCents: { type: "string", description: "Document tax in cents when no line has a tax rate (optional)." },
      },
      required: ["lineItems"],
    },
    execute: run((tx, a, args) => draftQuoteCore(tx, a, args)),
  },
  {
    name: "ops_convert_quote",
    description: "Convert a sent or accepted quote into a DRAFT invoice or order (lines copied, linked both ways; idempotent). Sending the invoice still needs approval.",
    kind: "publish",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        quoteId: { type: "string", description: "Quote id (required)." },
        target: { type: "string", description: '"invoice" or "order" (required).' },
      },
      required: ["quoteId", "target"],
    },
    execute: run(convertQuoteCore),
  },
  {
    name: "ops_record_payment",
    description:
      "PROPOSE recording a customer payment against an invoice (partial payments allowed; money-moving, Tier 3). This only creates a Phase 14 approval — the agent never records payments directly. On approval the payment is applied and posted (Dr Cash / Cr AR).",
    kind: "publish",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        invoiceId: { type: "string", description: "Invoice id (required)." },
        amountCents: { type: "string", description: "Amount received in cents (required, at most the balance due)." },
        note: { type: "string", description: "Reference, e.g. bank transfer id (optional)." },
      },
      required: ["invoiceId", "amountCents"],
    },
    execute: run((tx, a, args) => recordPaymentCore(tx, a, args)),
  },
  {
    name: "ops_draft_vendor_bill",
    description:
      "Create a DRAFT vendor bill (free, logged): from a sent purchase order (purchaseOrderId only), or from lines. Posting it to payables and paying it are done by a person (paying needs approval).",
    kind: "publish",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        purchaseOrderId: { type: "string", description: "Bill a sent purchase order (optional)." },
        vendorId: { type: "string", description: "Vendor id (optional)." },
        vendorRef: { type: "string", description: "The vendor's invoice number (optional)." },
        lineItems: { type: "string", description: "JSON array of {description, qty, priceCents, taxRateId?, accountId?} (required without purchaseOrderId)." },
        taxCents: { type: "string", description: "Document tax in cents when no line has a tax rate (optional)." },
        dueAt: { type: "string", description: "ISO due date (optional; default from vendor terms)." },
      },
    },
    execute: run((tx, a, args) => draftVendorBillCore(tx, a, args)),
  },
  {
    name: "ops_submit_expense_claim",
    description:
      "Create a company expense claim for the current user and submit it for approval (proposes a Phase 14 approval; someone other than the claimant approves). Categories: travel, meals, software, office, rent, utilities, professional, advertising, bank_fees, other.",
    kind: "publish",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "What the claim is for (required)." },
        lines: { type: "string", description: 'JSON array of {spentAt, description, category, amountCents, taxCents?, receiptFileId?} (required). receiptFileId is a Files id.' },
        notes: { type: "string", description: "Notes (optional)." },
      },
      required: ["title", "lines"],
    },
    execute: run((tx, a, args) => submitExpenseClaimCore(tx, a, args)),
  },
  {
    name: "ops_post_journal_entry",
    description:
      "PROPOSE a manual journal entry (moves the books, Tier 3). This only creates a Phase 14 approval — the agent never posts directly. Debits must equal credits; corrections are reversals, never edits.",
    kind: "publish",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        lines: { type: "string", description: 'JSON array (2+) of {accountCode | accountId, debitCents, creditCents, memo?} (required). Example: [{"accountCode":"1000","debitCents":50000,"creditCents":0},{"accountCode":"3000","debitCents":0,"creditCents":50000}]' },
        memo: { type: "string", description: "What the entry is for (optional)." },
        entryDate: { type: "string", description: "ISO date (optional, default today)." },
      },
      required: ["lines"],
    },
    execute: run((tx, a, args) => postJournalEntryCore(tx, a, args)),
  },
];
