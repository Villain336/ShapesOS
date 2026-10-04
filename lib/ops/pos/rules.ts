// ShapesOS — Phase 12 (mfgpos): point-of-sale rules. PURE (no I/O) and
// import-free apart from the status table, so the till screen, the service
// and the tests share one implementation (lib/ops/__tests__/p12-pos.test.ts).
//
//   session        open → closing (cash counted, no more sales) → closed
//                  (one balanced journal entry, gated, Tier 3); closing → open
//                  re-opens the till for a recount
//   tender         the payments of a sale must add up to its total exactly;
//                  cash may be over-tendered (change is given back and never
//                  recorded as takings)
//   totals         derived from the session's orders and payments, never a
//                  running counter: net sales (after discounts, before tax),
//                  tax, cash, card
//   cash count     expected = opening float + cash takings;
//                  difference = counted − expected (+ over, − short)

import { POS_SESSION_TRANSITIONS } from "./states";

export { POS_SESSION_TRANSITIONS };

export function canMoveSession(from: string, to: string): boolean {
  return (POS_SESSION_TRANSITIONS[from] ?? []).includes(to);
}

// ---------------------------------------------------------------------------
// Tender
// ---------------------------------------------------------------------------

export type PosPaymentInput =
  | { method: "cash"; amountCents: number; tenderedCents?: number }
  | { method: "card"; amountCents: number; providerRef: string };

export interface TenderResult {
  cashCents: number;
  cardCents: number;
  changeCents: number;
}

export class TenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenderError";
  }
}

export function tender(totalCents: number, payments: PosPaymentInput[]): TenderResult {
  if (!Array.isArray(payments) || payments.length === 0) throw new TenderError("Add a payment (cash or card)");
  let cash = 0;
  let card = 0;
  let change = 0;
  for (const p of payments) {
    if (!Number.isInteger(p.amountCents) || p.amountCents <= 0) throw new TenderError("Payment amounts must be whole cents above zero");
    if (p.method === "cash") {
      cash += p.amountCents;
      if (p.tenderedCents !== undefined) {
        if (!Number.isInteger(p.tenderedCents) || p.tenderedCents < p.amountCents) {
          throw new TenderError("Cash handed over can't be less than the cash amount");
        }
        change += p.tenderedCents - p.amountCents;
      }
    } else if (p.method === "card") {
      if (!p.providerRef) throw new TenderError("A card payment needs its payment reference");
      card += p.amountCents;
    } else {
      throw new TenderError("Payments are cash or card");
    }
  }
  if (cash + card !== totalCents) {
    throw new TenderError(`Payments (${cash + card}c) must equal the sale total (${totalCents}c)`);
  }
  return { cashCents: cash, cardCents: card, changeCents: change };
}

// ---------------------------------------------------------------------------
// Session totals and the cash count
// ---------------------------------------------------------------------------

export interface SessionOrderLike {
  status: string;
  totalCents: number;
  taxCents: number;
  discountCents: number;
}

export interface SessionPaymentLike {
  provider: string;
  kind: string;
  status: string;
  amountCents: number;
}

export interface SessionTotals {
  orderCount: number;
  /** Σ (total − tax): sales after discounts, before tax. */
  netSalesCents: number;
  discountCents: number;
  taxCents: number;
  cashSalesCents: number;
  cardSalesCents: number;
}

export const isCashProvider = (provider: string) => provider === "cash";
export const isCardProvider = (provider: string) => provider.startsWith("stripe_terminal");

export function sessionTotals(orders: SessionOrderLike[], payments: SessionPaymentLike[]): SessionTotals {
  const live = orders.filter((o) => o.status !== "cancelled");
  const ok = payments.filter((p) => p.status === "succeeded" && p.kind === "charge");
  return {
    orderCount: live.length,
    netSalesCents: live.reduce((s, o) => s + (o.totalCents - o.taxCents), 0),
    discountCents: live.reduce((s, o) => s + o.discountCents, 0),
    taxCents: live.reduce((s, o) => s + o.taxCents, 0),
    cashSalesCents: ok.filter((p) => isCashProvider(p.provider)).reduce((s, p) => s + p.amountCents, 0),
    cardSalesCents: ok.filter((p) => isCardProvider(p.provider)).reduce((s, p) => s + p.amountCents, 0),
  };
}

export function expectedCashCents(openingCashCents: number, cashSalesCents: number): number {
  return openingCashCents + cashSalesCents;
}

export function cashDifferenceCents(countedCashCents: number, expected: number): number {
  return countedCashCents - expected;
}

/** "+$1.50 over" / "$2.00 short" / "exact". */
export function describeDifference(diff: number): string {
  if (diff === 0) return "exact";
  const abs = `$${(Math.abs(diff) / 100).toFixed(2)}`;
  return diff > 0 ? `${abs} over` : `${abs} short`;
}

// ---------------------------------------------------------------------------
// Client order ids (the offline queue's idempotency key)
// ---------------------------------------------------------------------------

/** pos_<time base36>_<random>: sortable, unique per till, safe in URLs. */
export const CLIENT_ORDER_ID_RE = /^pos_[a-z0-9]{6,16}_[a-z0-9]{6,32}$/;

export function newClientOrderId(now: number = Date.now(), random: () => number = cryptoRandom): string {
  let r = "";
  while (r.length < 12) r += Math.floor(random() * 36).toString(36);
  return `pos_${now.toString(36)}_${r}`;
}

function cryptoRandom(): number {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
  if (c?.getRandomValues) return c.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
  return Math.random();
}
