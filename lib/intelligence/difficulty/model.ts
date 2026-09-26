// Marketr — Phase 10 M5: modeled difficulty engine — the model itself.
//
// KD = 0.50 × linkStrength + 0.30 × authorityGap + 0.20 × serpCrowding
//
//   linkStrength  — median blended authority (0–100) of the top-10 SERP domains.
//                   "How strong are the pages you must beat."
//   authorityGap  — clamp(medianAuthority − ownAuthority, 0, 100). Defaults to
//                   a fresh-site baseline (own = 0) when no domain is given.
//   serpCrowding  — SERP-feature crowding penalty: an AI Overview alone eats
//                   ~half the organic opportunity; each extra feature adds up.
//
// Volume is NEVER a point value — it arrives as a band, and the width of that
// band widens the uncertainty interval. The output is always an estimate with
// an uncertainty band and full input provenance, never a bare score.
//
// Pure module: no network, no DB, no env. All I/O lives in service.ts /
// authority.ts. Tested in __tests__/model.test.ts.

export const MODEL_VERSION = "m5-v1";

export type AuthoritySourceId = "moz" | "openpagerank" | "cc_graph";

/** Raw per-domain signals from the three authority adapters (any may be absent). */
export interface RawAuthoritySignals {
  domain: string;
  /** Moz Domain Authority, 0–100. */
  mozDA?: number | null;
  /** Open PageRank integer, 0–10. */
  oprInteger?: number | null;
  /** CC hyperlink-graph domain PageRank position (1 = strongest). */
  ccPrPos?: number | null;
  /** CC hyperlink-graph harmonic-centrality position (1 = strongest). */
  ccHarmoniccPos?: number | null;
  /** Domains ranked in the CC graph release (default ~90M, the domain-graph size). */
  ccGraphSize?: number | null;
}

export interface BlendedSource {
  source: AuthoritySourceId;
  /** Effective weight in the blend (0–1). CC never exceeds 0.50. */
  weight: number;
}

export interface AuthorityBlend {
  domain: string;
  /** Blended authority, 0–100. */
  score: number;
  sources: BlendedSource[];
  /** 0–1: fraction of the full signal budget the available sources covered. */
  confidence: number;
  /** True when the 0.50 CC cap bound (CC-only or CC-dominant input). */
  ccCapped: boolean;
}

/**
 * Blend weights (full-budget shares). CC is CONFIDENCE-CAPPED at 0.50
 * (§M5: quarterly freshness, domain-level only, no anchors — it may inform
 * at most half of any domain's authority score).
 */
const BASE_WEIGHTS: Record<AuthoritySourceId, number> = {
  moz: 0.35,
  openpagerank: 0.3,
  cc_graph: 0.35,
};
const CC_WEIGHT_CAP = 0.5;

function clamp01to100(v: number): number {
  return Math.min(100, Math.max(0, v));
}

/** CC rank position → 0–100 authority: log-percentile of the graph. */
export function ccRankToScore(pos: number, graphSize: number): number {
  if (!Number.isFinite(pos) || pos < 1) return 0;
  const size = Math.max(1_000, graphSize);
  const score = 100 * (1 - Math.log10(Math.min(pos, size)) / Math.log10(size));
  return clamp01to100(score);
}

function normalizeSignal(source: AuthoritySourceId, raw: RawAuthoritySignals): number | null {
  switch (source) {
    case "moz":
      return raw.mozDA == null ? null : clamp01to100(raw.mozDA);
    case "openpagerank":
      return raw.oprInteger == null ? null : clamp01to100(raw.oprInteger * 10);
    case "cc_graph": {
      const size = raw.ccGraphSize ?? 90_000_000;
      const positions = [raw.ccPrPos, raw.ccHarmoniccPos].filter(
        (p): p is number => p != null,
      );
      if (positions.length === 0) return null;
      // Best (lowest) rank across the two CC orderings.
      return ccRankToScore(Math.min(...positions), size);
    }
  }
}

/**
 * Blend one domain's available authority signals into a 0–100 score.
 * Missing sources don't drag the score down — they drag CONFIDENCE down.
 * The CC contribution is hard-capped at 0.50 of the blend.
 */
export function blendAuthority(raw: RawAuthoritySignals): AuthorityBlend {
  const domain = raw.domain;
  const available: Array<{ source: AuthoritySourceId; score: number }> = [];
  for (const source of Object.keys(BASE_WEIGHTS) as AuthoritySourceId[]) {
    const score = normalizeSignal(source, raw);
    if (score != null) available.push({ source, score });
  }

  if (available.length === 0) {
    return { domain, score: 50, sources: [], confidence: 0, ccCapped: false };
  }

  const totalBase = available.reduce((s, a) => s + BASE_WEIGHTS[a.source], 0);
  // Normalize available shares, then enforce the CC cap.
  let weights = new Map<AuthoritySourceId, number>(
    available.map((a) => [a.source, BASE_WEIGHTS[a.source] / totalBase]),
  );
  let ccCapped = false;
  const ccW = weights.get("cc_graph");
  if (ccW != null && ccW > CC_WEIGHT_CAP) {
    ccCapped = true;
    weights.set("cc_graph", CC_WEIGHT_CAP);
    const rest = 1 - CC_WEIGHT_CAP;
    const restOld = 1 - ccW;
    for (const [s, w] of weights) {
      if (s !== "cc_graph") weights.set(s, (w / restOld) * rest);
    }
  }

  let score = 0;
  const sources: BlendedSource[] = [];
  for (const a of available) {
    const w = weights.get(a.source) ?? 0;
    score += w * a.score;
    sources.push({ source: a.source, weight: round2(w) });
  }
  return {
    domain,
    score: Math.round(clamp01to100(score)),
    sources,
    confidence: round2(totalBase),
    ccCapped,
  };
}

// ── SERP / volume inputs ─────────────────────────────────────────────────────

export interface SerpInput {
  results: Array<{ position: number; url: string; domain: string; title: string }>;
  aiOverviewPresent: boolean;
  serpFeatures: string[];
}

export interface VolumeInput {
  /** Display band, e.g. "1K–10K" — never a point value. */
  band: string;
  /** Numeric range the band maps to. */
  lo: number;
  hi: number;
  source: string;
}

/** Map an M6 VolumeBand string to its numeric range. */
export function bandToRange(band: string): { lo: number; hi: number } {
  switch (band) {
    case "0–10": return { lo: 0, hi: 10 };
    case "10–100": return { lo: 10, hi: 100 };
    case "100–1K": return { lo: 100, hi: 1_000 };
    case "1K–10K": return { lo: 1_000, hi: 10_000 };
    case "10K–100K": return { lo: 10_000, hi: 100_000 };
    case "100K–1M": return { lo: 100_000, hi: 1_000_000 };
    case "1M+": return { lo: 1_000_000, hi: 10_000_000 };
    default: return { lo: 0, hi: 10_000_000 }; // unknown band → widest, honest
  }
}

export interface ModelInputs {
  keyword: string;
  locale: string;
  serp: SerpInput;
  /** Blended authority keyed by normalized domain. Domains with no data are simply absent. */
  authority: Map<string, AuthorityBlend>;
  /** Null when no volume source could serve the keyword — band widens accordingly. */
  volume: VolumeInput | null;
  /** The user's own domain authority 0–100; null = unknown → fresh-site baseline 0. */
  ownDomainAuthority?: number | null;
  serpVendor: string;
}

export interface InputsProvenance {
  serpVendor: string;
  authoritySources: Array<{
    source: AuthoritySourceId;
    weight: number;
    domainsCovered: number;
  }>;
  ccWeightCapped: boolean;
  volumeBand: string | null;
  volumeSource: string | null;
  ownAuthorityProvided: boolean;
  featureCount: number;
  aiOverviewPresent: boolean;
  modelVersion: string;
}

export interface DifficultyOutput {
  estimate: number;
  uncertaintyBand: [number, number];
  uncertainty: number;
  components: {
    linkStrength: number;
    authorityGap: number;
    serpCrowding: number;
    medianDomainAuthority: number;
    domainsWithAuthority: number;
  };
  inputsProvenance: InputsProvenance;
  modelVersion: string;
}

/** Lowercase, strip scheme/www/port/path — the same domain from any URL shape. */
export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").split("/")[0];
  d = d.split(":")[0];
  if (d.startsWith("www.")) d = d.slice(4);
  return d;
}

function median(values: number[]): number {
  if (values.length === 0) return 50; // no signal → neutral, confidence pays the price
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Per-feature crowding weights. ai_overview is counted once (flag OR token). */
const FEATURE_WEIGHTS: Record<string, number> = {
  ai_overview: 50,
  featured_snippet: 15,
  knowledge_panel: 15,
  local_pack: 15,
  video_carousel: 10,
  image_pack: 10,
  top_stories: 10,
  shopping: 10,
  people_also_ask: 6,
};

function crowdingScore(aiOverviewPresent: boolean, serpFeatures: string[]): number {
  const seen = new Set(serpFeatures.map((f) => f.trim().toLowerCase()));
  if (aiOverviewPresent) seen.add("ai_overview");
  let score = 0;
  for (const f of seen) score += FEATURE_WEIGHTS[f] ?? 4; // unknown feature → small weight
  return Math.min(100, score);
}

const MODEL_WEIGHTS = { linkStrength: 0.5, authorityGap: 0.3, serpCrowding: 0.2 };

export function computeDifficulty(inputs: ModelInputs): DifficultyOutput {
  const top10 = inputs.serp.results.slice(0, 10);

  const authScores: number[] = [];
  const sourceCoverage = new Map<AuthoritySourceId, number>();
  let ccCapped = false;
  let sourceCountSum = 0;
  for (const r of top10) {
    const blend = inputs.authority.get(normalizeDomain(r.domain));
    if (!blend || blend.sources.length === 0) continue;
    authScores.push(blend.score);
    sourceCountSum += blend.sources.length;
    for (const s of blend.sources) {
      sourceCoverage.set(s.source, (sourceCoverage.get(s.source) ?? 0) + 1);
    }
    if (blend.ccCapped) ccCapped = true;
  }

  const medianAuthority = authScores.length > 0 ? median(authScores) : 50;
  const linkStrength = Math.round(medianAuthority);
  const own = inputs.ownDomainAuthority ?? 0; // fresh-site baseline when unknown
  const authorityGap = Math.round(
    Math.min(100, Math.max(0, medianAuthority - own)),
  );
  const serpCrowding = Math.round(
    crowdingScore(inputs.serp.aiOverviewPresent, inputs.serp.serpFeatures),
  );

  const estimate = Math.round(
    Math.min(
      100,
      Math.max(
        0,
        MODEL_WEIGHTS.linkStrength * linkStrength +
          MODEL_WEIGHTS.authorityGap * authorityGap +
          MODEL_WEIGHTS.serpCrowding * serpCrowding,
      ),
    ),
  );

  // ── Uncertainty ──────────────────────────────────────────────────────────
  // Base ±6, then the model pays for what it doesn't know:
  //  - thin authority coverage across the top-10,
  //  - wide volume bands (volume is a band, not truth),
  //  - missing volume entirely.
  let u = 6;
  const avgSources = top10.length > 0 ? sourceCountSum / top10.length : 0;
  u += 4 * (3 - avgSources);
  if (inputs.volume) {
    const { lo, hi } = inputs.volume;
    const width = hi > lo ? Math.log10(hi / Math.max(lo, 1)) : 3;
    u += 6 * Math.min(1, Math.max(0, width) / 3);
  } else {
    u += 8; // no volume source at all
  }
  const missingDomains = top10.length - authScores.length;
  if (missingDomains >= 3) u += 3;
  const uncertainty = Math.min(25, Math.round(u));

  const lower = Math.max(0, estimate - uncertainty);
  const upper = Math.min(100, estimate + uncertainty);

  const authoritySources: InputsProvenance["authoritySources"] = (
    Object.keys(BASE_WEIGHTS) as AuthoritySourceId[]
  ).map((source) => ({
    source,
    weight: BASE_WEIGHTS[source],
    domainsCovered: sourceCoverage.get(source) ?? 0,
  }));

  return {
    estimate,
    uncertaintyBand: [lower, upper],
    uncertainty,
    components: {
      linkStrength,
      authorityGap,
      serpCrowding,
      medianDomainAuthority: Math.round(medianAuthority),
      domainsWithAuthority: authScores.length,
    },
    inputsProvenance: {
      serpVendor: inputs.serpVendor,
      authoritySources,
      ccWeightCapped: ccCapped,
      volumeBand: inputs.volume ? inputs.volume.band : null,
      volumeSource: inputs.volume ? inputs.volume.source : null,
      ownAuthorityProvided: inputs.ownDomainAuthority != null,
      featureCount: new Set(inputs.serp.serpFeatures.map((f) => f.toLowerCase())).size,
      aiOverviewPresent: inputs.serp.aiOverviewPresent,
      modelVersion: MODEL_VERSION,
    },
    modelVersion: MODEL_VERSION,
  };
}
