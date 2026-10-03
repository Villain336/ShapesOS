// ShapesOS — plan entitlements (Phase 4a, audit §7 item 8).
//
// ONE table answers "what does this plan include?" for every tiered feature
// and limit. The server enforces it (403 + upgrade message via
// EntitlementError / entitlementDenied) and the UI reads the same table to
// hide or disable what a plan doesn't include. Credit pools stay in
// lib/metering/credits.ts (TIER_INCLUDED_CREDITS); this file is everything
// else that differs by plan.
//
//   self_hosted  everything, no limits (BYO keys, your own box)
//   trial        Pro features, Starter limits, no white-label
//   starter      the core product, 1 project, 2 seats
//   pro          + API/MCP, outbound webhooks, custom dashboard branding
//   agency       + white-label, custom domains, SSO, SCIM, client workspaces
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
] as const;
export type Feature = (typeof FEATURES)[number];

/** Tiered numeric limits. null = unlimited. */
export const LIMITS = ["seats", "workspaces", "projects"] as const;
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
};

export const LIMIT_LABELS: Record<LimitKey, string> = {
  seats: "Seats",
  workspaces: "Workspaces",
  projects: "Projects",
};

const PRO_FEATURES: readonly Feature[] = ["api_access", "webhooks", "custom_branding"];

// ── EDITABLE DEFAULTS ─────────────────────────────────────────────────────
// Keep the plan cards in lib/billing/plans.ts in step with these numbers.
export const PLAN_ENTITLEMENTS: Record<Plan, PlanEntitlements> = {
  self_hosted: {
    features: FEATURES,
    limits: { seats: null, workspaces: null, projects: null },
  },
  trial: {
    features: PRO_FEATURES,
    limits: { seats: 2, workspaces: 1, projects: 1 },
  },
  starter: {
    features: [],
    limits: { seats: 2, workspaces: 1, projects: 1 },
  },
  pro: {
    features: PRO_FEATURES,
    limits: { seats: 5, workspaces: 3, projects: 5 },
  },
  agency: {
    features: FEATURES,
    limits: { seats: 15, workspaces: 25, projects: null },
  },
};

const NONE: PlanEntitlements = { features: [], limits: { seats: 0, workspaces: 0, projects: 0 } };

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

/** The cheapest paid plan that includes a feature (for the upgrade message). */
export function cheapestPlanWith(feature: Feature): "starter" | "pro" | "agency" | null {
  for (const p of ["starter", "pro", "agency"] as const) {
    if (planHasFeature(p, feature)) return p;
  }
  return null;
}

const PLAN_NAMES: Record<string, string> = { starter: "Starter", pro: "Pro", agency: "Agency" };

export function featureUpgradeMessage(feature: Feature): string {
  const plan = cheapestPlanWith(feature);
  const label = FEATURE_LABELS[feature];
  return plan
    ? `${label} isn't included in your plan. Upgrade to ${PLAN_NAMES[plan]} or above in Billing.`
    : `${label} isn't included in your plan.`;
}

export function limitUpgradeMessage(limit: LimitKey, max: number): string {
  const what = LIMIT_LABELS[limit].toLowerCase();
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
