// ShapesOS — Phase 11 (bizsync): export the books to QuickBooks Online / Xero
// (shared engine; providers only translate payloads).
//
// WHAT IS EXPORTED — driven by the append-only journal, so only POSTED
// things leave (drafts never do), in entry-date order:
//   invoice / credit_note / bill / payment / bill_payment entries
//       → the DOCUMENT they were posted for (QBO Invoice / CreditMemo / Bill
//         / Payment / BillPayment; Xero ACCREC / ACCRECCREDIT / ACCPAY /
//         Payments), using the posted entry's accounts;
//   manual / expense / web_order entries → a journal (QBO JournalEntry, Xero
//         ManualJournal), every line through the confirmed account map;
//   reversal entries → a journal ONLY when the entry they reverse was itself
//         exported as a journal; a reversal of a document posting is skipped
//         with "void or credit it in <provider> by hand" (never automated).
// Document-backed entries are never ALSO exported as journals (that would
// double-book the provider's ledger).
//
// IDEMPOTENCY (never double-post): ops_accounting_exports has one row per
// (provider, source key) — "invoice:<id>", "journal:<entryId>"… — claimed
// under an advisory lock BEFORE the remote call. An exported row makes every
// later export of that source a no-op. The provider sees a stable key
// derived from (workspace, provider, source key, attempt): QuickBooks
// ?requestid=, Xero Idempotency-Key. An ambiguous failure (timeout, 5xx,
// rate limit, expired token) keeps the row "pending" with the SAME attempt,
// so the retry returns the original document instead of creating a second;
// only a definitive refusal (4xx validation) marks it "failed" and bumps the
// attempt for the next try after the cause is fixed.
//
// LEDGER RULE: nothing here writes ops_journal_entries / ops_journal_lines,
// and nothing read back from a provider ever changes a local posted entry
// (the DB rejects UPDATE/DELETE on them anyway).

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { ConnectorApiError, scrubMessage } from "@/lib/connectors/m21/live/http";
import { customerContact } from "@/lib/ops/finance/invoicing";
import { findLink, saveLink } from "../links";
import { confirmedMap } from "./mapping";
import type { AccountingProvider, AccountingProviderKey, BillDoc, ExportLine, JournalDoc, PaymentDoc, RemoteAccountRef, SalesDoc } from "./types";

type Tx = Prisma.TransactionClient;

export type ExportDocType = "journal_entry" | "invoice" | "credit_note" | "bill" | "payment" | "bill_payment";
export const EXPORT_DOC_TYPES: readonly ExportDocType[] = ["invoice", "credit_note", "bill", "payment", "bill_payment", "journal_entry"];

const DOC_OF_SOURCE: Readonly<Record<string, Exclude<ExportDocType, "journal_entry">>> = {
  invoice: "invoice",
  credit_note: "credit_note",
  bill: "bill",
  payment: "payment",
  bill_payment: "bill_payment",
};

const PROVIDER_LABEL: Record<AccountingProviderKey, string> = { quickbooks: "QuickBooks", xero: "Xero" };

export type ExportPlan = { docType: ExportDocType; localId: string; sourceKey: string } | { skip: string };

/** What one journal entry exports as. PURE. */
export function planExport(
  entry: { id: string; sourceType: string; sourceId: string | null; reversalOfId: string | null },
  ctx: { provider: AccountingProviderKey; original?: { sourceType: string } | null; originalExported?: boolean },
): ExportPlan {
  const doc = DOC_OF_SOURCE[entry.sourceType];
  if (doc) {
    if (!entry.sourceId) return { skip: `${entry.sourceType} entry without its document id` };
    return { docType: doc, localId: entry.sourceId, sourceKey: `${doc}:${entry.sourceId}` };
  }
  if (entry.sourceType === "reversal" || entry.reversalOfId) {
    const orig = ctx.original?.sourceType;
    if (orig && DOC_OF_SOURCE[orig]) {
      return { skip: `reverses a ${orig.replace("_", " ")} posting — void or credit that ${orig.replace("_", " ")} in ${PROVIDER_LABEL[ctx.provider]} by hand (never automated)` };
    }
    if (!ctx.originalExported) return { skip: "the entry it reverses was not exported — nothing to reverse there" };
  }
  return { docType: "journal_entry", localId: entry.id, sourceKey: `journal:${entry.id}` };
}

/** Split `total` across `weights` in whole cents (largest remainder). PURE. */
export function allocateCents(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (total === 0 || weights.length === 0) return weights.map(() => 0);
  if (sum === 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const raw = weights.map((w) => (Math.max(0, w) * total) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((s, x) => s + x, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i] += 1;
    left -= 1;
  }
  return out;
}

/** Stable provider idempotency key (UUID-shaped, ≤ 36 chars). PURE. */
export function idempotencyKey(workspaceId: string, provider: string, sourceKey: string, attempt: number): string {
  const h = createHash("sha256").update(`${workspaceId}|${provider}|${sourceKey}|${attempt}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Definitive refusals bump the attempt; everything else retries with the same key. PURE. */
export function isDefinitiveFailure(err: unknown): boolean {
  return err instanceof ConnectorApiError && (err.code === "bad_request" || err.code === "forbidden" || err.code === "not_found");
}

export interface ExportReport {
  provider: AccountingProviderKey;
  exported: Array<{ sourceKey: string; remoteId: string; remoteNumber: string | null }>;
  alreadyExported: number;
  skipped: Array<{ sourceKey: string; reason: string }>;
  failures: Array<{ sourceKey: string; error: string; retryable: boolean }>;
  failed: number;
  scanned: number;
  truncated: boolean;
  stopped: string | null;
}

export interface ExportOptions {
  userId: string;
  /** Only entries dated on/after this day. */
  since?: Date | null;
  /** Max documents attempted this run (default 50, max 200). */
  maxDocs?: number;
  only?: readonly ExportDocType[];
}

type JournalRow = { id: string; sourceType: string; sourceId: string | null; reversalOfId: string | null; entryDate: Date; memo: string | null };

type Built =
  | { kind: "sales"; doc: Omit<SalesDoc, "customerRemoteId">; party: PartyRef }
  | { kind: "bill"; doc: Omit<BillDoc, "vendorRemoteId">; party: PartyRef }
  | { kind: "payment"; doc: Omit<PaymentDoc, "partyRemoteId">; party: PartyRef }
  | { kind: "journal"; doc: JournalDoc }
  | { skip: string };

/** The local key a remote customer/vendor is cached under (biz_sync_links). */
interface PartyRef {
  kind: "customer" | "vendor";
  objectType: "invoice_customer" | "vendor";
  localKey: string;
  name: string;
  email: string | null;
}

/** Display name for the remote customer: the CRM company/name, else the email. */
function partyName(customerId: string | null, who: { name: string; email: string | null; company: string | null }): string {
  if (customerId && (who.company || who.name)) return (who.company || who.name)!;
  return who.email ?? "ShapesOS customer";
}

const ROUTE_HINT = "confirm it in Settings → Connectors → Business sync";

function mapped(map: Map<string, RemoteAccountRef>, account: { id: string; code: string; name: string }, provider: AccountingProviderKey): RemoteAccountRef | string {
  return map.get(account.id) ?? `account ${account.code} ${account.name} is not mapped to ${PROVIDER_LABEL[provider]} — ${ROUTE_HINT}`;
}

interface DocLine {
  description?: string;
  name?: string;
  qty?: number;
  priceCents?: number;
  taxCents?: number | null;
  accountId?: string | null;
}

function docLines(v: unknown): DocLine[] {
  return Array.isArray(v) ? (v as DocLine[]) : [];
}

function exportLines(lines: DocLine[], taxCents: number, accountFor: (l: DocLine) => RemoteAccountRef): ExportLine[] {
  const nets = lines.map((l) => Math.round(Number(l.qty ?? 0) * Number(l.priceCents ?? 0)));
  const explicit = lines.map((l) => (typeof l.taxCents === "number" ? l.taxCents : null));
  const tax = explicit.every((t) => t !== null) && explicit.reduce<number>((s, t) => s + (t ?? 0), 0) === taxCents ? (explicit as number[]) : allocateCents(taxCents, nets);
  return lines.map((l, i) => ({
    description: String(l.description ?? l.name ?? "Item").slice(0, 400),
    qty: Number(l.qty ?? 0),
    unitCents: Number(l.priceCents ?? 0),
    amountCents: nets[i]!,
    taxCents: tax[i]!,
    account: accountFor(l),
  }));
}

async function entryLines(tx: Tx, workspaceId: string, entryId: string) {
  return tx.opsJournalLine.findMany({
    where: { workspaceId, entryId },
    include: { account: { select: { id: true, code: true, name: true, type: true } } },
    orderBy: { id: "asc" },
  });
}

async function buildDoc(tx: Tx, workspaceId: string, provider: AccountingProviderKey, entry: JournalRow, plan: Exclude<ExportPlan, { skip: string }>): Promise<Built> {
  const map = await confirmedMap(tx, workspaceId, provider);
  const lines = await entryLines(tx, workspaceId, entry.id);

  if (plan.docType === "journal_entry") {
    const out: JournalDoc["lines"] = [];
    for (const l of lines) {
      const r = mapped(map, l.account, provider);
      if (typeof r === "string") return { skip: r };
      out.push({ account: r, debitCents: l.debitCents, creditCents: l.creditCents, description: l.memo });
    }
    return { kind: "journal", doc: { date: entry.entryDate, memo: entry.memo, number: null, lines: out } };
  }

  if (plan.docType === "invoice" || plan.docType === "credit_note") {
    const inv = await tx.opsInvoice.findFirst({ where: { id: plan.localId, workspaceId } });
    if (!inv) return { skip: "the document no longer exists" };
    // The income account the document was posted to (Cr for an invoice, Dr for a credit note).
    const income = lines
      .filter((l) => l.account.type === "income" && (plan.docType === "invoice" ? l.creditCents > 0 : l.debitCents > 0))
      .sort((a, b) => b.creditCents + b.debitCents - (a.creditCents + a.debitCents))[0];
    if (!income) return { skip: "its posting has no income line" };
    const r = mapped(map, income.account, provider);
    if (typeof r === "string") return { skip: r };
    const items = exportLines(docLines(inv.lineItems), inv.taxCents, () => r);
    const net = items.reduce((s, l) => s + l.amountCents, 0);
    if (net + inv.taxCents !== inv.totalCents) return { skip: `its lines (${net}c) plus tax (${inv.taxCents}c) don't add up to its total (${inv.totalCents}c)` };
    const who = await customerContact(tx, workspaceId, inv.customerId, inv.customerEmail);
    const localKey = inv.customerId ?? (who.email ? `email:${who.email.toLowerCase()}` : "anonymous");
    let creditsRemoteId: string | null = null;
    if (plan.docType === "credit_note" && inv.creditNoteOfId) {
      const orig = await tx.opsAccountingExport.findUnique({ where: { workspaceId_provider_sourceKey: { workspaceId, provider, sourceKey: `invoice:${inv.creditNoteOfId}` } } });
      creditsRemoteId = orig?.status === "exported" ? orig.remoteId : null;
    }
    return {
      kind: "sales",
      doc: { kind: plan.docType, number: inv.number, date: inv.sentAt ?? entry.entryDate, dueDate: plan.docType === "invoice" ? inv.dueAt : null, lines: items, taxCents: inv.taxCents, totalCents: inv.totalCents, creditsRemoteId, memo: null },
      party: { kind: "customer", objectType: "invoice_customer", localKey, name: partyName(inv.customerId, who), email: who.email },
    };
  }

  if (plan.docType === "bill") {
    const bill = await tx.opsVendorBill.findFirst({ where: { id: plan.localId, workspaceId }, include: { vendor: true } });
    if (!bill) return { skip: "the bill no longer exists" };
    if (!bill.vendor) return { skip: "the bill has no vendor — set one before exporting" };
    const general = await tx.opsAccount.findFirst({ where: { workspaceId, systemKey: "expense_general" }, select: { id: true, code: true, name: true } });
    const accounts = await tx.opsAccount.findMany({ where: { workspaceId }, select: { id: true, code: true, name: true } });
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const raw = docLines(bill.lineItems);
    let missing: string | null = null;
    const items = exportLines(raw, bill.taxCents, (l) => {
      const acct = byId.get(l.accountId ?? "") ?? byId.get(bill.vendor!.defaultAccountId ?? "") ?? general;
      if (!acct) {
        missing ??= "the bill line has no expense account";
        return { id: "", code: null, name: "" };
      }
      const r = mapped(map, acct, provider);
      if (typeof r === "string") {
        missing ??= r;
        return { id: "", code: null, name: "" };
      }
      return r;
    });
    if (missing) return { skip: missing };
    const net = items.reduce((s, l) => s + l.amountCents, 0);
    if (net + bill.taxCents !== bill.totalCents) return { skip: `its lines (${net}c) plus tax (${bill.taxCents}c) don't add up to its total (${bill.totalCents}c)` };
    return {
      kind: "bill",
      doc: { number: bill.vendorRef ?? bill.number, date: bill.billDate, dueDate: bill.dueAt, lines: items, taxCents: bill.taxCents, totalCents: bill.totalCents, memo: bill.number ? `ShapesOS ${bill.number}` : null },
      party: { kind: "vendor", objectType: "vendor", localKey: bill.vendor.id, name: bill.vendor.name, email: bill.vendor.email },
    };
  }

  // payment / bill_payment
  const p = await tx.opsPayment.findFirst({ where: { id: plan.localId, workspaceId } });
  if (!p) return { skip: "the payment no longer exists" };
  const isBill = plan.docType === "bill_payment";
  const cashLine = lines.find((l) => (isBill ? l.creditCents > 0 : l.debitCents > 0) && l.account.type === "asset");
  if (!cashLine) return { skip: "its posting has no cash line" };
  const cash = mapped(map, cashLine.account, provider);
  if (typeof cash === "string") return { skip: cash };
  const targetKey = isBill ? `bill:${p.billId}` : `invoice:${p.invoiceId}`;
  const target = (isBill ? p.billId : p.invoiceId)
    ? await tx.opsAccountingExport.findUnique({ where: { workspaceId_provider_sourceKey: { workspaceId, provider, sourceKey: targetKey } } })
    : null;
  if (!target || target.status !== "exported" || !target.remoteId) {
    return { skip: `the ${isBill ? "bill" : "invoice"} it pays is not exported yet — export it first` };
  }
  let party: PartyRef;
  if (isBill) {
    const bill = await tx.opsVendorBill.findFirst({ where: { id: p.billId!, workspaceId }, include: { vendor: true } });
    if (!bill?.vendor) return { skip: "the bill has no vendor" };
    party = { kind: "vendor", objectType: "vendor", localKey: bill.vendor.id, name: bill.vendor.name, email: bill.vendor.email };
  } else {
    const inv = await tx.opsInvoice.findFirst({ where: { id: p.invoiceId!, workspaceId } });
    if (!inv) return { skip: "the invoice no longer exists" };
    const who = await customerContact(tx, workspaceId, inv.customerId, inv.customerEmail);
    party = { kind: "customer", objectType: "invoice_customer", localKey: inv.customerId ?? (who.email ? `email:${who.email.toLowerCase()}` : "anonymous"), name: partyName(inv.customerId, who), email: who.email };
  }
  return {
    kind: "payment",
    doc: { kind: plan.docType, date: entry.entryDate, amountCents: p.amountCents, cashAccount: cash, targetRemoteId: target.remoteId, reference: (p.providerRef ?? p.note ?? null)?.slice(0, 200) ?? null },
    party,
  };
}

async function resolveParty(workspaceId: string, provider: AccountingProvider, party: PartyRef): Promise<string> {
  const cached = await withWorkspaceScope(workspaceId, (tx) => findLink(tx, workspaceId, provider.key, party.objectType, { localId: party.localKey }));
  if (cached) return cached.remoteId;
  const remoteId = await provider.findOrCreateParty(party.kind, { name: party.name.slice(0, 100), email: party.email }, idempotencyKey(workspaceId, provider.key, `${party.objectType}:${party.localKey}`, 1));
  await withWorkspaceScope(workspaceId, async (tx) => {
    // Another document may have linked this remote party already (two local keys, same name).
    const taken = await findLink(tx, workspaceId, provider.key, party.objectType, { remoteId });
    if (!taken) await saveLink(tx, workspaceId, provider.key, party.objectType, remoteId, party.localKey, {}, "push");
  });
  return remoteId;
}

/** Export every not-yet-exported posted source, oldest first. */
export async function exportToAccounting(workspaceId: string, provider: AccountingProvider, opts: ExportOptions): Promise<ExportReport> {
  const report: ExportReport = { provider: provider.key, exported: [], alreadyExported: 0, skipped: [], failures: [], failed: 0, scanned: 0, truncated: false, stopped: null };
  const max = Math.min(Math.max(Math.floor(opts.maxDocs ?? 50), 1), 200);
  const { entries, done, exportedJournals } = await withWorkspaceScope(workspaceId, async (tx) => {
    const entries = await tx.opsJournalEntry.findMany({
      where: { workspaceId, ...(opts.since ? { entryDate: { gte: opts.since } } : {}) },
      orderBy: [{ entryDate: "asc" }, { createdAt: "asc" }],
      select: { id: true, sourceType: true, sourceId: true, reversalOfId: true, entryDate: true, memo: true },
      take: 5000,
    });
    const rows = await tx.opsAccountingExport.findMany({ where: { workspaceId, provider: provider.key, status: "exported" }, select: { sourceKey: true } });
    const keys = new Set(rows.map((r) => r.sourceKey));
    return { entries, done: keys, exportedJournals: keys };
  });
  const byId = new Map(entries.map((e) => [e.id, e]));
  let attempted = 0;
  for (const entry of entries) {
    if (report.stopped) break;
    report.scanned += 1;
    let original: { sourceType: string } | null = null;
    if (entry.reversalOfId) {
      original =
        byId.get(entry.reversalOfId) ??
        (await withWorkspaceScope(workspaceId, (tx) => tx.opsJournalEntry.findFirst({ where: { id: entry.reversalOfId!, workspaceId }, select: { sourceType: true } })));
    }
    const plan = planExport(entry, { provider: provider.key, original, originalExported: entry.reversalOfId ? exportedJournals.has(`journal:${entry.reversalOfId}`) : false });
    if ("skip" in plan) {
      if (!done.has(`journal:${entry.id}`)) report.skipped.push({ sourceKey: `journal:${entry.id}`, reason: plan.skip });
      continue;
    }
    if (done.has(plan.sourceKey)) {
      report.alreadyExported += 1;
      continue;
    }
    if (opts.only?.length && !opts.only.includes(plan.docType)) continue;
    if (attempted >= max) {
      report.truncated = true;
      break;
    }
    attempted += 1;
    await exportOne(workspaceId, provider, entry, plan, opts.userId, report, done);
  }
  return report;
}

async function exportOne(
  workspaceId: string,
  provider: AccountingProvider,
  entry: JournalRow,
  plan: Exclude<ExportPlan, { skip: string }>,
  userId: string,
  report: ExportReport,
  done: Set<string>,
): Promise<void> {
  const built = await withWorkspaceScope(workspaceId, (tx) => buildDoc(tx, workspaceId, provider.key, entry, plan));
  if ("skip" in built) {
    report.skipped.push({ sourceKey: plan.sourceKey, reason: built.skip });
    return;
  }
  const claim = await withWorkspaceScope(workspaceId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`acct:${workspaceId}:${provider.key}:${plan.sourceKey}`}))`;
    const where = { workspaceId_provider_sourceKey: { workspaceId, provider: provider.key, sourceKey: plan.sourceKey } };
    const row = await tx.opsAccountingExport.findUnique({ where });
    if (row?.status === "exported") return null;
    if (!row) {
      return tx.opsAccountingExport.create({ data: { workspaceId, provider: provider.key, sourceKey: plan.sourceKey, docType: plan.docType, localId: plan.localId, entryId: entry.id, status: "pending", createdBy: userId } });
    }
    return row.status === "failed" ? tx.opsAccountingExport.update({ where: { id: row.id, workspaceId }, data: { status: "pending" } }) : row;
  });
  if (!claim) {
    report.alreadyExported += 1;
    done.add(plan.sourceKey);
    return;
  }
  const key = idempotencyKey(workspaceId, provider.key, plan.sourceKey, claim.attempt);
  try {
    let ref;
    if (built.kind === "journal") ref = await provider.createJournal(built.doc, key);
    else {
      const partyId = await resolveParty(workspaceId, provider, built.party);
      if (built.kind === "sales") ref = await provider.createSales({ ...built.doc, customerRemoteId: partyId }, key);
      else if (built.kind === "bill") ref = await provider.createBill({ ...built.doc, vendorRemoteId: partyId }, key);
      else ref = await provider.createPayment({ ...built.doc, partyRemoteId: partyId }, key);
    }
    await withWorkspaceScope(workspaceId, (tx) =>
      tx.opsAccountingExport.update({ where: { id: claim.id, workspaceId }, data: { status: "exported", remoteId: ref.id, remoteNumber: ref.number ?? null, exportedAt: new Date(), lastError: null } }),
    );
    done.add(plan.sourceKey);
    report.exported.push({ sourceKey: plan.sourceKey, remoteId: ref.id, remoteNumber: ref.number ?? null });
  } catch (err) {
    const definitive = isDefinitiveFailure(err);
    const msg = err instanceof Error ? scrubMessage(err.message) : "unexpected error";
    await withWorkspaceScope(workspaceId, (tx) =>
      tx.opsAccountingExport.update({
        where: { id: claim.id, workspaceId },
        data: definitive ? { status: "failed", attempt: { increment: 1 }, lastError: msg.slice(0, 500) } : { status: "pending", lastError: msg.slice(0, 500) },
      }),
    );
    report.failed += 1;
    report.failures.push({ sourceKey: plan.sourceKey, error: msg.slice(0, 300), retryable: !definitive });
    // Auth / reachability / throttling problems affect every document: stop.
    if (err instanceof ConnectorApiError && ["auth_rejected", "provider_unreachable", "rate_limited", "config_missing", "not_connected"].includes(err.code)) {
      report.stopped = `${PROVIDER_LABEL[provider.key]}: ${err.code} — the run stopped; retry later (interrupted documents reuse the same idempotency key).`;
    }
  }
}

export interface ExportStatus {
  exported: number;
  pending: number;
  failed: number;
  lastExportedAt: Date | null;
  recentFailures: Array<{ sourceKey: string; lastError: string | null; updatedAt: Date }>;
}

export async function exportStatus(workspaceId: string, provider: AccountingProviderKey): Promise<ExportStatus> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const groups = await tx.opsAccountingExport.groupBy({ by: ["status"], where: { workspaceId, provider }, _count: { _all: true } });
    const count = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0;
    const last = await tx.opsAccountingExport.findFirst({ where: { workspaceId, provider, status: "exported" }, orderBy: { exportedAt: "desc" }, select: { exportedAt: true } });
    const failures = await tx.opsAccountingExport.findMany({
      where: { workspaceId, provider, status: { in: ["failed", "pending"] } },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: { sourceKey: true, lastError: true, updatedAt: true },
    });
    return { exported: count("exported"), pending: count("pending"), failed: count("failed"), lastExportedAt: last?.exportedAt ?? null, recentFailures: failures };
  });
}
