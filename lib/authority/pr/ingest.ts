// Marketr — O2 digital PR: multi-source opportunity ingestion (pure).
// Sources: haro | connectively | qwoted | sos | hab2bw | journo_request.
// Fixtures stand in for digest parsing / feed monitoring; de-dupe across
// sources by journalist+outlet+query fingerprint. No DB here — the route
// layer maps these to prisma rows. This is the memory twin: batteries run
// the same code the route handler runs.

export type PrSourceName =
  | "haro"
  | "connectively"
  | "qwoted"
  | "sos"
  | "hab2bw"
  | "journo_request";

export interface PrOpportunityInput {
  source: PrSourceName;
  journalist: string;
  outlet: string;
  queryText: string;
  deadline: Date | null;
  expertiseTags: string[];
}

export interface IngestedOpportunity extends PrOpportunityInput {
  fingerprint: string;
  sourcesSeen: PrSourceName[];
  parsedAt: Date;
}

/** Normalize a string for fingerprinting: lowercase, strip punctuation, collapse space. */
export function normalizeForFingerprint(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Same journalist + outlet + query fingerprint — used for cross-source de-dupe. */
export function opportunityFingerprint(o: {
  journalist: string;
  outlet: string;
  queryText: string;
}): string {
  return [
    normalizeForFingerprint(o.journalist),
    normalizeForFingerprint(o.outlet),
    normalizeForFingerprint(o.queryText),
  ].join("||");
}

/**
 * De-dupe opportunities across sources. The first-seen record wins; later
 * duplicates are merged into `sourcesSeen` (provenance kept, rows not duplicated).
 */
export function dedupeOpportunities(
  opportunities: PrOpportunityInput[],
): IngestedOpportunity[] {
  const byFingerprint = new Map<string, IngestedOpportunity>();
  for (const o of opportunities) {
    const fingerprint = opportunityFingerprint(o);
    const existing = byFingerprint.get(fingerprint);
    if (existing) {
      if (!existing.sourcesSeen.includes(o.source)) {
        existing.sourcesSeen.push(o.source);
      }
      // Prefer the earlier deadline when duplicates disagree.
      if (o.deadline && (!existing.deadline || o.deadline < existing.deadline)) {
        existing.deadline = o.deadline;
      }
      for (const tag of o.expertiseTags) {
        if (!existing.expertiseTags.includes(tag)) existing.expertiseTags.push(tag);
      }
    } else {
      byFingerprint.set(fingerprint, {
        ...o,
        expertiseTags: [...o.expertiseTags],
        fingerprint,
        sourcesSeen: [o.source],
        parsedAt: new Date(),
      });
    }
  }
  return [...byFingerprint.values()];
}

// ---------------------------------------------------------------------------
// Fixtures: digest parsing / feed monitoring stand-ins.
// These are representative samples, not live queries — real adapters are a
// later milestone (spec §11: no media-database licensing; compete on matching
// + drafting + tracking). Fixtures include one deliberate cross-source
// duplicate so de-dupe is exercised.
// ---------------------------------------------------------------------------

const H = 3600 * 1000;

function relHours(offsetHours: number, base: Date): Date {
  return new Date(base.getTime() + offsetHours * H);
}

export function fixtureOpportunities(now = new Date()): PrOpportunityInput[] {
  return [
    {
      source: "haro",
      journalist: "Maya Chen",
      outlet: "The Register",
      queryText:
        "Seeking cybersecurity founders and CISOs to comment on the rise of AI-generated phishing kits — what defenses actually work for small businesses?",
      deadline: relHours(30, now),
      expertiseTags: ["cybersecurity", "ai", "small-business"],
    },
    {
      // deliberate duplicate of the HARO item, seen via Connectively — de-dupe must merge it
      source: "connectively",
      journalist: "Maya Chen",
      outlet: "The Register",
      queryText:
        "Seeking cybersecurity founders and CISOs to comment on the rise of AI-generated phishing kits — what defenses actually work for small businesses?",
      deadline: relHours(31, now),
      expertiseTags: ["security"],
    },
    {
      source: "connectively",
      journalist: "Jordan Reyes",
      outlet: "TechCrunch",
      queryText:
        "Looking for D2C founders who scaled past $10M without venture funding — bootstrapped playbooks and the trade-offs you accepted.",
      deadline: relHours(72, now),
      expertiseTags: ["d2c", "fundraising", "bootstrapping"],
    },
    {
      source: "qwoted",
      journalist: "Priya Natarajan",
      outlet: "Forbes",
      queryText:
        "Experts needed: how are mid-market companies using AI agents in customer support without losing the human touch?",
      deadline: relHours(6, now),
      expertiseTags: ["ai-agents", "customer-support", "enterprise"],
    },
    {
      source: "sos",
      journalist: "Tom Alvarez",
      outlet: "Small Business Trends",
      queryText:
        "Small business owners: what is the single highest-ROI local marketing tactic you used in 2026?",
      deadline: relHours(120, now),
      expertiseTags: ["local-marketing", "small-business", "seo"],
    },
    {
      source: "hab2bw",
      journalist: "Sofia Lindqvist",
      outlet: "Sifted",
      queryText:
        "B2B SaaS founders in Europe: how are you structuring AI feature pricing — usage-based, seats, or outcome-based?",
      deadline: relHours(54, now),
      expertiseTags: ["saas", "pricing", "ai"],
    },
    {
      source: "journo_request",
      journalist: "David Okafor",
      outlet: "Bloomberg",
      queryText:
        "Request: sources on small-business lending trends after the rate cuts — lenders and borrowers welcome.",
      deadline: relHours(-5, now), // already expired — triage must flag it
      expertiseTags: ["fintech", "lending", "small-business"],
    },
    {
      source: "haro",
      journalist: "Lena Fischer",
      outlet: "Shopify Blog",
      queryText:
        "Seeking email marketing experts for a roundup: the one abandoned-cart tactic that moved the needle in 2026.",
      deadline: relHours(20, now),
      expertiseTags: ["email-marketing", "ecommerce", "cro"],
    },
  ];
}

/** Parse a raw ingestion batch: validate minimally, then de-dupe. Invalid rows are returned separately (never silently dropped). */
export function ingestOpportunities(
  raw: PrOpportunityInput[],
): { ingested: IngestedOpportunity[]; rejected: { row: PrOpportunityInput; reason: string }[] } {
  const valid: PrOpportunityInput[] = [];
  const rejected: { row: PrOpportunityInput; reason: string }[] = [];
  for (const r of raw) {
    if (!r.journalist?.trim() || !r.outlet?.trim() || !r.queryText?.trim()) {
      rejected.push({ row: r, reason: "missing journalist, outlet, or query text" });
      continue;
    }
    valid.push(r);
  }
  return { ingested: dedupeOpportunities(valid), rejected };
}
