// Marketr — Phase 9 M4: Growth Mission templates (SPEC-PHASE9.md §P9C).
//
// Code data, not DB rows. One template per common goal for each of the 5
// LOCKED business types (§8 decision): home-services, local-services, saas,
// ecommerce, professional-services.
//
// Each template = goal definitions + default plan skeleton (ordered steps
// mapped to the 5 Phase 9 executors + human checkpoints) + success metrics +
// typical checkpoints + suggested playbook refs + budget defaults (feed the
// termination conditions in engine.ts).

export type BusinessType =
  | "home-services"
  | "local-services"
  | "saas"
  | "ecommerce"
  | "professional-services";

export const BUSINESS_TYPES: BusinessType[] = [
  "home-services",
  "local-services",
  "saas",
  "ecommerce",
  "professional-services",
];

export const BUSINESS_TYPE_LABELS: Record<BusinessType, string> = {
  "home-services": "Home services",
  "local-services": "Local services",
  saas: "SaaS",
  ecommerce: "Ecommerce",
  "professional-services": "Professional services",
};

export type GoalDirection = "increase" | "decrease";

/** A common goal for a business type: target metric + target value + timeframe. */
export interface MissionGoalDef {
  metric: string;
  label: string;
  targetValue: number;
  unit: string;
  timeframeDays: number;
  direction: GoalDirection;
  baselineHint?: string;
}

export type PlanStepKind = "research" | "plan" | "draft" | "approval" | "execute" | "analyze" | "schedule" | "automation";

/** The 5 Phase 9 executors (spec §P9A) + human for approval steps. */
export type ExecutorName = "researcher" | "planner" | "drafter" | "analyst" | "scheduler" | "human";

export interface PlanStepDef {
  order: number;
  key: string;
  title: string;
  kind: PlanStepKind;
  executor: ExecutorName;
  description: string;
  /** DoA tier of the step's side effects (spec §P9E). 0 = reads/drafts only. */
  tier: 0 | 1 | 2;
  checkpointAfter: boolean;
  playbookRef?: string;
}

export interface MissionTemplate {
  id: string;
  businessType: BusinessType;
  name: string;
  description: string;
  /** 2–3 common goals per template (spec §P9C). First = default. */
  goals: MissionGoalDef[];
  /** Ordered default plan skeleton. */
  plan: PlanStepDef[];
  successMetrics: string[];
  typicalCheckpoints: string[];
  playbookRefs: string[];
  budgetDefaults: {
    maxCostCents: number;
    maxSteps: number;
    maxConsecutiveFailures: number;
  };
}

// ---------------------------------------------------------------------------
// Home services (plumbing/HVAC)
// ---------------------------------------------------------------------------

const HOME_SERVICES_COMMON = {
  budgetDefaults: { maxCostCents: 60_000, maxSteps: 48, maxConsecutiveFailures: 3 },
};

const homeServicesBookedJobGrowth: MissionTemplate = {
  id: "home-services.booked-job-growth",
  businessType: "home-services",
  name: "Booked-job growth",
  description:
    "Grow booked jobs this quarter: local-visibility audit, review-driven trust, and a seasonal offer campaign — every external send gated by approval.",
  goals: [
    { metric: "booked_jobs", label: "Booked jobs", targetValue: 40, unit: "jobs", timeframeDays: 90, direction: "increase", baselineHint: "last quarter's booked-job count" },
    { metric: "quote_requests", label: "Quote requests", targetValue: 120, unit: "requests", timeframeDays: 90, direction: "increase" },
    { metric: "booked_revenue", label: "Booked revenue", targetValue: 85000, unit: "USD", timeframeDays: 90, direction: "increase" },
  ],
  plan: [
    { order: 1, key: "audit-local-presence", title: "Audit local presence", kind: "research", executor: "researcher", description: "Read the Business Graph: GBP health, review footprint, local-pack position, competitor offers.", tier: 0, checkpointAfter: true },
    { order: 2, key: "quarter-plan", title: "Draft 90-day plan", kind: "plan", executor: "planner", description: "Sequence offer windows, GBP post cadence, and review-request drives into a dated plan.", tier: 0, checkpointAfter: true, playbookRef: "local-services.offer-campaign.v3" },
    { order: 3, key: "draft-offer", title: "Draft seasonal offer", kind: "draft", executor: "drafter", description: "Write the offer creative and landing copy in DRAFT mode — nothing publishes without approval.", tier: 0, checkpointAfter: false },
    { order: 4, key: "approve-offer", title: "Approve offer launch", kind: "approval", executor: "human", description: "Human approves the offer payload (Tier 2: external audience).", tier: 2, checkpointAfter: true },
    { order: 5, key: "publish-offer", title: "Publish offer to owned channels", kind: "execute", executor: "scheduler", description: "Approved payload only; the approval executor re-verifies binding + tier at execution time.", tier: 1, checkpointAfter: true },
    { order: 6, key: "review-drive", title: "Run review-velocity drive", kind: "execute", executor: "drafter", description: "Draft review-request messages; sends stay in draft until the approval gate clears.", tier: 0, checkpointAfter: true, playbookRef: "reviews.velocity-engine.v2" },
    { order: 7, key: "weekly-attribution", title: "Weekly attribution review", kind: "analyze", executor: "analyst", description: "Attribute booked jobs to offer vs. organic; write learnings to Growth Memory.", tier: 0, checkpointAfter: true },
    { order: 8, key: "schedule-cadence", title: "Schedule ongoing cadence", kind: "schedule", executor: "scheduler", description: "Reminder + checkpoint schedule for the remainder of the quarter.", tier: 0, checkpointAfter: false },
  ],
  successMetrics: ["booked jobs", "cost per booked job", "review count velocity", "average rating"],
  typicalCheckpoints: [
    "Week 2: offer live on owned channels + GBP posts scheduled",
    "Week 6: mid-quarter attribution review — is the offer pulling?",
    "Week 12: goal reckoning vs. booked-job target",
  ],
  playbookRefs: ["local-services.offer-campaign.v3", "reviews.velocity-engine.v2"],
  budgetDefaults: HOME_SERVICES_COMMON.budgetDefaults,
};

const homeServicesReviewVelocity: MissionTemplate = {
  id: "home-services.review-velocity",
  businessType: "home-services",
  name: "Review velocity",
  description:
    "Compound trust: raise review volume and response rate so every other channel converts better. Drafts first, approvals before any external send.",
  goals: [
    { metric: "new_reviews", label: "New reviews", targetValue: 12, unit: "reviews", timeframeDays: 30, direction: "increase", baselineHint: "reviews in the last 30 days" },
    { metric: "avg_rating", label: "Average rating", targetValue: 4.8, unit: "stars", timeframeDays: 60, direction: "increase" },
    { metric: "review_response_rate", label: "Review response rate", targetValue: 100, unit: "%", timeframeDays: 30, direction: "increase" },
  ],
  plan: [
    { order: 1, key: "audit-reviews", title: "Audit review footprint", kind: "research", executor: "researcher", description: "Pull current volume, velocity, rating distribution, and unanswered reviews from the graph.", tier: 0, checkpointAfter: true },
    { order: 2, key: "draft-request-sequence", title: "Draft review-request sequence", kind: "draft", executor: "drafter", description: "Post-job SMS/email request copy + timing ladder. Draft mode only.", tier: 0, checkpointAfter: false },
    { order: 3, key: "approve-request-sequence", title: "Approve request sequence", kind: "approval", executor: "human", description: "Human approves the outreach payload (Tier 2: external audience).", tier: 2, checkpointAfter: true },
    { order: 4, key: "draft-responses", title: "Draft responses to open reviews", kind: "draft", executor: "drafter", description: "On-brand replies to every unanswered review, held as drafts.", tier: 0, checkpointAfter: false },
    { order: 5, key: "approve-responses", title: "Approve review replies", kind: "approval", executor: "human", description: "Human approves reply payloads before anything posts (Tier 2).", tier: 2, checkpointAfter: true },
    { order: 6, key: "schedule-requests", title: "Schedule request cadence", kind: "schedule", executor: "scheduler", description: "Ongoing post-job request reminders + weekly velocity checkpoint.", tier: 0, checkpointAfter: true },
    { order: 7, key: "velocity-attribution", title: "Attribution review", kind: "analyze", executor: "analyst", description: "Which request channel drives reviews? Write the learning to Growth Memory.", tier: 0, checkpointAfter: true, playbookRef: "reviews.velocity-engine.v2" },
  ],
  successMetrics: ["new reviews per 30 days", "average rating", "response rate", "rating distribution shift"],
  typicalCheckpoints: [
    "Day 3: request sequence approved and scheduled",
    "Day 14: velocity check — on pace for the target?",
    "Day 30: goal reckoning + attribution write-up",
  ],
  playbookRefs: ["reviews.velocity-engine.v2"],
  budgetDefaults: { maxCostCents: 25_000, maxSteps: 32, maxConsecutiveFailures: 3 },
};

const homeServicesSlowSeasonFill: MissionTemplate = {
  id: "home-services.slow-season-fill",
  businessType: "home-services",
  name: "Slow-season fill",
  description:
    "Fill the off-season book with maintenance-plan pushes and preventive-service offers — revenue smoothing without discounting the core.",
  goals: [
    { metric: "booked_jobs", label: "Booked jobs", targetValue: 25, unit: "jobs", timeframeDays: 60, direction: "increase", baselineHint: "same period last year" },
    { metric: "maintenance_plan_signups", label: "Maintenance plan signups", targetValue: 15, unit: "signups", timeframeDays: 60, direction: "increase" },
  ],
  plan: [
    { order: 1, key: "seasonality-analysis", title: "Analyze seasonality", kind: "research", executor: "researcher", description: "Identify the soft weeks from historical booking data and competitor quiet periods.", tier: 0, checkpointAfter: true },
    { order: 2, key: "offer-calendar", title: "Draft off-season offer calendar", kind: "plan", executor: "planner", description: "Maintenance-plan push + preventive-service offers mapped to the soft weeks.", tier: 0, checkpointAfter: true, playbookRef: "local-services.offer-campaign.v3" },
    { order: 3, key: "draft-promo", title: "Draft promo creative", kind: "draft", executor: "drafter", description: "Offer creative in draft mode; no publish without approval.", tier: 0, checkpointAfter: false },
    { order: 4, key: "approve-promo", title: "Approve promo launch", kind: "approval", executor: "human", description: "Human approves the promo payload (Tier 2: external audience).", tier: 2, checkpointAfter: true },
    { order: 5, key: "run-promo", title: "Run promo on owned channels", kind: "execute", executor: "scheduler", description: "Approved payload executes via the approval executor (binding + tier re-verified).", tier: 1, checkpointAfter: true },
    { order: 6, key: "fill-attribution", title: "Fill-rate attribution", kind: "analyze", executor: "analyst", description: "Which offers filled which weeks? Record to Growth Memory for next season.", tier: 0, checkpointAfter: true },
  ],
  successMetrics: ["booked jobs in target window", "maintenance plan signups", "average ticket in window"],
  typicalCheckpoints: [
    "Week 1: offer calendar approved",
    "Week 4: fill-rate check — adjust offers if behind",
    "Week 8: season reckoning + playbook update",
  ],
  playbookRefs: ["local-services.offer-campaign.v3"],
  budgetDefaults: { maxCostCents: 35_000, maxSteps: 36, maxConsecutiveFailures: 3 },
};

// ---------------------------------------------------------------------------
// Local services
// ---------------------------------------------------------------------------

const localServicesQuoteVolume: MissionTemplate = {
  id: "local-services.quote-request-volume",
  businessType: "local-services",
  name: "Quote-request volume",
  description:
    "More quote requests at a defensible cost: conversion-focused service pages, GBP actions, and follow-up sequences — approvals before external sends.",
  goals: [
    { metric: "quote_requests", label: "Quote requests", targetValue: 150, unit: "requests", timeframeDays: 90, direction: "increase" },
    { metric: "cost_per_quote", label: "Cost per quote", targetValue: 45, unit: "USD", timeframeDays: 90, direction: "decrease" },
    { metric: "form_conversion_rate", label: "Form conversion rate", targetValue: 8, unit: "%", timeframeDays: 90, direction: "increase" },
  ],
  plan: [
    { order: 1, key: "funnel-audit", title: "Audit quote funnel", kind: "research", executor: "researcher", description: "Map traffic → quote-request conversion by channel; find the leaks.", tier: 0, checkpointAfter: true },
    { order: 2, key: "funnel-plan", title: "Draft funnel improvement plan", kind: "plan", executor: "planner", description: "Prioritized fixes: pages, GBP actions, follow-up sequence.", tier: 0, checkpointAfter: true },
    { order: 3, key: "draft-fixes", title: "Draft page + follow-up copy", kind: "draft", executor: "drafter", description: "Service-page fixes and quote follow-up sequences in draft mode.", tier: 0, checkpointAfter: false },
    { order: 4, key: "approve-fixes", title: "Approve funnel changes", kind: "approval", executor: "human", description: "Human approves page changes and follow-up payloads (Tier 2 where external).", tier: 2, checkpointAfter: true },
    { order: 5, key: "apply-fixes", title: "Apply approved changes", kind: "execute", executor: "scheduler", description: "Approved payloads execute via the approval executor only.", tier: 1, checkpointAfter: true },
    { order: 6, key: "funnel-attribution", title: "Funnel attribution review", kind: "analyze", executor: "analyst", description: "Which fixes moved the quote rate? Write learnings to Growth Memory.", tier: 0, checkpointAfter: true },
  ],
  successMetrics: ["quote requests", "cost per quote", "form conversion rate", "quote → job close rate"],
  typicalCheckpoints: [
    "Week 2: funnel plan approved, fixes drafted",
    "Week 6: mid-quarter conversion check",
    "Week 12: goal reckoning",
  ],
  playbookRefs: ["local-services.funnel-fix.v2", "local-services.offer-campaign.v3"],
  budgetDefaults: { maxCostCents: 50_000, maxSteps: 40, maxConsecutiveFailures: 3 },
};

const localServicesGbpVisibility: MissionTemplate = {
  id: "local-services.gbp-visibility",
  businessType: "local-services",
  name: "Google Business visibility",
  description:
    "Own the local pack: GBP completeness, post cadence, photo freshness, and category coverage — all owned-channel work, approval-gated where external.",
  goals: [
    { metric: "gbp_views", label: "GBP views", targetValue: 4000, unit: "views", timeframeDays: 90, direction: "increase" },
    { metric: "gbp_actions", label: "GBP actions", targetValue: 300, unit: "actions", timeframeDays: 90, direction: "increase" },
    { metric: "local_pack_rank", label: "Local pack rank", targetValue: 3, unit: "rank", timeframeDays: 90, direction: "decrease", baselineHint: "current average local-pack position" },
  ],
  plan: [
    { order: 1, key: "gbp-audit", title: "Audit GBP profile", kind: "research", executor: "researcher", description: "Completeness score, category coverage, photo freshness, competitor benchmarks.", tier: 0, checkpointAfter: true },
    { order: 2, key: "gbp-plan", title: "Draft visibility plan", kind: "plan", executor: "planner", description: "Post cadence, photo refresh plan, Q&A seeding, category fixes.", tier: 0, checkpointAfter: true, playbookRef: "listings.gbp-visibility.v2" },
    { order: 3, key: "draft-posts", title: "Draft GBP post batch", kind: "draft", executor: "drafter", description: "A month of GBP posts in draft mode.", tier: 0, checkpointAfter: false },
    { order: 4, key: "approve-posts", title: "Approve post batch", kind: "approval", executor: "human", description: "Human approves the owned-channel batch (Tier 1 with toggle, else Tier 2 ask).", tier: 1, checkpointAfter: true },
    { order: 5, key: "schedule-posts", title: "Schedule GBP cadence", kind: "schedule", executor: "scheduler", description: "Approved posts scheduled; ongoing cadence reminders set.", tier: 0, checkpointAfter: true },
    { order: 6, key: "visibility-attribution", title: "Visibility attribution", kind: "analyze", executor: "analyst", description: "Views/actions lift vs. baseline; record to Growth Memory.", tier: 0, checkpointAfter: true },
  ],
  successMetrics: ["GBP views", "GBP actions (calls, directions, site)", "local-pack rank", "photo views"],
  typicalCheckpoints: [
    "Week 1: profile fixes + first post batch approved",
    "Week 6: visibility lift check",
    "Week 12: goal reckoning",
  ],
  playbookRefs: ["listings.gbp-visibility.v2"],
  budgetDefaults: { maxCostCents: 20_000, maxSteps: 32, maxConsecutiveFailures: 3 },
};

// ---------------------------------------------------------------------------
// SaaS
// ---------------------------------------------------------------------------

const saasTrialStarts: MissionTemplate = {
  id: "saas.trial-starts",
  businessType: "saas",
  name: "Trial starts",
  description:
    "Grow top-of-funnel trial starts: landing-page conversion work, content capture, and launch announcements — every publish approval-gated.",
  goals: [
    { metric: "trial_starts", label: "Trial starts", targetValue: 500, unit: "trials", timeframeDays: 90, direction: "increase" },
    { metric: "signup_conversion_rate", label: "Signup conversion rate", targetValue: 6, unit: "%", timeframeDays: 90, direction: "increase" },
  ],
  plan: [
    { order: 1, key: "acquisition-audit", title: "Audit acquisition funnel", kind: "research", executor: "researcher", description: "Traffic sources → trial-start conversion; find the highest-leverage leaks.", tier: 0, checkpointAfter: true },
    { order: 2, key: "acquisition-plan", title: "Draft acquisition plan", kind: "plan", executor: "planner", description: "Prioritized experiments: landing tests, content capture, launch announcements.", tier: 0, checkpointAfter: true },
    { order: 3, key: "draft-landing", title: "Draft landing + launch copy", kind: "draft", executor: "drafter", description: "Landing variants and launch announcements in draft mode.", tier: 0, checkpointAfter: false },
    { order: 4, key: "approve-launch", title: "Approve launch assets", kind: "approval", executor: "human", description: "Human approves external-facing copy (Tier 2).", tier: 2, checkpointAfter: true },
    { order: 5, key: "run-experiments", title: "Run acquisition experiments", kind: "execute", executor: "scheduler", description: "Approved variants go live via the approval executor (Test Lab pattern where applicable).", tier: 1, checkpointAfter: true },
    { order: 6, key: "experiment-attribution", title: "Experiment attribution", kind: "analyze", executor: "analyst", description: "Which variants moved trial starts? Learnings to Growth Memory.", tier: 0, checkpointAfter: true },
  ],
  successMetrics: ["trial starts", "signup conversion rate", "cost per trial", "trial quality (activation rate)"],
  typicalCheckpoints: [
    "Week 2: first experiment batch live",
    "Week 6: mid-quarter read — double down or pivot",
    "Week 12: goal reckoning",
  ],
  playbookRefs: ["saas.acquisition-experiments.v1"],
  budgetDefaults: { maxCostCents: 75_000, maxSteps: 48, maxConsecutiveFailures: 3 },
};

const saasTrialToPaid: MissionTemplate = {
  id: "saas.trial-to-paid",
  businessType: "saas",
  name: "Trial → paid conversion",
  description:
    "Turn trials into revenue: activation onboarding, usage-triggered nudges, and pricing-page clarity — draft modes before any user-facing send.",
  goals: [
    { metric: "trial_to_paid_rate", label: "Trial → paid rate", targetValue: 22, unit: "%", timeframeDays: 90, direction: "increase" },
    { metric: "trial_activations", label: "Trial activations", targetValue: 350, unit: "activations", timeframeDays: 90, direction: "increase" },
  ],
  plan: [
    { order: 1, key: "activation-audit", title: "Audit trial activation", kind: "research", executor: "researcher", description: "Where do trials stall? Activation events, time-to-value, drop-off points.", tier: 0, checkpointAfter: true },
    { order: 2, key: "activation-plan", title: "Draft activation plan", kind: "plan", executor: "planner", description: "Onboarding fixes, nudge triggers, pricing-page clarity work.", tier: 0, checkpointAfter: true, playbookRef: "saas.activation-ladder.v2" },
    { order: 3, key: "draft-nudges", title: "Draft nudge sequences", kind: "draft", executor: "drafter", description: "Usage-triggered nudge copy in draft mode.", tier: 0, checkpointAfter: false },
    { order: 4, key: "approve-nudges", title: "Approve nudge sequences", kind: "approval", executor: "human", description: "Human approves user-facing sends (Tier 2).", tier: 2, checkpointAfter: true },
    { order: 5, key: "run-nudges", title: "Run approved nudges", kind: "execute", executor: "scheduler", description: "Approved sequences execute via the approval executor only.", tier: 1, checkpointAfter: true },
    { order: 6, key: "conversion-attribution", title: "Conversion attribution", kind: "analyze", executor: "analyst", description: "Which nudges converted trials? Learnings to Growth Memory.", tier: 0, checkpointAfter: true },
  ],
  successMetrics: ["trial → paid rate", "activation rate", "time-to-value", "trial length to conversion"],
  typicalCheckpoints: [
    "Week 2: nudge sequences approved and live",
    "Week 6: conversion-rate check",
    "Week 12: goal reckoning",
  ],
  playbookRefs: ["saas.activation-ladder.v2"],
  budgetDefaults: { maxCostCents: 50_000, maxSteps: 40, maxConsecutiveFailures: 3 },
};

const saasChurnReduction: MissionTemplate = {
  id: "saas.churn-reduction",
  businessType: "saas",
  name: "Churn reduction",
  description:
    "Keep the revenue you already won: at-risk detection, save plays, and expansion motions — all user-facing touchpoints approval-gated.",
  goals: [
    { metric: "churn_rate", label: "Churn rate", targetValue: 3, unit: "%", timeframeDays: 90, direction: "decrease", baselineHint: "current monthly churn rate" },
    { metric: "expansion_revenue", label: "Expansion revenue", targetValue: 20000, unit: "USD", timeframeDays: 90, direction: "increase" },
  ],
  plan: [
    { order: 1, key: "churn-audit", title: "Audit churn drivers", kind: "research", executor: "researcher", description: "Cancellation reasons, at-risk signals, cohort decay curves.", tier: 0, checkpointAfter: true },
    { order: 2, key: "retention-plan", title: "Draft retention plan", kind: "plan", executor: "planner", description: "At-risk detection, save plays, expansion triggers.", tier: 0, checkpointAfter: true, playbookRef: "saas.retention-plays.v1" },
    { order: 3, key: "draft-save-plays", title: "Draft save plays", kind: "draft", executor: "drafter", description: "Save-offer and check-in copy in draft mode.", tier: 0, checkpointAfter: false },
    { order: 4, key: "approve-save-plays", title: "Approve save plays", kind: "approval", executor: "human", description: "Human approves customer-facing save payloads (Tier 2).", tier: 2, checkpointAfter: true },
    { order: 5, key: "run-save-plays", title: "Run approved save plays", kind: "execute", executor: "scheduler", description: "Approved plays execute via the approval executor only.", tier: 1, checkpointAfter: true },
    { order: 6, key: "retention-attribution", title: "Retention attribution", kind: "analyze", executor: "analyst", description: "Which plays saved accounts? Learnings to Growth Memory.", tier: 0, checkpointAfter: true },
  ],
  successMetrics: ["churn rate", "gross revenue retention", "net revenue retention", "save-play win rate"],
  typicalCheckpoints: [
    "Week 2: save plays approved and armed",
    "Week 6: churn-rate check vs. baseline",
    "Week 12: goal reckoning",
  ],
  playbookRefs: ["saas.retention-plays.v1"],
  budgetDefaults: { maxCostCents: 50_000, maxSteps: 40, maxConsecutiveFailures: 3 },
};

// ---------------------------------------------------------------------------
// Ecommerce
// ---------------------------------------------------------------------------

const ecommerceRepeatPurchase: MissionTemplate = {
  id: "ecommerce.repeat-purchase",
  businessType: "ecommerce",
  name: "Repeat purchase rate",
  description:
    "Grow the second order: post-purchase sequences, replenishment triggers, and loyalty nudges — sends stay drafted until approved.",
  goals: [
    { metric: "repeat_purchase_rate", label: "Repeat purchase rate", targetValue: 32, unit: "%", timeframeDays: 90, direction: "increase" },
    { metric: "repeat_revenue", label: "Repeat revenue", targetValue: 60000, unit: "USD", timeframeDays: 90, direction: "increase" },
  ],
  plan: [
    { order: 1, key: "retention-audit", title: "Audit repeat behavior", kind: "research", executor: "researcher", description: "Repurchase intervals, category affinities, one-and-done segments.", tier: 0, checkpointAfter: true },
    { order: 2, key: "retention-plan", title: "Draft repeat-purchase plan", kind: "plan", executor: "planner", description: "Post-purchase sequence, replenishment triggers, loyalty nudges.", tier: 0, checkpointAfter: true, playbookRef: "ecommerce.repeat-engine.v2" },
    { order: 3, key: "draft-sequences", title: "Draft post-purchase sequences", kind: "draft", executor: "drafter", description: "Email/SMS copy in draft mode — nothing sends without approval.", tier: 0, checkpointAfter: false },
    { order: 4, key: "approve-sequences", title: "Approve sequences", kind: "approval", executor: "human", description: "Human approves customer-facing sequences (Tier 2).", tier: 2, checkpointAfter: true },
    { order: 5, key: "run-sequences", title: "Run approved sequences", kind: "execute", executor: "scheduler", description: "Approved sequences execute via the approval executor only.", tier: 1, checkpointAfter: true },
    { order: 6, key: "repeat-attribution", title: "Repeat attribution", kind: "analyze", executor: "analyst", description: "Which sequences drove second orders? Learnings to Growth Memory.", tier: 0, checkpointAfter: true },
  ],
  successMetrics: ["repeat purchase rate", "repeat revenue", "time to second order", "sequence click-to-order rate"],
  typicalCheckpoints: [
    "Week 2: sequences approved and live",
    "Week 6: repeat-rate check",
    "Week 12: goal reckoning",
  ],
  playbookRefs: ["ecommerce.repeat-engine.v2"],
  budgetDefaults: { maxCostCents: 50_000, maxSteps: 40, maxConsecutiveFailures: 3 },
};

const ecommerceCartRecovery: MissionTemplate = {
  id: "ecommerce.cart-recovery",
  businessType: "ecommerce",
  name: "Cart recovery",
  description:
    "Recover abandoned carts with a tested reminder ladder — draft modes first, human approval before any customer send.",
  goals: [
    { metric: "recovered_carts", label: "Recovered carts", targetValue: 400, unit: "carts", timeframeDays: 90, direction: "increase" },
    { metric: "recovery_rate", label: "Recovery rate", targetValue: 12, unit: "%", timeframeDays: 90, direction: "increase" },
  ],
  plan: [
    { order: 1, key: "abandonment-audit", title: "Audit abandonment", kind: "research", executor: "researcher", description: "Abandonment rate by step, cart value distribution, timing patterns.", tier: 0, checkpointAfter: true },
    { order: 2, key: "recovery-plan", title: "Draft recovery ladder", kind: "plan", executor: "planner", description: "Reminder timing ladder + offer tests (Test Lab discipline).", tier: 0, checkpointAfter: true, playbookRef: "ecommerce.cart-ladder.v2" },
    { order: 3, key: "draft-reminders", title: "Draft reminder ladder", kind: "draft", executor: "drafter", description: "Reminder copy in draft mode.", tier: 0, checkpointAfter: false },
    { order: 4, key: "approve-reminders", title: "Approve reminder ladder", kind: "approval", executor: "human", description: "Human approves customer-facing reminders (Tier 2).", tier: 2, checkpointAfter: true },
    { order: 5, key: "run-reminders", title: "Run approved ladder", kind: "execute", executor: "scheduler", description: "Approved ladder executes via the approval executor only.", tier: 1, checkpointAfter: true },
    { order: 6, key: "recovery-attribution", title: "Recovery attribution", kind: "analyze", executor: "analyst", description: "Which ladder rungs recovered carts? Learnings to Growth Memory.", tier: 0, checkpointAfter: true },
  ],
  successMetrics: ["recovered carts", "recovery rate", "recovered revenue", "unsubscribe rate guardrail"],
  typicalCheckpoints: [
    "Week 2: ladder approved and live",
    "Week 6: recovery-rate check",
    "Week 12: goal reckoning",
  ],
  playbookRefs: ["ecommerce.cart-ladder.v2"],
  budgetDefaults: { maxCostCents: 40_000, maxSteps: 36, maxConsecutiveFailures: 3 },
};

// ---------------------------------------------------------------------------
// Professional services (consulting/legal/finance)
// ---------------------------------------------------------------------------

const proServicesConsultBookings: MissionTemplate = {
  id: "professional-services.consultation-bookings",
  businessType: "professional-services",
  name: "Consultation bookings",
  description:
    "Fill the consult calendar: authority content, referral asks, and a tight booking flow — every external send approval-gated.",
  goals: [
    { metric: "consultations_booked", label: "Consultations booked", targetValue: 30, unit: "consultations", timeframeDays: 90, direction: "increase" },
    { metric: "show_rate", label: "Show rate", targetValue: 80, unit: "%", timeframeDays: 90, direction: "increase" },
  ],
  plan: [
    { order: 1, key: "pipeline-audit", title: "Audit consult pipeline", kind: "research", executor: "researcher", description: "Where do consults come from today? Booking flow friction, no-show causes.", tier: 0, checkpointAfter: true },
    { order: 2, key: "pipeline-plan", title: "Draft booking-growth plan", kind: "plan", executor: "planner", description: "Authority content cadence, referral asks, booking-flow fixes.", tier: 0, checkpointAfter: true, playbookRef: "pro-services.authority-engine.v1" },
    { order: 3, key: "draft-authority", title: "Draft authority content", kind: "draft", executor: "drafter", description: "Insight pieces + referral-ask copy in draft mode.", tier: 0, checkpointAfter: false },
    { order: 4, key: "approve-authority", title: "Approve content batch", kind: "approval", executor: "human", description: "Human approves external-facing content (Tier 2).", tier: 2, checkpointAfter: true },
    { order: 5, key: "run-authority", title: "Run approved cadence", kind: "execute", executor: "scheduler", description: "Approved content scheduled via the approval executor only.", tier: 1, checkpointAfter: true },
    { order: 6, key: "booking-attribution", title: "Booking attribution", kind: "analyze", executor: "analyst", description: "Which content drove consults? Learnings to Growth Memory.", tier: 0, checkpointAfter: true },
  ],
  successMetrics: ["consultations booked", "show rate", "consult → client rate", "cost per consultation"],
  typicalCheckpoints: [
    "Week 2: first content batch approved",
    "Week 6: booking-pace check",
    "Week 12: goal reckoning",
  ],
  playbookRefs: ["pro-services.authority-engine.v1"],
  budgetDefaults: { maxCostCents: 40_000, maxSteps: 36, maxConsecutiveFailures: 3 },
};

const proServicesProposalWinRate: MissionTemplate = {
  id: "professional-services.proposal-win-rate",
  businessType: "professional-services",
  name: "Proposal win rate",
  description:
    "Win more of what you pitch: proposal quality review, follow-up discipline, and objection handling — client-facing material always approved first.",
  goals: [
    { metric: "proposal_win_rate", label: "Proposal win rate", targetValue: 40, unit: "%", timeframeDays: 90, direction: "increase" },
    { metric: "proposals_sent", label: "Proposals sent", targetValue: 25, unit: "proposals", timeframeDays: 90, direction: "increase" },
  ],
  plan: [
    { order: 1, key: "proposal-audit", title: "Audit proposal performance", kind: "research", executor: "researcher", description: "Win/loss by segment, time-to-decision, common objections.", tier: 0, checkpointAfter: true },
    { order: 2, key: "proposal-plan", title: "Draft win-rate plan", kind: "plan", executor: "planner", description: "Proposal template upgrades, follow-up cadence, objection handling.", tier: 0, checkpointAfter: true, playbookRef: "pro-services.proposal-system.v1" },
    { order: 3, key: "draft-followup", title: "Draft follow-up sequences", kind: "draft", executor: "drafter", description: "Post-proposal follow-up copy in draft mode.", tier: 0, checkpointAfter: false },
    { order: 4, key: "approve-followup", title: "Approve follow-up sequences", kind: "approval", executor: "human", description: "Human approves client-facing follow-ups (Tier 2).", tier: 2, checkpointAfter: true },
    { order: 5, key: "run-followup", title: "Run approved follow-ups", kind: "execute", executor: "scheduler", description: "Approved sequences execute via the approval executor only.", tier: 1, checkpointAfter: true },
    { order: 6, key: "win-attribution", title: "Win-rate attribution", kind: "analyze", executor: "analyst", description: "Which changes moved win rate? Learnings to Growth Memory.", tier: 0, checkpointAfter: true },
  ],
  successMetrics: ["proposal win rate", "proposals sent", "average deal size", "time to decision"],
  typicalCheckpoints: [
    "Week 2: follow-up sequences approved",
    "Week 6: win-rate check vs. baseline",
    "Week 12: goal reckoning",
  ],
  playbookRefs: ["pro-services.proposal-system.v1"],
  budgetDefaults: { maxCostCents: 30_000, maxSteps: 32, maxConsecutiveFailures: 3 },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const MISSION_TEMPLATES: MissionTemplate[] = [
  homeServicesBookedJobGrowth,
  homeServicesReviewVelocity,
  homeServicesSlowSeasonFill,
  localServicesQuoteVolume,
  localServicesGbpVisibility,
  saasTrialStarts,
  saasTrialToPaid,
  saasChurnReduction,
  ecommerceRepeatPurchase,
  ecommerceCartRecovery,
  proServicesConsultBookings,
  proServicesProposalWinRate,
];

export class TemplateNotFoundError extends Error {
  constructor(templateId: string) {
    super(`Unknown mission template: "${templateId}".`);
    this.name = "TemplateNotFoundError";
  }
}

/** Look up a template by id. Throws TemplateNotFoundError when unknown. */
export function getTemplate(templateId: string): MissionTemplate {
  const t = MISSION_TEMPLATES.find((t) => t.id === templateId);
  if (!t) throw new TemplateNotFoundError(templateId);
  return t;
}

export function listTemplates(): MissionTemplate[] {
  return [...MISSION_TEMPLATES];
}

export function templatesByBusinessType(): Record<BusinessType, MissionTemplate[]> {
  const out = {} as Record<BusinessType, MissionTemplate[]>;
  for (const bt of BUSINESS_TYPES) out[bt] = [];
  for (const t of MISSION_TEMPLATES) out[t.businessType].push(t);
  return out;
}
