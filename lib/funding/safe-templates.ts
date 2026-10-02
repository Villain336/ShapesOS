// Marketr — Funding/VC slice 4: SAFE template picker catalog.
// Spec: BUSINESS-OS-FEATURE-SPECS.md §3 (SAFE templates via the Legal
// feature §4).
//
// These are STANDARD template shapes — general information, never legal
// advice. The Legal feature's guardrail carries over verbatim: every SAFE
// surface ships LEGAL_DISCLAIMER. The store records the founder's SELECTION
// as checklist evidence on the `safe_template` item; nothing here drafts,
// fills, or executes an instrument.

import { LEGAL_DISCLAIMER } from "../legal/types";
import { FundingError } from "./types";

export { LEGAL_DISCLAIMER as SAFE_NOT_ADVICE_LABEL };

export const SAFE_TEMPLATE_KEYS = [
  "preseed_valuation_cap",
  "preseed_discount",
  "seed_cap_and_discount",
  "seed_mfn",
] as const;

export type SafeTemplateKey = (typeof SAFE_TEMPLATE_KEYS)[number];

export function isSafeTemplateKey(value: unknown): value is SafeTemplateKey {
  return (
    typeof value === "string" &&
    (SAFE_TEMPLATE_KEYS as readonly string[]).includes(value)
  );
}

export interface SafeTemplateTerm {
  term: string;
  explanation: string;
}

export interface SafeTemplate {
  key: SafeTemplateKey;
  name: string;
  roundFit: string;
  description: string;
  keyTerms: SafeTemplateTerm[];
  whenToUse: string;
  watchOuts: string[];
}

export const SAFE_TEMPLATES: SafeTemplate[] = [
  {
    key: "preseed_valuation_cap",
    name: "Pre-seed SAFE — valuation cap",
    roundFit: "pre-seed",
    description:
      "The classic early SAFE: investors get a ceiling on the price their money converts at, rewarding them for backing you before the price is known.",
    keyTerms: [
      {
        term: "Valuation cap",
        explanation:
          "The maximum company valuation at which the SAFE converts into shares. Lower cap = more shares per dollar for the investor.",
      },
      {
        term: "No discount",
        explanation:
          "This variant relies on the cap alone; the investor converts at the cap price (or the round price if lower).",
      },
    ],
    whenToUse:
      "Your first money in, when valuation is mostly a guess and you want one clean number everyone understands.",
    watchOuts: [
      "A cap set too low over-dilutes founders at the priced round.",
      "Record the cap and date — every SAFE's cap feeds the cap table at conversion.",
    ],
  },
  {
    key: "preseed_discount",
    name: "Pre-seed SAFE — discount",
    roundFit: "pre-seed",
    description:
      "No cap; instead investors convert at a fixed percentage discount to the next priced round (commonly 20%).",
    keyTerms: [
      {
        term: "Discount rate",
        explanation:
          "The percentage shaved off the priced-round share price when the SAFE converts. 20% is the common starting point.",
      },
      {
        term: "No valuation cap",
        explanation:
          "Without a cap, a hot priced round can make the discount nearly worthless to the early investor.",
      },
    ],
    whenToUse:
      "You expect the priced round soon and at a modest valuation, so the discount alone is meaningful protection.",
    watchOuts: [
      "If the priced round lands at a high valuation, discount-only SAFEs convert at a high price — early investors may feel unrewarded.",
    ],
  },
  {
    key: "seed_cap_and_discount",
    name: "Seed SAFE — valuation cap + discount",
    roundFit: "seed",
    description:
      "Both protections: the investor converts at whichever is better for them — the cap price or the discounted round price.",
    keyTerms: [
      {
        term: "Valuation cap",
        explanation: "Ceiling on the conversion valuation, as in the cap-only variant.",
      },
      {
        term: "Discount rate",
        explanation:
          "Percentage discount to the priced round; the investor gets the better of cap vs. discount.",
      },
    ],
    whenToUse:
      "Seed checks where investors want downside protection on both axes — the most common seed SAFE shape.",
    watchOuts: [
      "Stacking multiple cap+discount SAFEs at different caps complicates the conversion math — track every cap.",
    ],
  },
  {
    key: "seed_mfn",
    name: "Seed SAFE — MFN (most favored nation)",
    roundFit: "seed",
    description:
      "A short-form SAFE where the investor automatically gets the best terms you give any later SAFE holder before the priced round.",
    keyTerms: [
      {
        term: "MFN clause",
        explanation:
          "If you later issue SAFEs on better terms, this investor's SAFE upgrades to match — automatically.",
      },
      {
        term: "No cap, no discount of its own",
        explanation:
          "The MFN SAFE borrows its economics from the best later SAFE; on its own it carries minimal terms.",
      },
    ],
    whenToUse:
      "Bridge checks between rounds, or when terms are still settling and you want to take money without re-negotiating every check.",
    watchOuts: [
      "MFN chains can surprise founders — one generous later SAFE reprices every MFN holder.",
      "Track issuance order carefully; the MFN only looks backward at SAFEs issued AFTER it.",
    ],
  },
];

/** Validate a SAFE template selection payload. */
export function validateSafeSelection(input: {
  templateKey?: unknown;
  valuationCapUsd?: unknown;
  discountPct?: unknown;
  note?: unknown;
}): {
  templateKey: SafeTemplateKey;
  valuationCapUsd: number | null;
  discountPct: number | null;
  note: string | null;
} {
  if (!isSafeTemplateKey(input.templateKey)) {
    throw new FundingError(
      "INVALID_TEMPLATE",
      `templateKey must be one of: ${SAFE_TEMPLATE_KEYS.join(", ")}.`,
    );
  }
  const cap =
    input.valuationCapUsd === undefined || input.valuationCapUsd === null
      ? null
      : Number(input.valuationCapUsd);
  if (cap !== null && (!Number.isFinite(cap) || cap <= 0)) {
    throw new FundingError("INVALID_SAFE_PARAM", "valuationCapUsd must be a positive number when set.");
  }
  const discount =
    input.discountPct === undefined || input.discountPct === null
      ? null
      : Number(input.discountPct);
  if (discount !== null && (!Number.isFinite(discount) || discount <= 0 || discount >= 100)) {
    throw new FundingError("INVALID_SAFE_PARAM", "discountPct must be between 0 and 100 when set.");
  }
  // Param/template coherence: a cap-less variant with a cap is a data smell —
  // allow it (founders iterate) but the picker UI warns; never block.
  const note =
    typeof input.note === "string" ? input.note.trim().slice(0, 1000) || null : null;
  return { templateKey: input.templateKey, valuationCapUsd: cap, discountPct: discount, note };
}

export function getSafeTemplate(key: SafeTemplateKey): SafeTemplate {
  const t = SAFE_TEMPLATES.find((s) => s.key === key);
  if (!t) throw new FundingError("INVALID_TEMPLATE", `Unknown SAFE template: ${key}`);
  return t;
}
