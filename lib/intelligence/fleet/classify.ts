// Marketr — Phase 10 M4: pure change-type + category classification.
//
// No network, no DB — every function here is unit-testable on fixtures.
// The AI summary (summarize.ts) refines these signals into prose; the
// classifier gives the fleet deterministic structure even when the LLM is
// unavailable.

import type { ChangeCategory, ClassifiedChange } from "./types";

export interface PageSignals {
  text: string;
  title?: string;
  metaDescription?: string;
}

const CATEGORY_SIGNALS: Array<{ category: ChangeCategory; patterns: RegExp[] }> = [
  {
    category: "pricing",
    patterns: [
      /\bpricing\b/i, /\bprice[sd]?\b/i, /\$\s?\d/, /\/mo\b/i, /\bper month\b/i,
      /\bper seat\b/i, /\bplans?\b/i,
    ],
  },
  {
    category: "offer",
    patterns: [
      /\bfree[- ]trial\b/i, /\bdiscount\b/i, /%\s?off/i, /\bcoupon\b/i, /\blimited[- ]time\b/i,
      /\bdeals?\b/i, /\bsign up\b.*\bfree\b/i, /\bget started\b/i,
    ],
  },
  {
    category: "positioning",
    patterns: [
      /\bmission\b/i, /\bwe help\b/i, /\btrusted by\b/i, /\bwhy choose\b/i,
      /\babout[- ]us\b/i, /\bwho we are\b/i,
    ],
  },
  {
    category: "content",
    patterns: [
      /\bblog\b/i, /\bguide\b/i, /\bhow[- ]to\b/i, /\btutorial\b/i, /\bcase[- ]stud(y|ies)\b/i,
      /\bwhitepaper\b/i, /\bebook\b/i, /\bwebinar\b/i,
    ],
  },
  {
    category: "reviews",
    patterns: [
      /\btestimonial\b/i, /\breview[sd]?\b/i, /\brating\b/i, /\bstars?\b/i,
      /\bcustomer stories\b/i,
    ],
  },
  {
    category: "seo",
    patterns: [
      /\bsitemap\b/i, /\bcanonical\b/i, /\bmeta\b/i, /\bschema\b/i, /\brobots\b/i,
    ],
  },
];

function detectCategory(text: string, url: string): { category: ChangeCategory; signals: string[] } {
  const haystack = `${url}\n${text}`;
  const scores = new Map<ChangeCategory, number>();
  const signals: string[] = [];
  for (const { category, patterns } of CATEGORY_SIGNALS) {
    let hits = 0;
    for (const p of patterns) {
      if (p.test(haystack)) {
        hits++;
        signals.push(`${category}:${p.source.slice(0, 24)}`);
      }
    }
    if (hits > 0) scores.set(category, hits);
  }
  if (scores.size === 0) return { category: "other", signals };
  let best: ChangeCategory = "other";
  let bestScore = 0;
  for (const [cat, score] of scores) {
    if (score > bestScore) {
      bestScore = score;
      best = cat;
    }
  }
  return { category: best, signals };
}

/**
 * Classify a tracked-URL change from before/after snapshots.
 *
 * Rules:
 *  - visible text unchanged but title/meta changed → metadata_updated
 *  - visible text changed AND heading structure shifted a lot → structure_changed
 *  - visible text changed → content_updated
 */
export function classifyChange(
  before: PageSignals,
  after: PageSignals,
  rawHtml?: { before: string; after: string },
): ClassifiedChange {
  const textChanged = before.text !== after.text;
  const metaChanged =
    (before.title ?? "") !== (after.title ?? "") ||
    (before.metaDescription ?? "") !== (after.metaDescription ?? "");

  let changeType: ClassifiedChange["changeType"];
  if (!textChanged && metaChanged) {
    changeType = "metadata_updated";
  } else if (textChanged && rawHtml) {
    const heads = (h: string) => (h.match(/<h[1-6][\s>]/gi) ?? []).length;
    const hb = heads(rawHtml.before);
    const ha = heads(rawHtml.after);
    const denom = Math.max(hb, ha, 1);
    // ≥40% heading-count shift ⇒ structural rework, not a copy tweak.
    changeType = Math.abs(ha - hb) / denom >= 0.4 ? "structure_changed" : "content_updated";
  } else {
    changeType = "content_updated";
  }

  const { category, signals } = detectCategory(after.text, "");
  if (metaChanged && !textChanged) signals.push("meta:title-or-description");
  return { changeType, category, signals };
}

/** Category for a sitemap-level event (page_added/page_removed), judged from
 *  the URL itself when no page text is available yet. */
export function classifySitemapUrl(url: string): ChangeCategory {
  return detectCategory("", url).category;
}
