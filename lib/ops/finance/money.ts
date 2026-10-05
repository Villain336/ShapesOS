// ShapesOS — Phase 10 (finance): document money math. PURE.
//
// Line-level tax: a line that carries taxRateId gets
//   taxCents = round_half_up(qty × priceCents × rateBps / 10 000)
// computed on the server (never trusted from the client). A document whose
// lines carry no tax rate keeps the legacy free-entry document taxCents.
// Integer cents throughout; the only rounding is the per-line tax.

import { OPS_MAX_CENTS } from "../entities";

export interface MoneyLine {
  qty: number;
  priceCents: number;
  taxRateId?: string | null;
  taxCents?: number | null;
  [key: string]: unknown;
}

export interface DocumentTotals<L> {
  lineItems: L[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** True when the tax came from line tax rates (not the free-entry field). */
  lineTax: boolean;
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/** Half-up rounding of a non-negative a/b with integer inputs (exact, no floats). */
export function divRoundHalfUp(a: number, b: number): number {
  if (b <= 0) throw new MoneyError("divisor must be positive");
  return Math.floor((2 * a + b) / (2 * b));
}

export function lineTaxCents(qty: number, priceCents: number, rateBps: number): number {
  return divRoundHalfUp(qty * priceCents * rateBps, 10_000);
}

/**
 * Compute a document's totals. `rates` maps taxRateId → basis points; an
 * unknown or inactive rate id is an error (never silently untaxed).
 */
export function computeDocumentTotals<L extends MoneyLine>(
  lineItems: L[],
  rates: ReadonlyMap<string, number>,
  documentTaxCents = 0,
): DocumentTotals<L> {
  let subtotalCents = 0;
  let lineTaxTotal = 0;
  let anyRate = false;
  const out = lineItems.map((li) => {
    const net = li.qty * li.priceCents;
    subtotalCents += net;
    if (li.taxRateId) {
      const bps = rates.get(li.taxRateId);
      if (bps === undefined) throw new MoneyError(`Unknown or inactive tax rate "${li.taxRateId}"`);
      anyRate = true;
      const t = lineTaxCents(li.qty, li.priceCents, bps);
      lineTaxTotal += t;
      return { ...li, taxCents: t };
    }
    const { taxCents: _drop, ...rest } = li;
    return rest as L;
  });
  const taxCents = anyRate ? lineTaxTotal : documentTaxCents;
  const totalCents = subtotalCents + taxCents;
  if (totalCents > OPS_MAX_CENTS) throw new MoneyError(`Total exceeds the maximum of ${OPS_MAX_CENTS} cents`);
  return { lineItems: out, subtotalCents, taxCents, totalCents, lineTax: anyRate };
}

/** Balance due on an invoice: total − payments − credit notes (never below 0). */
export function balanceDueCents(inv: { totalCents: number; paidCents?: number | null; creditedCents?: number | null }): number {
  return Math.max(0, inv.totalCents - (inv.paidCents ?? 0) - (inv.creditedCents ?? 0));
}

/**
 * Status after a payment / credit lands. Paid when nothing is left; else the
 * invoice keeps its open status (sent or overdue) — partial payments do not
 * change it, the UI derives "Partially paid" from paidCents > 0.
 */
export function settledStatus(
  inv: { status: string; totalCents: number; paidCents?: number | null; creditedCents?: number | null },
): string {
  return balanceDueCents(inv) === 0 ? "paid" : inv.status;
}

/** Validate an amount applied to an open document. */
export function assertApplicable(amountCents: number, balanceCents: number, what = "Payment"): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new MoneyError(`${what} must be a positive whole number of cents`);
  if (amountCents > balanceCents) {
    throw new MoneyError(`${what} of ${amountCents} cents exceeds the balance due (${balanceCents} cents)`);
  }
}

/** Server-side money formatting. */
export function fmtMoney(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(cents / 100);
}
