// Marketr — Legal/Compliance slice 4: change-radar computation engine.
// Spec: BUSINESS-OS-FEATURE-SPECS.md §4.
//
// A change is relevant to a tenant when (a) its industries list is empty or
// contains the profile's industry, and (b) its jurisdictions list contains
// "national" or intersects the profile's jurisdictions — the same matching
// rule as the slice-1 obligation engine.
//
// Tenant triage state (reviewed / dismissed) merges on top by change key;
// unknown keys in triage rows are ignored so stale rows can't invent items.
// The engine itself is pure: no DB, no I/O.

import {
  INDUSTRIES,
  JURISDICTIONS,
  NATIONAL_JURISDICTION,
  OBLIGATION_CATEGORIES,
} from "./types";
import {
  RADAR_OBLIGATION_KEY_PREFIX,
  RADAR_TO_OBLIGATION_CATEGORY,
  REGULATION_CHANGE_CATEGORIES,
  type RadarRelevance,
  type RadarTriageStatus,
  type SeedRegulationChange,
  type TriagedChange,
} from "./radar-types";

export interface ChangeTriageRow {
  changeKey: string;
  status: RadarTriageStatus;
}

export type ChangeProfile = Pick<
  import("./types").LegalProfileInput,
  "industry" | "jurisdictions"
>;

export function changeAppliesToProfile(
  change: Pick<SeedRegulationChange, "industries" | "jurisdictions">,
  profile: ChangeProfile,
): boolean {
  const industryMatch =
    change.industries.length === 0 || change.industries.includes(profile.industry);
  const jurisdictionMatch =
    change.jurisdictions.includes(NATIONAL_JURISDICTION) ||
    change.jurisdictions.some((j) => profile.jurisdictions.includes(j));
  return industryMatch && jurisdictionMatch;
}

/**
 * Triage the tenant's radar: every change with a relevance verdict and the
 * tenant's triage state merged by key. Relevant-and-new items sort first,
 * then relevant-but-triaged, then not-relevant; newest published first
 * within each band.
 */
export function triageChanges(
  changes: SeedRegulationChange[],
  profile: ChangeProfile,
  triageRows: ChangeTriageRow[] = [],
): TriagedChange[] {
  const triageByKey = new Map(triageRows.map((r) => [r.changeKey, r.status]));
  const items: TriagedChange[] = changes.map((change) => ({
    ...change,
    relevance: changeAppliesToProfile(change, profile) ? "relevant" : "not_relevant",
    triage: triageByKey.get(change.key) ?? "new",
  }));
  items.sort((a, b) => {
    const rank = (i: TriagedChange) =>
      i.relevance === "relevant" && i.triage === "new"
        ? 0
        : i.relevance === "relevant"
          ? 1
          : 2;
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return b.publishedAt.localeCompare(a.publishedAt);
  });
  return items;
}

/**
 * Convert a radar change into a slice-1 obligation template. The key is
 * prefixed so radar-created obligations never collide with seed templates;
 * needsReview is always true (the change was never a verified obligation).
 * Guardrail: the description is the change's plain-English summary —
 * informational only, never advice — plus the verify-before-acting label.
 */
export function changeToObligationSeed(
  change: SeedRegulationChange,
): import("./types").SeedObligationTemplate {
  return {
    key: `${RADAR_OBLIGATION_KEY_PREFIX}${change.key}`,
    industries: [...change.industries],
    jurisdictions: [...change.jurisdictions],
    category: RADAR_TO_OBLIGATION_CATEGORY[change.category],
    title: change.title,
    description:
      `${change.plainEnglishSummary} Added to your obligations from the ` +
      `change radar (verify before acting).`,
    sourceRef: change.sourceRef,
    renewalCadence: null,
    needsReview: true,
  };
}

/**
 * Validate seed change data structure. Called at seed time and in tests.
 * New industries/jurisdictions must be registered in types.ts first —
 * unregistered values fail here so coverage can't silently misroute.
 * An effectiveDate is only set when the date itself was verified: the engine
 * never renders a guessed effective date as fact.
 */
export function validateSeedChanges(changes: SeedRegulationChange[]): void {
  const knownIndustries: Set<string> = new Set(INDUSTRIES.map((i) => i.value));
  const knownJurisdictions: Set<string> = new Set([
    NATIONAL_JURISDICTION,
    ...JURISDICTIONS.map((j) => j.value),
  ]);
  const knownCategories = new Set(REGULATION_CHANGE_CATEGORIES.map((c) => c.value));
  const knownObligationCategories = new Set(OBLIGATION_CATEGORIES.map((c) => c.value));
  const seenKeys = new Set<string>();

  for (const c of changes) {
    if (!c.key || !/^[a-z0-9-]+$/.test(c.key)) {
      throw new Error(`Seed change has an invalid key: ${JSON.stringify(c.key)}`);
    }
    if (seenKeys.has(c.key)) {
      throw new Error(`Duplicate seed change key: ${c.key}`);
    }
    seenKeys.add(c.key);
    if (!c.title.trim() || !c.plainEnglishSummary.trim()) {
      throw new Error(`Seed change ${c.key} needs a title and a plain-English summary.`);
    }
    if (!c.sourceRef.trim()) {
      throw new Error(
        `Seed change ${c.key} is missing a source reference (guardrail: no invented specifics).`,
      );
    }
    if (!knownCategories.has(c.category)) {
      throw new Error(`Seed change ${c.key} has unknown category ${c.category}.`);
    }
    if (!knownObligationCategories.has(RADAR_TO_OBLIGATION_CATEGORY[c.category])) {
      throw new Error(
        `Seed change ${c.key} maps to an unknown obligation category.`,
      );
    }
    if (c.jurisdictions.length === 0) {
      throw new Error(
        `Seed change ${c.key} has no jurisdictions — use "${NATIONAL_JURISDICTION}" for everywhere.`,
      );
    }
    for (const j of c.jurisdictions) {
      if (!knownJurisdictions.has(j)) {
        throw new Error(
          `Seed change ${c.key} references unregistered jurisdiction ${j}.`,
        );
      }
    }
    for (const i of c.industries) {
      if (!knownIndustries.has(i)) {
        throw new Error(
          `Seed change ${c.key} references unregistered industry ${i}.`,
        );
      }
    }
    if (Number.isNaN(Date.parse(c.publishedAt))) {
      throw new Error(`Seed change ${c.key} has an unparseable publishedAt.`);
    }
    if (c.effectiveDate != null) {
      if (Number.isNaN(Date.parse(c.effectiveDate))) {
        throw new Error(`Seed change ${c.key} has an unparseable effectiveDate.`);
      }
      // A non-null effectiveDate is a claimed-verified date — seeds must
      // only set it when the date was actually verified (the test asserts
      // all v1 seeds keep it null).
    }
    if (!c.seedFlag) {
      throw new Error(
        `Seed change ${c.key} must carry seedFlag: true (illustrative seed data).`,
      );
    }
  }
}
