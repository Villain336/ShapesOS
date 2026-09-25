// Marketr — O2 digital PR: coverage attribution (pure).
// submitted → placed → visibility impact chain. Placements feed a domain
// source list consumable by the AEO source-impact scorer (a placed expert
// quote is a citable source).

export interface PlacementInput {
  url: string;
  outlet: string;
  publishDate: Date | null;
  /** Optional observed signals: backlinks gained, referral sessions, social shares. */
  signals?: {
    backlinks?: number;
    referralSessions?: number;
    socialShares?: number;
    quotedAsExpert?: boolean;
  };
}

export interface VisibilityImpact {
  /** 0–100 composite of observed + structural signals. Directional, not a KPI. */
  score: number;
  components: {
    outletTier: number;
    backlinkValue: number;
    engagementValue: number;
    expertQuoteBonus: number;
  };
  notes: string[];
}

/** Tier-1 outlets carry structural visibility weight; others are neutral. */
const TIER1_OUTLETS = new Set(
  [
    "forbes", "techcrunch", "bloomberg", "the new york times", "wall street journal",
    "wired", "the verge", "reuters", "associated press", "the register",
  ].map((s) => s.toLowerCase()),
);

export function outletTierWeight(outlet: string): number {
  return TIER1_OUTLETS.has(outlet.toLowerCase().trim()) ? 40 : 20;
}

/** Compute the visibility impact of a placement. */
export function computeVisibilityImpact(p: PlacementInput): VisibilityImpact {
  const s = p.signals ?? {};
  const notes: string[] = [];
  const outletTier = outletTierWeight(p.outlet);
  notes.push(outletTier === 40 ? `${p.outlet} is tier-1 — structural visibility weight.` : `${p.outlet} carries base outlet weight.`);

  const backlinks = s.backlinks ?? 0;
  const backlinkValue = Math.min(30, backlinks * 10);
  if (backlinks > 0) notes.push(`${backlinks} backlink(s) attributed to the placement.`);

  const referral = s.referralSessions ?? 0;
  const shares = s.socialShares ?? 0;
  const engagementValue = Math.min(20, Math.min(referral, 1000) / 50 + Math.min(shares, 500) / 25);
  if (referral > 0 || shares > 0) notes.push(`${referral} referral sessions, ${shares} social shares observed.`);

  const expertQuoteBonus = s.quotedAsExpert ? 10 : 0;
  if (s.quotedAsExpert) notes.push("Quoted as expert — citable by LLM answers (AEO source).");

  return {
    score: Math.min(100, Math.round(outletTier + backlinkValue + engagementValue + expertQuoteBonus)),
    components: {
      outletTier,
      backlinkValue: Math.round(backlinkValue),
      engagementValue: Math.round(engagementValue),
      expertQuoteBonus,
    },
    notes,
  };
}

/** Extract the registrable domain from a URL (for AEO source-list export). */
export function domainOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** AEO-consumable source list: unique domains of placed coverage. */
export function exportPlacedDomains(placements: PlacementInput[]): { domain: string; placements: number }[] {
  const counts = new Map<string, number>();
  for (const p of placements) {
    const d = domainOf(p.url);
    if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([domain, placements]) => ({ domain, placements }))
    .sort((a, b) => b.placements - a.placements);
}

/** The full chain record: opportunity → placement → impact. */
export function buildAttributionChain(input: {
  opportunityId: string;
  journalist: string;
  outlet: string;
  submittedAt: Date;
  placement: PlacementInput;
}): {
  opportunityId: string;
  journalist: string;
  outlet: string;
  submittedAt: Date;
  placement: PlacementInput;
  impact: VisibilityImpact;
} {
  return { ...input, impact: computeVisibilityImpact(input.placement) };
}
