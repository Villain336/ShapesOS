// ShapesOS — Phase 10 (finance): the double-entry posting rules. PURE (no
// I/O) so every rule is unit-tested on its own (lib/ops/__tests__/accounting).
//
// A rule turns a business document into journal lines that reference either a
// chart account by its system key ("ar", "sales", "tax_payable", …) or a
// concrete account id. lib/ops/accounting/journal.ts resolves the keys
// against the workspace's chart, validates the balance (and the database
// re-checks it at commit) and writes the entry.
//
//   invoice issued   Dr AR (total)          Cr Sales (net) + Cr Tax payable
//   payment received Dr Cash                Cr AR
//   credit note      Dr Sales + Dr Tax      Cr AR
//   vendor bill      Dr Expense + Dr Input tax   Cr AP (total)
//   bill paid        Dr AP                  Cr Cash
//   expense approved Dr Expense + Dr Input tax   Cr Reimbursements payable
//   expense repaid   Dr Reimbursements payable   Cr Cash
//   pay run posted   Dr Wages + Dr Employer taxes + Dr Benefits
//                    Cr Payroll taxes payable + Cr Deductions payable + Cr Net pay payable
//
// Money is integer cents everywhere; nothing here ever rounds.

import { OPS_MAX_CENTS } from "../entities";

export type SystemAccountKey =
  | "cash"
  | "ar"
  | "inventory"
  | "tax_receivable"
  | "ap"
  | "tax_payable"
  | "reimbursements_payable"
  | "owner_equity"
  | "retained_earnings"
  | "sales"
  | "cogs"
  | "expense_general"
  | "expense_rent"
  | "expense_utilities"
  | "expense_software"
  | "expense_travel"
  | "expense_meals"
  | "expense_office"
  | "expense_professional"
  | "expense_advertising"
  | "expense_bank_fees"
  // Phase 12 (people): payroll.
  | "payroll_tax_payable"
  | "wages_payable"
  | "payroll_deductions_payable"
  | "payroll_wages"
  | "payroll_taxes"
  | "payroll_benefits";

export type AccountRef = { key: SystemAccountKey } | { id: string };

export interface DraftLine {
  account: AccountRef;
  debitCents: number;
  creditCents: number;
  memo?: string;
}

export class UnbalancedEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnbalancedEntryError";
  }
}

const dr = (account: AccountRef, cents: number, memo?: string): DraftLine => ({ account, debitCents: cents, creditCents: 0, memo });
const cr = (account: AccountRef, cents: number, memo?: string): DraftLine => ({ account, debitCents: 0, creditCents: cents, memo });

export function refKey(ref: AccountRef): string {
  return "key" in ref ? `key:${ref.key}` : `id:${ref.id}`;
}

/**
 * Drop zero lines and merge lines on the same account and side (keeps the
 * first memo). Order is stable: the first occurrence wins its position.
 */
export function compactLines(lines: DraftLine[]): DraftLine[] {
  const out: DraftLine[] = [];
  const index = new Map<string, number>();
  for (const l of lines) {
    if (l.debitCents === 0 && l.creditCents === 0) continue;
    const side = l.debitCents > 0 ? "d" : "c";
    const k = `${refKey(l.account)}|${side}`;
    const at = index.get(k);
    if (at === undefined) {
      index.set(k, out.length);
      out.push({ ...l });
    } else {
      out[at]!.debitCents += l.debitCents;
      out[at]!.creditCents += l.creditCents;
    }
  }
  return out;
}

/**
 * The balancing law, in code (the DB enforces it again at commit):
 * at least two lines, each with exactly one positive integer side, and
 * Σ debits = Σ credits > 0, within the int4 money range. Returns the total.
 */
export function assertBalanced(lines: Array<Pick<DraftLine, "debitCents" | "creditCents">>): number {
  if (lines.length < 2) throw new UnbalancedEntryError("A journal entry needs at least two lines");
  let d = 0;
  let c = 0;
  for (const [i, l] of lines.entries()) {
    const okInt = Number.isInteger(l.debitCents) && Number.isInteger(l.creditCents);
    if (!okInt || l.debitCents < 0 || l.creditCents < 0) {
      throw new UnbalancedEntryError(`Line ${i + 1}: amounts must be non-negative whole cents`);
    }
    if ((l.debitCents > 0) === (l.creditCents > 0)) {
      throw new UnbalancedEntryError(`Line ${i + 1}: exactly one of debit or credit must be set`);
    }
    d += l.debitCents;
    c += l.creditCents;
  }
  if (d !== c) {
    throw new UnbalancedEntryError(`Debits (${d}) must equal credits (${c})`);
  }
  if (d > OPS_MAX_CENTS) throw new UnbalancedEntryError(`Entry total exceeds ${OPS_MAX_CENTS} cents`);
  return d;
}

// ---------------------------------------------------------------------------
// Tax split: per-line tax goes to the rate's account (or the default tax
// account); any document-level tax not covered by line taxes goes to the
// default account.
// ---------------------------------------------------------------------------

export interface TaxRateLike {
  id: string;
  rateBps: number;
  salesAccountId?: string | null;
  purchaseAccountId?: string | null;
}

export interface TaxedLine {
  qty: number;
  priceCents: number;
  taxRateId?: string | null;
  taxCents?: number | null;
  accountId?: string | null;
}

export function taxSplit(
  lines: TaxedLine[],
  totalTaxCents: number,
  rates: ReadonlyMap<string, TaxRateLike>,
  side: "sales" | "purchase",
): Array<{ account: AccountRef; cents: number }> {
  const defaultKey: SystemAccountKey = side === "sales" ? "tax_payable" : "tax_receivable";
  const out: Array<{ account: AccountRef; cents: number }> = [];
  let covered = 0;
  for (const l of lines) {
    const t = l.taxCents ?? 0;
    if (!t) continue;
    const rate = l.taxRateId ? rates.get(l.taxRateId) : undefined;
    const accountId = rate ? (side === "sales" ? rate.salesAccountId : rate.purchaseAccountId) : null;
    out.push({ account: accountId ? { id: accountId } : { key: defaultKey }, cents: t });
    covered += t;
  }
  const rest = totalTaxCents - covered;
  if (rest > 0) out.push({ account: { key: defaultKey }, cents: rest });
  return out;
}

// ---------------------------------------------------------------------------
// Document rules
// ---------------------------------------------------------------------------

export interface SalesDocLike {
  totalCents: number;
  taxCents: number;
  lineItems: TaxedLine[];
}

/** Invoice issued (sent): Dr AR total, Cr Sales net, Cr tax per rate account. */
export function invoiceIssueLines(inv: SalesDocLike, rates: ReadonlyMap<string, TaxRateLike> = new Map()): DraftLine[] {
  const net = inv.totalCents - inv.taxCents;
  return compactLines([
    dr({ key: "ar" }, inv.totalCents, "Accounts receivable"),
    cr({ key: "sales" }, net, "Sales"),
    ...taxSplit(inv.lineItems, inv.taxCents, rates, "sales").map((t) => cr(t.account, t.cents, "Sales tax")),
  ]);
}

/** Credit note: the mirror of an invoice issue for the credited amount. */
export function creditNoteLines(note: SalesDocLike, rates: ReadonlyMap<string, TaxRateLike> = new Map()): DraftLine[] {
  const net = note.totalCents - note.taxCents;
  return compactLines([
    dr({ key: "sales" }, net, "Sales returns"),
    ...taxSplit(note.lineItems, note.taxCents, rates, "sales").map((t) => dr(t.account, t.cents, "Sales tax reversed")),
    cr({ key: "ar" }, note.totalCents, "Accounts receivable"),
  ]);
}

/** Customer payment against an invoice: Dr Cash, Cr AR. */
export function paymentReceivedLines(amountCents: number): DraftLine[] {
  return [dr({ key: "cash" }, amountCents, "Payment received"), cr({ key: "ar" }, amountCents, "Accounts receivable")];
}

export interface BillLike {
  totalCents: number;
  taxCents: number;
  lineItems: TaxedLine[];
}

/** Vendor bill posted: Dr expense per line (its account, else the default), Dr input tax, Cr AP total. */
export function billPostLines(
  bill: BillLike,
  rates: ReadonlyMap<string, TaxRateLike> = new Map(),
  defaultExpense: AccountRef = { key: "expense_general" },
): DraftLine[] {
  const expenseLines = bill.lineItems.map((l) =>
    dr(l.accountId ? { id: l.accountId } : defaultExpense, l.qty * l.priceCents, "Expense"),
  );
  const lineNet = bill.lineItems.reduce((s, l) => s + l.qty * l.priceCents, 0);
  const net = bill.totalCents - bill.taxCents;
  // Any difference between the stored net and Σ lines (legacy rows) lands on
  // the default expense account so the entry always balances to the total.
  const adjust = net - lineNet;
  return compactLines([
    ...expenseLines,
    ...(adjust > 0 ? [dr(defaultExpense, adjust, "Expense")] : []),
    ...taxSplit(bill.lineItems, bill.taxCents, rates, "purchase").map((t) => dr(t.account, t.cents, "Input tax")),
    cr({ key: "ap" }, bill.totalCents, "Accounts payable"),
  ]);
}

/** Vendor bill payment: Dr AP, Cr Cash. */
export function billPaymentLines(amountCents: number): DraftLine[] {
  return [dr({ key: "ap" }, amountCents, "Bill payment"), cr({ key: "cash" }, amountCents, "Cash")];
}

/** Expense category → the chart's expense account. Unknown → general. */
export const EXPENSE_CATEGORIES: Readonly<Record<string, SystemAccountKey>> = {
  travel: "expense_travel",
  meals: "expense_meals",
  software: "expense_software",
  office: "expense_office",
  rent: "expense_rent",
  utilities: "expense_utilities",
  professional: "expense_professional",
  advertising: "expense_advertising",
  bank_fees: "expense_bank_fees",
  other: "expense_general",
};

export function expenseAccountFor(category: string, accountId?: string | null): AccountRef {
  if (accountId) return { id: accountId };
  return { key: EXPENSE_CATEGORIES[category] ?? "expense_general" };
}

export interface ExpenseLineLike {
  category: string;
  accountId?: string | null;
  /** Gross amount paid (tax included). */
  amountCents: number;
  /** Recoverable tax inside amountCents. */
  taxCents?: number | null;
}

/** Expense claim approved: Dr expense (net) + Dr input tax, Cr reimbursements payable (gross). */
export function expenseApproveLines(lines: ExpenseLineLike[]): DraftLine[] {
  const total = lines.reduce((s, l) => s + l.amountCents, 0);
  const out: DraftLine[] = [];
  for (const l of lines) {
    const tax = Math.min(l.taxCents ?? 0, l.amountCents);
    out.push(dr(expenseAccountFor(l.category, l.accountId), l.amountCents - tax, "Expense"));
    if (tax > 0) out.push(dr({ key: "tax_receivable" }, tax, "Input tax"));
  }
  out.push(cr({ key: "reimbursements_payable" }, total, "Reimbursements payable"));
  return compactLines(out);
}

/** Expense claim reimbursed: Dr reimbursements payable, Cr Cash. */
export function expenseReimburseLines(totalCents: number): DraftLine[] {
  return [dr({ key: "reimbursements_payable" }, totalCents, "Reimbursement"), cr({ key: "cash" }, totalCents, "Cash")];
}

/** A reversal swaps every line's side. */
export function reversalLines<T extends { debitCents: number; creditCents: number }>(lines: T[]): T[] {
  return lines.map((l) => ({ ...l, debitCents: l.creditCents, creditCents: l.debitCents }));
}

// ---------------------------------------------------------------------------
// Phase 10 (store): a paid storefront order is a cash sale — no invoice, no
// receivable. Sales are booked net of the promotion discount.
//   web order paid   Dr Cash (total)   Cr Sales (total − tax) + Cr Tax payable
// ---------------------------------------------------------------------------

export function webOrderSaleLines(order: { totalCents: number; taxCents: number }, taxAccount: AccountRef = { key: "tax_payable" }): DraftLine[] {
  return compactLines([
    dr({ key: "cash" }, order.totalCents, "Storefront payment"),
    cr({ key: "sales" }, order.totalCents - order.taxCents, "Sales (storefront)"),
    cr(taxAccount, order.taxCents, "Sales tax"),
  ]);
}

// ---------------------------------------------------------------------------
// Phase 12 (people): a posted pay run. Gross pay is the wage expense; the
// employer's own taxes and contributions are expenses on top. What the run
// owes: every withheld and employer tax to the tax authorities, every
// deduction and employer contribution to the benefit providers, and net pay
// to the employees (the money transfer itself happens outside ShapesOS).
//   Dr Salaries and wages (gross)
//   Dr Employer payroll taxes (employer tax)
//   Dr Employee benefits (employer contributions)
//     Cr Payroll taxes payable (employee tax + employer tax)
//     Cr Payroll deductions payable (pre-tax + post-tax + employer contributions)
//     Cr Net pay payable (net)
// Balances because net = gross − pre-tax − employee tax − post-tax.
// ---------------------------------------------------------------------------

export interface PayRunTotals {
  grossCents: number;
  preTaxDeductionCents: number;
  employeeTaxCents: number;
  postTaxDeductionCents: number;
  netCents: number;
  employerTaxCents: number;
  employerContribCents: number;
}

export function payRunPostLines(t: PayRunTotals): DraftLine[] {
  const expected = t.grossCents - t.preTaxDeductionCents - t.employeeTaxCents - t.postTaxDeductionCents;
  if (expected !== t.netCents) {
    throw new UnbalancedEntryError(`Pay run net (${t.netCents}) must equal gross − deductions − employee taxes (${expected})`);
  }
  return compactLines([
    dr({ key: "payroll_wages" }, t.grossCents, "Gross pay"),
    dr({ key: "payroll_taxes" }, t.employerTaxCents, "Employer payroll taxes"),
    dr({ key: "payroll_benefits" }, t.employerContribCents, "Employer contributions"),
    cr({ key: "payroll_tax_payable" }, t.employeeTaxCents + t.employerTaxCents, "Withheld and employer taxes"),
    cr({ key: "payroll_deductions_payable" }, t.preTaxDeductionCents + t.postTaxDeductionCents + t.employerContribCents, "Deductions and contributions"),
    cr({ key: "wages_payable" }, t.netCents, "Net pay"),
  ]);
}

// Phase 12 (people): a paid event registration is a cash sale like a web
// order (no tax line — ticket prices are tax-inclusive or untaxed).
export function eventTicketSaleLines(amountCents: number): DraftLine[] {
  return compactLines([
    dr({ key: "cash" }, amountCents, "Event ticket payment"),
    cr({ key: "sales" }, amountCents, "Sales (event tickets)"),
  ]);
}
