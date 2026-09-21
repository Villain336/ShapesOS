// Marketr — intent heuristic for keyword ideas.
// Providers return raw phrases; search intent is inferred from modifiers.
// Cheap, deterministic, good enough for filtering (spec §5 flow 1).

import type { KeywordIntentLabel } from "../providers/types";

const TRANSACTIONAL = [
  "buy",
  "purchase",
  "order",
  "deal",
  "deals",
  "discount",
  "coupon",
  "cheap",
  "price",
  "pricing",
  "cost",
  "near me",
  "for sale",
  "quote",
  "hire",
  "book",
];

const COMMERCIAL = [
  "best",
  "top",
  "review",
  "reviews",
  "compare",
  "comparison",
  "vs",
  "versus",
  "alternative",
  "alternatives",
];

const INFORMATIONAL = [
  "how",
  "what",
  "why",
  "when",
  "where",
  "guide",
  "tutorial",
  "tips",
  "learn",
  "examples",
  "meaning",
  "definition",
];

const NAVIGATIONAL = [
  "login",
  "sign in",
  "sign up",
  "official",
  "website",
  "app",
];

export function inferIntent(phrase: string): KeywordIntentLabel {
  const p = ` ${phrase.toLowerCase().trim()} `;
  const hit = (words: string[]) =>
    words.some((w) => p.includes(w === "vs" || w.length <= 3 ? ` ${w} ` : w));
  if (hit(TRANSACTIONAL)) return "transactional";
  if (hit(COMMERCIAL)) return "commercial";
  if (hit(INFORMATIONAL)) return "informational";
  if (hit(NAVIGATIONAL)) return "navigational";
  return "unknown";
}
