// ShapesOS — Phase 21A (WS=agentweb): text folding for matching page-controlled
// labels (PURE). Builds on authority.ts normalizeForTier (NFKD/NFKC, zero-width
// characters, a Cyrillic/Greek homoglyph map) and closes two gaps that matter
// when the text is an attacker's button label rather than our own action name:
//   - upper-case Cyrillic/Greek letters are folded AFTER lower-casing, so
//     "DЕLETE" cannot slip through;
//   - a few more look-alikes (т к н в м, τ κ ν β, dotless i, ø, ł, đ).

import { normalizeForTier } from "@/lib/orchestrator/authority";

const EXTRA: Record<string, string> = {
  "т": "t", // т
  "к": "k", // к
  "н": "h", // н
  "в": "b", // в
  "м": "m", // м
  "г": "r", // г
  "б": "6", // б
  "τ": "t", // τ
  "κ": "k", // κ
  "ν": "v", // ν
  "β": "b", // β
  "η": "n", // η
  "ı": "i", // ı
  "ø": "o", // ø
  "ł": "l", // ł
  "đ": "d", // đ
  "ɡ": "g", // ɡ
};

/** Fold a label for pattern matching: lower-case, de-obfuscated, separators as spaces. */
export function foldLabel(text: string): string {
  const pre = text
    .normalize("NFKC")
    .toLowerCase()
    .split("")
    .map((ch) => EXTRA[ch] ?? ch)
    .join("");
  return normalizeForTier(pre);
}
