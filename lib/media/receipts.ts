// Marketr — receipt re-verification against the approved binding.
//
// The route layer captures operator receipts (browser-agent executor or
// human upload); the parsed terms are re-verified here against the
// canonical BuyBinding. An over-cap or mismatched invoice is recorded
// honestly (verified=false, flags) — it must not silently pass as
// verified.

import type { BuyBinding } from "./approvals";

export interface ParsedReceiptTerms {
  vendor: string;
  totalSpendCents: number;
  currency?: string;
  flightStart?: string;
  flightEnd?: string;
  lines?: { label: string; amountCents: number }[];
  invoiceNumber?: string;
}

export interface ReceiptVerification {
  verified: boolean;
  flags: string[];
}

/**
 * Re-verify parsed receipt terms against the approved binding. Pure
 * function — no IO — so it can be unit-tested without a database.
 */
export function verifyReceiptTermsAgainstBinding(
  terms: ParsedReceiptTerms,
  binding: BuyBinding,
): ReceiptVerification {
  const flags: string[] = [];

  if (terms.totalSpendCents > binding.maxTotalSpendCents) {
    flags.push(
      `Invoice spend ${terms.totalSpendCents} exceeds approved max ${binding.maxTotalSpendCents}`,
    );
  }
  if (terms.currency && terms.currency !== binding.currency) {
    flags.push(`Currency mismatch: invoice ${terms.currency} vs binding ${binding.currency}`);
  }
  if (terms.lines && terms.lines.length === binding.lineItems.length) {
    terms.lines.forEach((l, i) => {
      const cap = binding.lineItems[i]?.maxAllowedCents;
      if (typeof cap === "number" && l.amountCents > cap) {
        flags.push(`Line ${i} (${l.label}) ${l.amountCents} exceeds approved max ${cap}`);
      }
    });
  }

  return { verified: flags.length === 0, flags };
}
