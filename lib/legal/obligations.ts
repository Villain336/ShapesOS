// Marketr — Legal/Compliance slice 1: obligation computation engine.
// Spec: BUSINESS-OS-FEATURE-SPECS.md §4.
//
// The obligation map is computed PER TENANT, never generic: a template applies
// when (a) its industries list is empty or contains the profile's industry,
// and (b) its jurisdictions list contains "national" or intersects the
// profile's jurisdictions. National templates layer under jurisdiction-
// specific ones — NC profiles get national + NC; a profile with no NC gets
// national only.
//
// Tenant overrides (snooze/dismiss/done from the Obligation table) merge on
// top by template key. The engine itself is pure: no DB, no I/O.

import {
  INDUSTRIES,
  JURISDICTIONS,
  NATIONAL_JURISDICTION,
  OBLIGATION_CATEGORIES,
  type ComputedObligation,
  type LegalProfileInput,
  type ObligationStatus,
  type SeedObligationTemplate,
} from "./types";

export interface ObligationOverride {
  templateKey: string;
  status: ObligationStatus;
  snoozedUntil: string | null;
  note: string | null;
}

export function templateAppliesToProfile(
  template: Pick<SeedObligationTemplate, "industries" | "jurisdictions">,
  profile: Pick<LegalProfileInput, "industry" | "jurisdictions">,
): boolean {
  const industryMatch =
    template.industries.length === 0 ||
    template.industries.includes(profile.industry);
  const jurisdictionMatch =
    template.jurisdictions.includes(NATIONAL_JURISDICTION) ||
    template.jurisdictions.some((j) => profile.jurisdictions.includes(j));
  return industryMatch && jurisdictionMatch;
}

const CATEGORY_ORDER = OBLIGATION_CATEGORIES.map((c) => c.value);

/**
 * Compute the tenant's obligation checklist from their profile.
 * Overrides (persisted Obligation rows) merge by template key; unknown keys
 * in overrides are ignored so stale rows can't invent obligations.
 */
export function computeObligations(
  profile: LegalProfileInput,
  templates: SeedObligationTemplate[],
  overrides: ObligationOverride[] = [],
): ComputedObligation[] {
  const overrideByKey = new Map(overrides.map((o) => [o.templateKey, o]));
  const computed: ComputedObligation[] = [];
  for (const template of templates) {
    if (!templateAppliesToProfile(template, profile)) continue;
    const override = overrideByKey.get(template.key);
    computed.push({
      ...template,
      status: override?.status ?? "open",
      snoozedUntil: override?.snoozedUntil ?? null,
      note: override?.note ?? null,
    });
  }
  computed.sort((a, b) => {
    const cat = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
    if (cat !== 0) return cat;
    return a.title.localeCompare(b.title);
  });
  return computed;
}

/**
 * Validate seed data structure. Called at seed time and in tests.
 * New industries/jurisdictions must be registered in types.ts first —
// unregistered values fail here so coverage can't silently misroute.
 */
export function validateSeedTemplates(templates: SeedObligationTemplate[]): void {
  const knownIndustries: Set<string> = new Set(INDUSTRIES.map((i) => i.value));
  const knownJurisdictions: Set<string> = new Set([
    NATIONAL_JURISDICTION,
    ...JURISDICTIONS.map((j) => j.value),
  ]);
  const knownCategories = new Set(OBLIGATION_CATEGORIES.map((c) => c.value));
  const seenKeys = new Set<string>();

  for (const t of templates) {
    if (!t.key || !/^[a-z0-9-]+$/.test(t.key)) {
      throw new Error(`Seed template has an invalid key: ${JSON.stringify(t.key)}`);
    }
    if (seenKeys.has(t.key)) {
      throw new Error(`Duplicate seed template key: ${t.key}`);
    }
    seenKeys.add(t.key);
    if (!t.title.trim() || !t.description.trim()) {
      throw new Error(`Seed template ${t.key} needs a title and description.`);
    }
    if (!t.sourceRef.trim()) {
      throw new Error(
        `Seed template ${t.key} is missing a source reference (guardrail: no invented specifics).`,
      );
    }
    if (!knownCategories.has(t.category)) {
      throw new Error(`Seed template ${t.key} has unknown category ${t.category}.`);
    }
    if (t.jurisdictions.length === 0) {
      throw new Error(
        `Seed template ${t.key} has no jurisdictions — use "${NATIONAL_JURISDICTION}" for everywhere.`,
      );
    }
    for (const j of t.jurisdictions) {
      if (!knownJurisdictions.has(j)) {
        throw new Error(
          `Seed template ${t.key} references unregistered jurisdiction ${j}.`,
        );
      }
    }
    for (const i of t.industries) {
      if (!knownIndustries.has(i)) {
        throw new Error(
          `Seed template ${t.key} references unregistered industry ${i}.`,
        );
      }
    }
  }
}
