// Marketr — Legal/Compliance slice 4: seed regulation-change feed.
// Spec: BUSINESS-OS-FEATURE-SPECS.md §4. v1 = structured seed feed + triage
// logic — NO live scraping.
//
// Coverage expands by DATA addition: a new industry, jurisdiction, or topic
// is a new entry in this array (industries[] / jurisdictions[] filters),
// never a code change. The engine in radar.ts triages entries per tenant.
//
// Guardrail: nothing here invents bill numbers, statute citations, form
// numbers, or effective dates. These are ILLUSTRATIVE example entries to show
// how the radar works — every seed carries seedFlag: true and the UI must
// badge the feed as illustrative seed data, never as live tracking.
// Anything unverified renders as "verify before acting", never as fact.

import type { SeedRegulationChange } from "./radar-types";

/** ISO date the illustrative seed items were authored. */
export const SEED_PUBLISHED_AT = "2026-10-01T00:00:00.000Z";

const VERIFY = "(verify before acting)";

export const REGULATION_CHANGE_SEEDS: SeedRegulationChange[] = [
  // ---- National baseline: applies to every industry and jurisdiction ----
  {
    key: "seed-beneficial-ownership-reminder",
    title: "Beneficial ownership reporting rules remain in flux",
    plainEnglishSummary:
      "Federal rules about reporting who owns a business have changed back " +
      "and forth. Whether your business has to file depends on your structure " +
      "and size, and the rules may have shifted since you last checked. This " +
      "is general information only — confirm your current filing duty before " +
      "you rely on it.",
    industries: [],
    jurisdictions: ["national"],
    category: "other",
    effectiveDate: null,
    sourceRef: `Federal reporting rules — check current guidance ${VERIFY}`,
    publishedAt: SEED_PUBLISHED_AT,
    seedFlag: true,
  },
  {
    key: "seed-state-privacy-laws-expanding",
    title: "More states are adopting consumer privacy laws",
    plainEnglishSummary:
      "A growing number of states have consumer privacy laws that can apply " +
      "based on where your customers live, not where your business sits. If " +
      "you collect personal information online — even a simple mailing list — " +
      "review whether any state law reaches you and what it asks of you. " +
      "This is general information only — confirm with the cited source.",
    industries: [],
    jurisdictions: ["national"],
    category: "privacy",
    effectiveDate: null,
    sourceRef: `State consumer privacy statutes ${VERIFY}`,
    publishedAt: SEED_PUBLISHED_AT,
    seedFlag: true,
  },
  {
    key: "seed-overtime-threshold-watch",
    title: "Overtime salary threshold rules face ongoing legal challenges",
    plainEnglishSummary:
      "Federal overtime salary thresholds have been proposed, raised, and " +
      "blocked in court in recent years. If you have salaried employees, the " +
      "threshold that applies to you may change. Keep an eye on final agency " +
      "action rather than proposals. This is general information only.",
    industries: [],
    jurisdictions: ["national"],
    category: "employment",
    effectiveDate: null,
    sourceRef: `Federal wage-and-hour rules ${VERIFY}`,
    publishedAt: SEED_PUBLISHED_AT,
    seedFlag: true,
  },

  // ---- North Carolina layer ----
  {
    key: "seed-nc-sales-tax-digital",
    title: "NC continues to clarify sales tax on digital products",
    plainEnglishSummary:
      "North Carolina periodically updates how sales tax applies to digital " +
      "goods and services. If you sell downloads, subscriptions, or software " +
      "in NC, recheck whether your offerings are taxable and whether you " +
      "need to collect. This is general information only — confirm with the " +
      "cited source before you change how you collect tax.",
    industries: [],
    jurisdictions: ["NC"],
    category: "tax",
    effectiveDate: null,
    sourceRef: `NC Department of Revenue — ncdor.gov ${VERIFY}`,
    publishedAt: SEED_PUBLISHED_AT,
    seedFlag: true,
  },

  // ---- SaaS ----
  {
    key: "seed-saas-renewal-disclosure",
    title: "Subscription renewal disclosure expectations are tightening",
    plainEnglishSummary:
      "Regulators are paying more attention to how subscriptions renew and " +
      "cancel — clear disclosure of the price, the billing interval, and an " +
      "easy way to cancel are the direction of travel. If you sell recurring " +
      "plans, review your checkout and cancellation flow against current " +
      "guidance. This is general information only — have an attorney review " +
      "your terms before you rely on them.",
    industries: ["saas"],
    jurisdictions: ["national"],
    category: "privacy",
    effectiveDate: null,
    sourceRef: `Consumer-protection guidance on subscriptions ${VERIFY}`,
    publishedAt: SEED_PUBLISHED_AT,
    seedFlag: true,
  },

  // ---- Drones ----
  {
    key: "seed-drone-remote-id",
    title: "Drone remote identification expectations keep evolving",
    plainEnglishSummary:
      "Most drones flown in US airspace are expected to broadcast remote " +
      "identification information, either built into the aircraft or through " +
      "a broadcast module. Rules in this area have been phased in over time — " +
      "if you fly commercially, confirm your aircraft complies before your " +
      "next flight. This is general information only — " +
      "confirm the current rule before you rely on it.",
    industries: ["drones"],
    jurisdictions: ["national"],
    category: "safety",
    effectiveDate: null,
    sourceRef: `FAA — faa.gov ${VERIFY}`,
    publishedAt: SEED_PUBLISHED_AT,
    seedFlag: true,
  },

  // ---- Food ----
  {
    key: "seed-food-labeling-updates",
    title: "Nutrition labeling requirements keep being updated",
    plainEnglishSummary:
      "Federal nutrition labeling rules for packaged food have been updated " +
      "over time — label format, serving sizes, and which nutrients appear. " +
      "If you package food for retail, check that your labels match the " +
      "current requirements rather than an old print run. This is general " +
      "information only.",
    industries: ["food"],
    jurisdictions: ["national"],
    category: "safety",
    effectiveDate: null,
    sourceRef: `FDA — fda.gov ${VERIFY}`,
    publishedAt: SEED_PUBLISHED_AT,
    seedFlag: true,
  },

  // ---- Services ----
  {
    key: "seed-services-worker-classification",
    title: "Worker classification guidance keeps shifting",
    plainEnglishSummary:
      "The line between employee and independent contractor is drawn by " +
      "federal and state tests that have changed over time. If your service " +
      "business uses contractors, recheck the current tests where you " +
      "operate — misclassification carries back-pay and penalty risk. This " +
      "is general information only — talk to an employment attorney for your " +
      "situation.",
    industries: ["services"],
    jurisdictions: ["national"],
    category: "employment",
    effectiveDate: null,
    sourceRef: `Federal and state worker-classification rules ${VERIFY}`,
    publishedAt: SEED_PUBLISHED_AT,
    seedFlag: true,
  },
];
