// ShapesOS — plan entitlements (Phase 4a, audit §7 item 8; Phase 15.3 pricing).
//
// ONE table answers "what does this plan include?" for every tiered feature
// and limit. The server enforces it (403 + upgrade message via
// EntitlementError / entitlementDenied) and the UI reads the same table to
// hide or disable what a plan doesn't include. Credit pools stay in
// lib/metering/credits.ts (TIER_INCLUDED_CREDITS) and prices in
// lib/billing/plans.ts; this file is everything else that differs by plan.
//
//   self_hosted  everything, no limits (BYO keys, your own box)
//   trial        Pro features, 3 seats, 1 workspace, no white-label
//   starter      the core product: 3 seats, 1 workspace
//   pro          + API/MCP, webhooks, custom branding, POS, payroll,
//                  digital twin (3 sites): 10 seats, 3 workspaces
//   business     + SSO, SCIM, unlimited twin sites: 25 seats, 10 workspaces
//   agency       + white-label, custom domains: 5 seats, 25 client workspaces
//
// Seats on a PAID plan are the INCLUDED seats: more can be added at the
// plan's extra-seat price, but only after an admin confirms the charge
// (lib/billing/seats.ts). On trial they are a hard limit.
//
// Pure and client-safe (no database import): the server-side checks that read
// a workspace's plan live in ./entitlements-server.ts. Unknown plans fail
// closed: no features, zero limits.

import type { Plan } from "@prisma/client";
import { HttpError } from "@/lib/api/errors";
import { UPGRADE_PATH } from "@/lib/billing/trial";

/** Tiered on/off features. */
export const FEATURES = [
  "white_label",
  "custom_branding",
  "custom_domain",
  "api_access",
  "webhooks",
  "sso",
  "scim",
  // Phase 15.3 (pricing): Pro-and-up operations features.
  "digital_twin",
  "payroll",
  "pos",
] as const;
export type Feature = (typeof FEATURES)[number];

/** Tiered numeric limits. null = unlimited. */
export const LIMITS = ["seats", "workspaces", "projects", "twin_sites"] as const;
export type LimitKey = (typeof LIMITS)[number];

export interface PlanEntitlements {
  features: readonly Feature[];
  limits: Record<LimitKey, number | null>;
}

export const FEATURE_LABELS: Record<Feature, string> = {
  white_label: "White-label client pages",
  custom_branding: "Custom dashboard branding",
  custom_domain: "Custom domains",
  api_access: "API and MCP access",
  webhooks: "Outbound webhooks",
  sso: "Single sign-on",
  scim: "SCIM provisioning",
  digital_twin: "Digital twin",
  payroll: "Payroll",
  pos: "Point of sale",
};

export const LIMIT_LABELS: Record<LimitKey, string> = {
  seats: "Seats",
  workspaces: "Workspaces",
  projects: "Projects",
  twin_sites: "Twin sites",
};

// ── EDITABLE DEFAULTS (owner knobs) ───────────────────────────────────────
// Every number below is a named constant; the plan cards, the /pricing page
// and the billing hub read them (lib/billing/plans.ts planOffer), so a change
// here shows up everywhere. null = unlimited.

/** Seats included in the base fee (paid plans) / the hard seat cap (trial). */
export const INCLUDED_SEATS = {
  self_hosted: null,
  trial: 3,
  starter: 3,
  pro: 10,
  business: 25,
  agency: 5,
} as const satisfies Record<Plan, number | null>;

/** Workspaces one owner may hold on the plan (Agency: client workspaces). */
export const WORKSPACE_LIMITS = {
  self_hosted: null,
  trial: 1,
  starter: 1,
  pro: 3,
  business: 10,
  agency: 25,
} as const satisfies Record<Plan, number | null>;

/** SEO projects per workspace (unchanged from Phase 4a; Business unlimited). */
export const PROJECT_LIMITS = {
  self_hosted: null,
  trial: 1,
  starter: 1,
  pro: 5,
  business: null,
  agency: null,
} as const satisfies Record<Plan, number | null>;

/**
 * Digital twin sites per workspace. Only counted where the plan has the
 * digital_twin feature (Starter has neither). Trial keeps what it had before
 * pricing (no site cap) — the owner rule is that trial and self-hosted keep
 * every feature they have today; set trial to 3 to mirror Pro exactly.
 */
export const TWIN_SITE_LIMITS = {
  self_hosted: null,
  trial: null,
  starter: 0,
  pro: 3,
  business: null,
  agency: null,
} as const satisfies Record<Plan, number | null>;

const PRO_FEATURES: readonly Feature[] = ["api_access", "webhooks", "custom_branding", "digital_twin", "payroll", "pos"];
const BUSINESS_FEATURES: readonly Feature[] = [...PRO_FEATURES, "sso", "scim"];

function limitsOf(plan: Plan): Record<LimitKey, number | null> {
  return {
    seats: INCLUDED_SEATS[plan],
    workspaces: WORKSPACE_LIMITS[plan],
    projects: PROJECT_LIMITS[plan],
    twin_sites: TWIN_SITE_LIMITS[plan],
  };
}

export const PLAN_ENTITLEMENTS: Record<Plan, PlanEntitlements> = {
  self_hosted: { features: FEATURES, limits: limitsOf("self_hosted") },
  // Trial = Pro features (so a trial can try POS, payroll and the twin).
  trial: { features: PRO_FEATURES, limits: limitsOf("trial") },
  starter: { features: [], limits: limitsOf("starter") },
  pro: { features: PRO_FEATURES, limits: limitsOf("pro") },
  business: { features: BUSINESS_FEATURES, limits: limitsOf("business") },
  agency: { features: FEATURES, limits: limitsOf("agency") },
};

/**
 * The upgrade ladder, cheapest first for a business customer. Agency is its
 * own track (white-label for agencies) and comes last, so a business that
 * needs SSO is pointed at Business, not Agency.
 */
export const UPGRADE_LADDER = ["starter", "pro", "business", "agency"] as const;
export type LadderPlan = (typeof UPGRADE_LADDER)[number];

const NONE: PlanEntitlements = { features: [], limits: { seats: 0, workspaces: 0, projects: 0, twin_sites: 0 } };

/** The entitlements of a plan id. Unknown plans → nothing (fail closed). */
export function entitlementsFor(plan: Plan | string | null | undefined): PlanEntitlements {
  if (!plan) return NONE;
  return (PLAN_ENTITLEMENTS as Record<string, PlanEntitlements>)[plan] ?? NONE;
}

export function planHasFeature(plan: Plan | string | null | undefined, feature: Feature): boolean {
  return entitlementsFor(plan).features.includes(feature);
}

/** Numeric limit for a plan; null = unlimited. */
export function planLimit(plan: Plan | string | null | undefined, limit: LimitKey): number | null {
  return entitlementsFor(plan).limits[limit];
}

/** True when `used` already reaches the plan's limit (adding one more is not allowed). */
export function limitReached(plan: Plan | string | null | undefined, limit: LimitKey, used: number): boolean {
  const max = planLimit(plan, limit);
  return max !== null && used >= max;
}

/** The first plan on the upgrade ladder that includes a feature (for the upgrade message). */
export function cheapestPlanWith(feature: Feature): LadderPlan | null {
  for (const p of UPGRADE_LADDER) {
    if (planHasFeature(p, feature)) return p;
  }
  return null;
}

/** The first plan on the ladder whose limit allows more than `used` (null limit = unlimited). */
export function cheapestPlanAbove(limit: LimitKey, used: number): LadderPlan | null {
  for (const p of UPGRADE_LADDER) {
    const max = planLimit(p, limit);
    if (max === null || max > used) return p;
  }
  return null;
}

const PLAN_NAMES: Record<LadderPlan, string> = { starter: "Starter", pro: "Pro", business: "Business", agency: "Agency" };

export function featureUpgradeMessage(feature: Feature): string {
  const plan = cheapestPlanWith(feature);
  const label = FEATURE_LABELS[feature];
  return plan
    ? `${label} isn't included in your plan. Upgrade to ${PLAN_NAMES[plan]} or above in Billing.`
    : `${label} isn't included in your plan.`;
}

export function limitUpgradeMessage(limit: LimitKey, max: number): string {
  const what = LIMIT_LABELS[limit].toLowerCase();
  if (limit === "twin_sites") {
    const next = cheapestPlanAbove(limit, max);
    return `Your plan includes ${max} twin ${max === 1 ? "site" : "sites"}.${next ? ` Upgrade to ${PLAN_NAMES[next]} in Billing for more.` : " Upgrade in Billing to add more."}`;
  }
  return `Your plan includes ${max} ${max === 1 ? what.replace(/s$/, "") : what}. Upgrade in Billing to add more.`;
}

/** 403 with an upgrade prompt. Thrown by server gates; errorResponse maps it. */
export class EntitlementError extends HttpError {
  readonly upgradePath = UPGRADE_PATH;
  constructor(message: string, readonly entitlement: Feature | LimitKey) {
    super(403, message, { code: "upgrade_required" });
    this.name = "EntitlementError";
  }
}

/** Ready-made 403 Response for routes that don't use errorResponse. */
export function entitlementDenied(err: EntitlementError): Response {
  return Response.json(
    { error: err.message, code: "upgrade_required", entitlement: err.entitlement, upgradePath: err.upgradePath },
    { status: 403 },
  );
}

/** Client-safe summary of a plan's entitlements (settings pages, billing). */
export interface EntitlementSummary {
  plan: string;
  features: Record<Feature, boolean>;
  limits: Record<LimitKey, number | null>;
}

export function entitlementSummary(plan: Plan | string): EntitlementSummary {
  const e = entitlementsFor(plan);
  return {
    plan: String(plan),
    features: Object.fromEntries(FEATURES.map((f) => [f, e.features.includes(f)])) as Record<Feature, boolean>,
    limits: { ...e.limits },
  };
}

// ---------------------------------------------------------------------------
// White-label: what public pages may render
// ---------------------------------------------------------------------------

export interface WhiteLabelFields {
  plan: Plan | string;
  whiteLabelLogoUrl: string | null;
  whiteLabelCustomDomain: string | null;
  whiteLabelBrandColor: string | null;
}

/**
 * The white-label values a client-facing page may use. On a plan without
 * white-label, all three are null (the page renders ShapesOS defaults), so
 * stored values from a higher tier stop working after a downgrade. The
 * custom domain additionally needs the custom_domain entitlement.
 */
export function effectiveWhiteLabel<T extends WhiteLabelFields>(ws: T): {
  logoUrl: string | null;
  customDomain: string | null;
  brandColor: string | null;
} {
  if (!planHasFeature(ws.plan, "white_label")) {
    return { logoUrl: null, customDomain: null, brandColor: null };
  }
  return {
    logoUrl: ws.whiteLabelLogoUrl ?? null,
    customDomain: planHasFeature(ws.plan, "custom_domain") ? ws.whiteLabelCustomDomain ?? null : null,
    brandColor: ws.whiteLabelBrandColor ?? null,
  };
}
