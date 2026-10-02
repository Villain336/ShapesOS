// Marketr — Connector Agent slice 3: IntroPath engine.
// SPEC-CONNECTOR-AGENT.md §6: path computation over the tenant's graph
// (tenant → mutual contact → target), warmth-product scoring, freshness
// decay, and human-readable explanations composed ONLY from stored data.
//
// IntroPaths are COMPUTED, never persisted across tenants (slice-1 schema
// decision). The pure functions below take a per-tenant graph snapshot and
// return ranked paths; the store adapter feeds them tenant-scoped rows.
// A bounded in-memory per-tenant cache (TTL) sits behind the API so the
// scheduled sweep and on-demand recompute don't re-walk the graph.

import {
  exclusionMatches,
  type ConnectorExclusionType,
} from "./types";

// ---------------------------------------------------------------------------
// Engine inputs (per-tenant graph snapshot — plain data, no Prisma).
// ---------------------------------------------------------------------------

export interface PathPersonInput {
  id: string;
  name: string;
  handles: string[];
  relationship: {
    /** 0–100, recomputed by slice-1 warmth math. */
    warmthScore: number;
    lastTouchAt: Date | null;
    notes: string | null;
    boundaries: string | null;
  } | null;
  employments: Array<{
    companyId: string;
    companyName: string;
    title: string | null;
    startYear: number | null;
    endYear: number | null;
    isCurrent: boolean;
  }>;
}

export interface PathCompanyInput {
  id: string;
  name: string;
}

export interface IntroPathRequest {
  persons: PathPersonInput[];
  companies: PathCompanyInput[];
  exclusions: Array<{ type: ConnectorExclusionType; value: string }>;
  /** Exactly one of the two target ids. */
  targetPersonId?: string;
  targetCompanyId?: string;
  /** Cap on returned paths (bounded sweep). Default 10. */
  maxPaths?: number;
  now: Date;
}

export interface IntroPathHop {
  kind: "tenant" | "person" | "company";
  id: string | null;
  name: string;
}

export interface IntroPathExplanation {
  /** Human-readable, e.g. "via Dana — worked together at Acme (2022–24), last touched 3 weeks ago". */
  text: string;
  /** The facts the text was composed from — nothing else may appear in it. */
  facts: {
    mutualName: string;
    sharedCompany: string | null;
    overlapStart: number | null;
    overlapEnd: number | null;
    lastTouchText: string;
    notes: string | null;
  };
}

export interface ComputedIntroPath {
  target: { kind: "person" | "company"; id: string; name: string };
  /** The mutual contact (hop 2): the person the tenant asks for the intro. */
  mutual: { id: string; name: string };
  hops: [IntroPathHop, IntroPathHop, IntroPathHop];
  /** 0–1: (tenant→mutual warmth / 100) × (mutual→target link strength) × freshness. */
  strength: number;
  components: {
    tenantWarmth: number;
    linkStrength: number;
    freshness: number;
  };
  explanation: IntroPathExplanation;
}

export interface IntroPathResult {
  target: { kind: "person" | "company"; id: string; name: string };
  paths: ComputedIntroPath[];
  /** Non-null when the request itself is blocked (not when zero paths exist). */
  blocked: "target_not_found" | "target_excluded" | null;
}

// ---------------------------------------------------------------------------
// Tuning constants (documented; tests pin the behavior).
// ---------------------------------------------------------------------------

/** Default cap on ranked paths per target — the sweep is bounded. */
export const INTRO_DEFAULT_MAX_PATHS = 10;

/** Freshness half-life: a path via a contact last touched 180 days ago
 *  keeps e^-1 ≈ 37% of its score; 365 days → ≈ 13% (floored at 0.1). */
export const INTRO_FRESHNESS_HALF_LIFE_DAYS = 180;

/** Floor so a path never scores exactly zero on freshness alone. */
export const INTRO_FRESHNESS_FLOOR = 0.1;

/** Freshness assigned when the relationship was never touched: weak but nonzero. */
export const INTRO_FRESHNESS_NEVER_TOUCHED = 0.5;

/** Mutual→target link strength when they share a company (before freshness). */
export const INTRO_LINK_BASE = 0.5;
/** Bonus per year of temporal employment overlap (capped). */
export const INTRO_LINK_OVERLAP_PER_YEAR = 0.1;
export const INTRO_LINK_OVERLAP_CAP = 0.3;
/** Bonus when the mutual and target are at the company right now. */
export const INTRO_LINK_CURRENT_TOGETHER_BONUS = 0.2;
/** Mutual→company-target link when the mutual is/was employed there. */
export const INTRO_LINK_EMPLOYED_CURRENT = 0.8;
export const INTRO_LINK_EMPLOYED_PAST = 0.6;

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Freshness decay: older last-touch degrades the path score. Pure —
 * takes `now` explicitly so the sweep and the tests agree.
 */
export function freshnessDecay(lastTouchAt: Date | null, now: Date): number {
  if (!lastTouchAt) return INTRO_FRESHNESS_NEVER_TOUCHED;
  const ageDays = Math.max(0, (now.getTime() - lastTouchAt.getTime()) / DAY_MS);
  const decay = Math.exp(-ageDays / INTRO_FRESHNESS_HALF_LIFE_DAYS);
  return Math.max(INTRO_FRESHNESS_FLOOR, decay);
}

/**
 * Human relative time for explanations — pure, stored-data only.
 */
export function relativeTime(when: Date | null, now: Date): string {
  if (!when) return "never";
  const ageDays = Math.max(0, Math.floor((now.getTime() - when.getTime()) / DAY_MS));
  if (ageDays < 1) return "today";
  if (ageDays === 1) return "yesterday";
  if (ageDays < 7) return `${ageDays} days ago`;
  if (ageDays < 30) {
    const w = Math.floor(ageDays / 7);
    return w === 1 ? "1 week ago" : `${w} weeks ago`;
  }
  if (ageDays < 365) {
    const m = Math.floor(ageDays / 30);
    return m === 1 ? "1 month ago" : `${m} months ago`;
  }
  const y = Math.floor(ageDays / 365);
  return y === 1 ? "1 year ago" : `${y} years ago`;
}

const NEGATION_RE = /\b(don'?t|do not|never|no|not|avoid|stop)\b/i;
const INTRO_WORD_RE = /\bintros?\b|\bintroductions?\b/i;
const FREQUENCY_QUALIFIER_RE = /\b(quarterly|monthly|yearly|annual|per (quarter|month|year)|once a (quarter|month|year))\b/i;

/**
 * Does the tenant's boundary text block routing an intro ask through this
 * relationship? A negated-intro phrase ("don't ask for intros") blocks;
 * a frequency-qualified one ("don't ask for intros more than quarterly")
 * is a rate limit (slice 4's job), not a block — paths still route.
 * Pure — tested directly.
 */
export function boundaryBlocksIntros(boundaries: string | null): boolean {
  if (!boundaries) return false;
  if (!INTRO_WORD_RE.test(boundaries)) return false;
  if (!NEGATION_RE.test(boundaries)) return false;
  if (FREQUENCY_QUALIFIER_RE.test(boundaries)) return false;
  return true;
}

/** Pure: is this person excluded from the graph's path computation? */
export function personIsExcluded(
  exclusions: Array<{ type: ConnectorExclusionType; value: string }>,
  person: { name: string; handles: string[] },
): boolean {
  // Email rules match against the person's handles; name rules against
  // the name; domain rules against handle domains.
  for (const handle of person.handles) {
    if (
      exclusionMatches(exclusions, { email: handle, name: person.name })
    ) {
      return true;
    }
  }
  return (
    exclusionMatches(exclusions, { email: "", name: person.name }) !== null
  );
}

/**
 * Mutual→target link strength from co-employment.
 * - overlapYears: temporal overlap of the two employments (null when the
 *   years are unknown or they were there in different eras).
 * - currentlyTogether: both at the company right now.
 */
export function coEmploymentStrength(input: {
  overlapYears: number | null;
  currentlyTogether: boolean;
}): number {
  let s = INTRO_LINK_BASE;
  if (input.overlapYears != null && input.overlapYears > 0) {
    s += Math.min(INTRO_LINK_OVERLAP_CAP, INTRO_LINK_OVERLAP_PER_YEAR * input.overlapYears);
  }
  if (input.currentlyTogether) s += INTRO_LINK_CURRENT_TOGETHER_BONUS;
  return Math.min(1, s);
}

interface EmploymentWindow {
  startYear: number | null;
  endYear: number | null;
  isCurrent: boolean;
}

/** Temporal overlap of two employment windows (years), or null when the
 *  years are unknown / they did not actually overlap in time. */
export function employmentOverlap(
  a: EmploymentWindow,
  b: EmploymentWindow,
  nowYear: number,
): { start: number; end: number; years: number } | null {
  if (a.startYear == null || b.startYear == null) return null;
  const aEnd = a.endYear ?? (a.isCurrent ? nowYear : a.startYear);
  const bEnd = b.endYear ?? (b.isCurrent ? nowYear : b.startYear);
  const start = Math.max(a.startYear, b.startYear);
  const end = Math.min(aEnd, bEnd);
  if (end < start) return null;
  return { start, end, years: end - start + 1 };
}

/** Short year range for explanations: 2022–24. */
function yearRange(start: number, end: number): string {
  const endShort = String(end).slice(-2);
  return start === end ? String(start) : `${start}–${endShort}`;
}

// ---------------------------------------------------------------------------
// Explanation composer — NEVER invents facts. Every clause is guarded by
// stored data; unknown data means the clause is dropped, not guessed.
// ---------------------------------------------------------------------------

function buildExplanation(args: {
  mutualName: string;
  /** "worked together at Acme (2022–24)" / "works at Acme" / null. */
  linkPhrase: string | null;
  lastTouchAt: Date | null;
  notes: string | null;
  now: Date;
  overlapStart: number | null;
  overlapEnd: number | null;
  sharedCompany: string | null;
}): IntroPathExplanation {
  const lastTouchText = relativeTime(args.lastTouchAt, args.now);
  const link = args.linkPhrase ?? "knows them";
  let text = `via ${args.mutualName} — ${link}, last touched ${lastTouchText}`;
  if (args.notes) text += `. Context: ${args.notes}`;
  return {
    text,
    facts: {
      mutualName: args.mutualName,
      sharedCompany: args.sharedCompany,
      overlapStart: args.overlapStart,
      overlapEnd: args.overlapEnd,
      lastTouchText,
      notes: args.notes,
    },
  };
}

// ---------------------------------------------------------------------------
// The path computation.
// ---------------------------------------------------------------------------

type Link =
  | {
      kind: "coemployment";
      sharedCompanyId: string;
      sharedCompanyName: string;
      overlap: { start: number; end: number; years: number } | null;
      currentlyTogether: boolean;
      strength: number;
      linkPhrase: string;
    }
  | {
      kind: "employment";
      companyId: string;
      companyName: string;
      isCurrent: boolean;
      emp: { title: string | null; startYear: number | null; endYear: number | null };
      strength: number;
      linkPhrase: string;
    };

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function computeIntroPaths(req: IntroPathRequest): IntroPathResult {
  const now = req.now;
  const maxPaths = Math.max(1, Math.min(50, req.maxPaths ?? INTRO_DEFAULT_MAX_PATHS));
  const nowYear = now.getUTCFullYear();

  const personById = new Map(req.persons.map((p) => [p.id, p]));
  const companyById = new Map(req.companies.map((c) => [c.id, c]));

  // --- Resolve the target (tenant-scoped by construction: the caller
  // only passes this tenant's snapshot). ---
  let target: IntroPathResult["target"] | null = null;
  let targetPerson: PathPersonInput | null = null;
  let targetCompany: PathCompanyInput | null = null;
  if (req.targetPersonId) {
    targetPerson = personById.get(req.targetPersonId) ?? null;
    if (!targetPerson) {
      return { target: { kind: "person", id: req.targetPersonId, name: "" }, paths: [], blocked: "target_not_found" };
    }
    if (personIsExcluded(req.exclusions, targetPerson)) {
      return {
        target: { kind: "person", id: targetPerson.id, name: targetPerson.name },
        paths: [],
        blocked: "target_excluded",
      };
    }
    target = { kind: "person", id: targetPerson.id, name: targetPerson.name };
  } else if (req.targetCompanyId) {
    targetCompany = companyById.get(req.targetCompanyId) ?? null;
    if (!targetCompany) {
      return { target: { kind: "company", id: req.targetCompanyId, name: "" }, paths: [], blocked: "target_not_found" };
    }
    target = { kind: "company", id: targetCompany.id, name: targetCompany.name };
  } else {
    throw new Error("computeIntroPaths requires targetPersonId or targetCompanyId.");
  }

  const paths: ComputedIntroPath[] = [];

  for (const mutual of req.persons) {
    // Never path through the target themselves, and never through an
    // excluded person.
    if (targetPerson && mutual.id === targetPerson.id) continue;
    if (personIsExcluded(req.exclusions, mutual)) continue;

    // Hop 1 (tenant → mutual) must exist: without a relationship edge the
    // tenant has no standing to ask for the intro.
    const rel = mutual.relationship;
    if (!rel) continue;

    // Boundary blocks: no paths through "don't ask for intros".
    if (boundaryBlocksIntros(rel.boundaries)) continue;

    // Hop 2 (mutual → target): derived from employment data.
    let link: Link | null = null;
    if (targetPerson) {
      link = bestCoEmploymentLink(mutual, targetPerson, nowYear);
    } else if (targetCompany) {
      link = employmentAtCompanyLink(mutual, targetCompany);
    }
    if (!link) continue;

    const tenantWarmth = Math.max(0, Math.min(100, rel.warmthScore));
    const freshness = freshnessDecay(rel.lastTouchAt, now);
    const strength = round3((tenantWarmth / 100) * link.strength * freshness);
    if (strength <= 0) continue;

    const overlap = link.kind === "coemployment" ? link.overlap : null;
    const explanation = buildExplanation({
      mutualName: mutual.name,
      linkPhrase: link.linkPhrase,
      lastTouchAt: rel.lastTouchAt,
      notes: rel.notes,
      now,
      overlapStart: overlap?.start ?? null,
      overlapEnd: overlap?.end ?? null,
      sharedCompany: link.kind === "coemployment" ? link.sharedCompanyName : link.companyName,
    });

    const targetHop: IntroPathHop =
      link.kind === "coemployment"
        ? { kind: "person", id: targetPerson!.id, name: targetPerson!.name }
        : { kind: "company", id: targetCompany!.id, name: targetCompany!.name };

    paths.push({
      target: target!,
      mutual: { id: mutual.id, name: mutual.name },
      hops: [
        { kind: "tenant", id: null, name: "You" },
        { kind: "person", id: mutual.id, name: mutual.name },
        targetHop,
      ],
      strength,
      components: {
        tenantWarmth,
        linkStrength: round3(link.strength),
        freshness: round3(freshness),
      },
      explanation,
    });
  }

  // Warmth-product ranking; ties break by fresher last touch, then name.
  paths.sort((a, b) => {
    if (b.strength !== a.strength) return b.strength - a.strength;
    if (b.components.freshness !== a.components.freshness) {
      return b.components.freshness - a.components.freshness;
    }
    return a.mutual.name.localeCompare(b.mutual.name);
  });

  return { target: target!, paths: paths.slice(0, maxPaths), blocked: null };
}

/** Best co-employment link between a mutual and a person target. */
function bestCoEmploymentLink(
  mutual: PathPersonInput,
  target: PathPersonInput,
  nowYear: number,
): Extract<Link, { kind: "coemployment" }> | null {
  let best: Extract<Link, { kind: "coemployment" }> | null = null;
  for (const me of mutual.employments) {
    for (const te of target.employments) {
      if (me.companyId !== te.companyId) continue;
      const overlap = employmentOverlap(me, te, nowYear);
      const currentlyTogether = me.isCurrent && te.isCurrent;
      const strength = coEmploymentStrength({
        overlapYears: overlap ? overlap.years : null,
        currentlyTogether,
      });
      const linkPhrase = overlap
        ? `worked together at ${me.companyName} (${yearRange(overlap.start, overlap.end)})`
        : currentlyTogether
          ? `works with them at ${me.companyName}`
          : `both worked at ${me.companyName}`;
      const candidate = {
        kind: "coemployment" as const,
        sharedCompanyId: me.companyId,
        sharedCompanyName: me.companyName,
        overlap,
        currentlyTogether,
        strength,
        linkPhrase,
      };
      if (!best || candidate.strength > best.strength) best = candidate;
    }
  }
  return best;
}

/** Mutual → company-target link via the mutual's own employment there. */
function employmentAtCompanyLink(
  mutual: PathPersonInput,
  company: PathCompanyInput,
): Extract<Link, { kind: "employment" }> | null {
  const emp = mutual.employments.find((e) => e.companyId === company.id);
  if (!emp) return null;
  const strength = emp.isCurrent ? INTRO_LINK_EMPLOYED_CURRENT : INTRO_LINK_EMPLOYED_PAST;
  const years =
    emp.startYear != null
      ? ` (${yearRange(emp.startYear, emp.endYear ?? new Date().getUTCFullYear())})`
      : "";
  const linkPhrase = emp.isCurrent
    ? `works at ${emp.companyName}${years}`
    : `worked at ${emp.companyName}${years}`;
  return {
    kind: "employment" as const,
    companyId: company.id,
    companyName: emp.companyName,
    isCurrent: emp.isCurrent,
    emp: { title: emp.title, startYear: emp.startYear, endYear: emp.endYear },
    strength,
    linkPhrase,
  };
}

// ---------------------------------------------------------------------------
// Bounded per-tenant cache (TTL). IntroPaths are computed, never persisted;
// the cache just keeps the sweep and the API from re-walking the graph.
// In-memory per server process — fine for this slice's contract.
// ---------------------------------------------------------------------------

export const INTRO_PATH_CACHE_TTL_MS = 10 * 60 * 1000;

interface CachedPaths {
  result: IntroPathResult;
  computedAt: Date;
}

const pathCache = new Map<string, CachedPaths>();

export function introCacheKey(
  workspaceId: string,
  kind: "person" | "company",
  targetId: string,
): string {
  return `${workspaceId}:${kind}:${targetId}`;
}

export function getCachedIntroPaths(
  workspaceId: string,
  kind: "person" | "company",
  targetId: string,
  now = new Date(),
): IntroPathResult | null {
  const entry = pathCache.get(introCacheKey(workspaceId, kind, targetId));
  if (!entry) return null;
  if (now.getTime() - entry.computedAt.getTime() > INTRO_PATH_CACHE_TTL_MS) {
    pathCache.delete(introCacheKey(workspaceId, kind, targetId));
    return null;
  }
  return entry.result;
}

export function setCachedIntroPaths(
  workspaceId: string,
  kind: "person" | "company",
  targetId: string,
  result: IntroPathResult,
  computedAt = new Date(),
): void {
  pathCache.set(introCacheKey(workspaceId, kind, targetId), { result, computedAt });
}

/** Drop every cached path for a tenant (graph changed, exclusions changed). */
export function invalidateIntroPathsForTenant(workspaceId: string): void {
  const prefix = `${workspaceId}:`;
  for (const key of pathCache.keys()) {
    if (key.startsWith(prefix)) pathCache.delete(key);
  }
}

/** Test seam: clear the whole cache. */
export function clearIntroPathCache(): void {
  pathCache.clear();
}
