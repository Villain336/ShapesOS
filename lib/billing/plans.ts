// Marketr — admin-configurable plan definitions (Phase 13 Wave A).
//
// ═══════════════════════════════════════════════════════════════════════════
//  TICO — EDIT THIS FILE to change plan names, prices, features, or which
//  Stripe price backs each plan. These are plain EDITABLE DEFAULTS: nothing
//  here is fetched from Stripe, so the Plans page shows exactly what you
//  write below. After editing, redeploy (or restart the preview) to take
//  effect.
//
//  To wire a plan to real money, create a recurring Price in the Stripe
//  Dashboard for that plan and put its Price id (price_…) in the matching
//  STRIPE_PRICE_* env var (see .env.example). A plan with no Price id set
//  shows on the Plans page but its "Choose" button explains it isn't
//  purchasable yet — it never 500s.
// ═══════════════════════════════════════════════════════════════════════════
//
// Each plan's monthly credit pool comes from TIER_INCLUDED_CREDITS in
// lib/metering/credits.ts (the single source of truth for metering). If you
// change a pool there, the Plans page picks it up automatically.

import { TIER_INCLUDED_CREDITS } from "@/lib/metering/credits";

/** Plan ids that can carry a paid subscription. self_hosted is BYO-keys and is never purchasable. */
export type PaidPlanId = "starter" | "pro" | "agency";

export interface BillingPlan {
  /** Prisma Plan enum key. Must exist in TIER_INCLUDED_CREDITS. */
  id: PaidPlanId;
  name: string;
  tagline: string;
  /** Monthly price in USD cents. Displayed as e.g. $29/mo. */
  priceCents: number;
  /** Name of the env var holding this plan's Stripe recurring Price id (price_…). */
  stripePriceEnv: string;
  /** Shown as the feature checklist on the tier card. */
  features: string[];
  /** Optional ribbon on the card, e.g. "Most popular". */
  badge?: string;
}

// ── EDITABLE DEFAULTS ─────────────────────────────────────────────────────
// Seed prices mirror the spec Appendix A tiers ($29 / $79 / $199). Change
// freely — these are Tico's knobs, not Stripe's.

export const PLANS: BillingPlan[] = [
  {
    id: "starter",
    name: "Starter",
    tagline: "For a single project getting its growth loop going.",
    priceCents: 2900,
    stripePriceEnv: "STRIPE_PRICE_STARTER",
    features: [
      "2,500 included credits / month",
      "1 project · 2 seats",
      "Keyword research + competitor gap",
      "AI content engine",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    tagline: "For teams running real campaigns every week.",
    priceCents: 7900,
    stripePriceEnv: "STRIPE_PRICE_PRO",
    badge: "Most popular",
    features: [
      "10,000 included credits / month",
      "5 projects · 5 seats",
      "Everything in Starter",
      "Growth memory + missions + playbooks",
      "Competitor radar + content refresh engine",
    ],
  },
  {
    id: "agency",
    name: "Agency",
    tagline: "For agencies running ShapesOS for clients.",
    priceCents: 19900,
    stripePriceEnv: "STRIPE_PRICE_AGENCY",
    features: [
      "30,000 included credits / month",
      "Unlimited projects · 15 seats",
      "Everything in Pro",
      "White-label client reports",
      "Priority support",
    ],
  },
];

// Fail closed on config drift: every purchasable plan must have a metering
// pool, and there must be no duplicate ids. Catches a bad edit at boot.
for (const plan of PLANS) {
  if (!(plan.id in TIER_INCLUDED_CREDITS)) {
    throw new Error(`billing plan misconfiguration: "${plan.id}" has no entry in TIER_INCLUDED_CREDITS`);
  }
}
if (new Set(PLANS.map((p) => p.id)).size !== PLANS.length) {
  throw new Error("billing plan misconfiguration: duplicate plan ids in PLANS");
}

export function planById(planId: string): BillingPlan {
  const plan = PLANS.find((p) => p.id === planId);
  if (!plan) throw new Error(`unknown billing plan: ${planId}`);
  return plan;
}

/** Monthly included credit pool for a plan (single source: metering/credits.ts). */
export function includedCreditsForBillingPlan(planId: PaidPlanId): number {
  return TIER_INCLUDED_CREDITS[planId];
}

/**
 * The Stripe recurring Price id for a plan, from its configured env var.
 * Null when the host hasn't linked the plan yet — the UI treats this as
 * "not purchasable", never as an error.
 */
export function stripePriceIdFor(plan: BillingPlan): string | null {
  const raw = process.env[plan.stripePriceEnv];
  const id = (raw ?? "").trim();
  return id.startsWith("price_") ? id : null;
}

/** Reverse-lookup: which plan does this Stripe Price id belong to? Null when unknown. */
export function planIdForStripePrice(priceId: string | null | undefined): PaidPlanId | null {
  if (!priceId) return null;
  for (const plan of PLANS) {
    if (stripePriceIdFor(plan) === priceId) return plan.id;
  }
  return null;
}

/** Display price, e.g. "$29". */
export function planPriceDisplay(plan: BillingPlan): string {
  return `$${(plan.priceCents / 100).toFixed(plan.priceCents % 100 === 0 ? 0 : 2)}`;
}

/** Human name for any workspace plan, including the non-purchasable ones. */
export function planDisplayName(planId: string): string {
  if (planId === "self_hosted") return "Self-hosted";
  if (planId === "trial") return "Trial";
  return PLANS.find((p) => p.id === planId)?.name ?? planId;
}
