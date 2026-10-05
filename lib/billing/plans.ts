// ShapesOS — plan catalogue (Phase 13 Wave A; Phase 15.3 pricing).
//
// ═══════════════════════════════════════════════════════════════════════════
//  OWNER KNOBS — pricing shape is BASE FEE + SEATS + CREDITS.
//  Every number is a named constant; nothing is fetched from Stripe, so the
//  /pricing page, the billing hub and the plan cards show exactly what is
//  written here (and in the two sibling tables below). After editing,
//  redeploy (or restart the preview) to take effect.
//
//    prices, extra-seat and extra-workspace prices, annual discount → HERE
//    included seats, workspaces, projects, twin sites, features
//                                         → lib/billing/entitlements.ts
//    included credits (one-line ×2 after the Phase 17 evaluation)
//                                         → lib/metering/credits.ts
//
//  To wire a plan to real money, create recurring Prices in the Stripe
//  Dashboard and put their ids (price_…) in the plan's env vars (see
//  .env.example): STRIPE_PRICE_<PLAN> (monthly base fee),
//  STRIPE_PRICE_<PLAN>_ANNUAL (yearly base fee), STRIPE_PRICE_SEAT_<PLAN>
//  and STRIPE_PRICE_SEAT_<PLAN>_ANNUAL (per-unit extra seat, billed as a
//  QUANTITY line). A plan with no Price id set shows everywhere but its
//  "Choose" button explains it isn't purchasable yet — it never 500s.
// ═══════════════════════════════════════════════════════════════════════════
//
// Pure and client-safe: no database, no Stripe import.

import type { Plan } from "@prisma/client";
import {
  CREDITS_PER_DOLLAR,
  CREDIT_COSTS,
  IMAGE_CREDITS_BY_QUALITY,
  OVERAGE_CREDITS_PER_CENT,
  TIER_INCLUDED_CREDITS,
  TOPUP_PACKS,
  TRIAL_INCLUDED_CREDITS,
} from "@/lib/metering/credits";
import {
  FEATURES,
  INCLUDED_SEATS,
  PLAN_ENTITLEMENTS,
  PROJECT_LIMITS,
  TWIN_SITE_LIMITS,
  WORKSPACE_LIMITS,
  planHasFeature,
} from "@/lib/billing/entitlements";
import { TRIAL_DAYS } from "@/lib/billing/trial";

/** Plan ids that can carry a paid subscription. self_hosted and trial are never purchasable. */
export type PaidPlanId = "starter" | "pro" | "business" | "agency";
export const PAID_PLAN_IDS = ["starter", "pro", "business", "agency"] as const satisfies readonly PaidPlanId[];

/** Stripe recurring intervals ShapesOS sells. */
export type BillingInterval = "month" | "year";
export const BILLING_INTERVALS = ["month", "year"] as const satisfies readonly BillingInterval[];

// ── EDITABLE DEFAULTS ─────────────────────────────────────────────────────

/** Monthly base fee per paid plan, USD cents. */
export const PLAN_PRICE_CENTS = {
  starter: 5_900,
  pro: 19_900,
  business: 49_900,
  agency: 39_900,
} as const satisfies Record<PaidPlanId, number>;

/** Price of each seat beyond the plan's included seats, USD cents per month. */
export const EXTRA_SEAT_PRICE_CENTS = {
  starter: 1_900,
  pro: 1_900,
  business: 1_500,
  agency: 1_900,
} as const satisfies Record<PaidPlanId, number>;

/**
 * Agency: price of each client workspace beyond WORKSPACE_LIMITS.agency,
 * USD cents per month. Advertised; not self-serve yet — past the limit the
 * workspace-creation gate still refuses (see the report: deliberately not
 * built in 15.3).
 */
export const AGENCY_EXTRA_WORKSPACE_PRICE_CENTS = 1_500;

/** Annual billing = this many monthly fees for twelve months ("2 months free"). */
export const ANNUAL_BILLED_MONTHS = 10;

// ── Plan cards ────────────────────────────────────────────────────────────

export interface BillingPlan {
  /** Prisma Plan enum key. Must exist in TIER_INCLUDED_CREDITS and PLAN_ENTITLEMENTS. */
  id: PaidPlanId;
  name: string;
  tagline: string;
  /** Monthly base fee in USD cents (PLAN_PRICE_CENTS). */
  priceCents: number;
  /** Per extra seat per month in USD cents (EXTRA_SEAT_PRICE_CENTS). */
  extraSeatCents: number;
  /** Env var holding the monthly base-fee Stripe Price id. */
  stripePriceEnv: string;
  /** Env var holding the yearly base-fee Stripe Price id. */
  stripeAnnualPriceEnv: string;
  /** Env var holding the monthly per-seat Stripe Price id (quantity line). */
  stripeSeatPriceEnv: string;
  /** Env var holding the yearly per-seat Stripe Price id (quantity line). */
  stripeSeatAnnualPriceEnv: string;
  /**
   * The plan's feature bullets, written WITHOUT numbers — seats, credits,
   * workspaces and twin sites are added from the constants by planOffer(),
   * so a number lives in exactly one place.
   */
  features: string[];
  /** Optional ribbon on the card, e.g. "Most popular". */
  badge?: string;
  /** Agency: the included credits are one pool shared by its client workspaces. */
  creditsPooled?: boolean;
}

function paidPlan(
  id: PaidPlanId,
  name: string,
  tagline: string,
  features: string[],
  extra: Pick<BillingPlan, "badge" | "creditsPooled"> = {},
): BillingPlan {
  const env = id.toUpperCase();
  return {
    id,
    name,
    tagline,
    priceCents: PLAN_PRICE_CENTS[id],
    extraSeatCents: EXTRA_SEAT_PRICE_CENTS[id],
    stripePriceEnv: `STRIPE_PRICE_${env}`,
    stripeAnnualPriceEnv: `STRIPE_PRICE_${env}_ANNUAL`,
    stripeSeatPriceEnv: `STRIPE_PRICE_SEAT_${env}`,
    stripeSeatAnnualPriceEnv: `STRIPE_PRICE_SEAT_${env}_ANNUAL`,
    features,
    ...extra,
  };
}

export const PLANS: BillingPlan[] = [
  paidPlan("starter", "Starter", "Run a small business from one workspace.", [
    "CRM, invoicing, inventory, projects and helpdesk",
    "SEO and content",
    "Agents and connectors",
  ]),
  paidPlan(
    "pro",
    "Pro",
    "For teams running operations and growth every week.",
    [
      "Everything in Starter",
      "Accounting, manufacturing and events",
      "Point of sale and payroll (Gusto)",
      "API, MCP and outbound webhooks",
      "Custom dashboard branding",
    ],
    { badge: "Most popular" },
  ),
  paidPlan("business", "Business", "For larger teams that need SSO and scale.", [
    "Everything in Pro",
    "Single sign-on and SCIM provisioning",
    "Audit export",
    "Priority support",
  ]),
  paidPlan(
    "agency",
    "Agency",
    "For agencies running ShapesOS for clients.",
    [
      "Everything in Pro, plus SSO and SCIM",
      "White-label client pages and custom domains",
      "Client billing view",
    ],
    { creditsPooled: true },
  ),
];

// ── Consistency (boot-time) ───────────────────────────────────────────────

/**
 * Every problem with the plan tables, or [] when they agree. Checked at
 * module load (fail closed on a bad edit) and by the unit suite: every plan
 * has entitlements and a credit pool; every paid plan has a base fee, an
 * extra-seat price, included seats and a positive pool; ids are unique; no
 * feature bullet hard-codes a number (numbers come from the constants).
 */
export function planConsistencyProblems(): string[] {
  const problems: string[] = [];
  const allPlans: Plan[] = ["self_hosted", "trial", "starter", "pro", "business", "agency"];
  for (const plan of allPlans) {
    if (!(plan in PLAN_ENTITLEMENTS)) problems.push(`${plan}: no entry in PLAN_ENTITLEMENTS`);
    if (!(plan in TIER_INCLUDED_CREDITS)) problems.push(`${plan}: no entry in TIER_INCLUDED_CREDITS`);
  }
  if (new Set(PLANS.map((p) => p.id)).size !== PLANS.length) problems.push("duplicate plan ids in PLANS");
  for (const id of PAID_PLAN_IDS) {
    const plan = PLANS.find((p) => p.id === id);
    if (!plan) {
      problems.push(`${id}: missing from PLANS`);
      continue;
    }
    if (!(plan.priceCents > 0)) problems.push(`${id}: base fee must be > 0`);
    if (!(plan.extraSeatCents > 0)) problems.push(`${id}: extra-seat price must be > 0`);
    const seats = INCLUDED_SEATS[id];
    if (typeof seats !== "number" || seats < 1) problems.push(`${id}: included seats must be a number ≥ 1`);
    if (!(TIER_INCLUDED_CREDITS[id] > 0)) problems.push(`${id}: included credits must be > 0`);
    for (const f of plan.features) {
      if (/\d/.test(f)) problems.push(`${id}: feature "${f}" hard-codes a number — derive it from the constants`);
    }
  }
  if (!(ANNUAL_BILLED_MONTHS > 0 && ANNUAL_BILLED_MONTHS <= 12)) problems.push("ANNUAL_BILLED_MONTHS must be 1–12");
  return problems;
}

{
  const problems = planConsistencyProblems();
  if (problems.length) throw new Error(`billing plan misconfiguration: ${problems.join("; ")}`);
}

// ── Lookups ───────────────────────────────────────────────────────────────

export function isPaidPlanId(id: string | null | undefined): id is PaidPlanId {
  return !!id && (PAID_PLAN_IDS as readonly string[]).includes(id);
}

export function planById(planId: string): BillingPlan {
  const plan = PLANS.find((p) => p.id === planId);
  if (!plan) throw new Error(`unknown billing plan: ${planId}`);
  return plan;
}

export function isBillingInterval(v: unknown): v is BillingInterval {
  return v === "month" || v === "year";
}

/** Monthly included credit pool for a plan (single source: metering/credits.ts). */
export function includedCreditsForBillingPlan(planId: PaidPlanId): number {
  return TIER_INCLUDED_CREDITS[planId];
}

/** Base fee for an interval, USD cents (annual = ANNUAL_BILLED_MONTHS × monthly). */
export function planPriceCents(plan: BillingPlan, interval: BillingInterval = "month"): number {
  return interval === "year" ? plan.priceCents * ANNUAL_BILLED_MONTHS : plan.priceCents;
}

/** Extra-seat price for an interval, USD cents per seat. */
export function extraSeatPriceCents(plan: BillingPlan, interval: BillingInterval = "month"): number {
  return interval === "year" ? plan.extraSeatCents * ANNUAL_BILLED_MONTHS : plan.extraSeatCents;
}

/** Extra-seat price per month for any plan id; null when the plan can't buy extra seats (self_hosted, trial). */
export function extraSeatMonthlyCentsFor(planId: string | null | undefined): number | null {
  return isPaidPlanId(planId) ? EXTRA_SEAT_PRICE_CENTS[planId] : null;
}

function priceIdFromEnv(envName: string): string | null {
  const id = (process.env[envName] ?? "").trim();
  return id.startsWith("price_") ? id : null;
}

/**
 * The Stripe recurring Price id for a plan's base fee, from its configured
 * env var. Null when the host hasn't linked it yet — the UI treats this as
 * "not purchasable", never as an error.
 */
export function stripePriceIdFor(plan: BillingPlan, interval: BillingInterval = "month"): string | null {
  return priceIdFromEnv(interval === "year" ? plan.stripeAnnualPriceEnv : plan.stripePriceEnv);
}

/** The Stripe per-unit Price id for the plan's extra seats; null when not linked. */
export function stripeSeatPriceIdFor(plan: BillingPlan, interval: BillingInterval = "month"): string | null {
  return priceIdFromEnv(interval === "year" ? plan.stripeSeatAnnualPriceEnv : plan.stripeSeatPriceEnv);
}

/** Reverse-lookup: which plan (and interval) does this base-fee Price id belong to? */
export function planForStripePrice(
  priceId: string | null | undefined,
): { planId: PaidPlanId; interval: BillingInterval } | null {
  if (!priceId) return null;
  for (const plan of PLANS) {
    for (const interval of BILLING_INTERVALS) {
      if (stripePriceIdFor(plan, interval) === priceId) return { planId: plan.id, interval };
    }
  }
  return null;
}

/** Reverse-lookup kept for existing callers: the plan id for a base-fee Price id. */
export function planIdForStripePrice(priceId: string | null | undefined): PaidPlanId | null {
  return planForStripePrice(priceId)?.planId ?? null;
}

/** True when this Price id is one of the configured extra-seat Prices. */
export function isSeatStripePrice(priceId: string | null | undefined): boolean {
  if (!priceId) return false;
  return PLANS.some((p) => BILLING_INTERVALS.some((i) => stripeSeatPriceIdFor(p, i) === priceId));
}

// ── Display ───────────────────────────────────────────────────────────────

/** "$59", "$590", "$12.50". */
export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

/** Display price, e.g. "$59". */
export function planPriceDisplay(plan: BillingPlan, interval: BillingInterval = "month"): string {
  return formatUsd(planPriceCents(plan, interval));
}

/** Human name for any workspace plan, including the non-purchasable ones. */
export function planDisplayName(planId: string): string {
  if (planId === "self_hosted") return "Self-hosted";
  if (planId === "trial") return "Trial";
  return PLANS.find((p) => p.id === planId)?.name ?? planId;
}

const n = (v: number) => v.toLocaleString("en-US");
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

function twinSitesText(planId: Plan): string | null {
  if (!planHasFeature(planId, "digital_twin")) return null;
  const max = TWIN_SITE_LIMITS[planId];
  return max === null ? "Digital twin, unlimited sites" : `Digital twin, ${plural(max, "site")}`;
}

/**
 * Everything a pricing surface shows for one plan, assembled from the
 * constants (prices here, limits in entitlements.ts, pools in credits.ts).
 * Serializable, so a server page can hand it to a client component.
 */
export interface PlanOffer {
  id: Plan;
  name: string;
  tagline: string;
  badge: string | null;
  /** Null for self_hosted / trial (not sold through Stripe). */
  monthlyCents: number | null;
  /** Yearly base fee (ANNUAL_BILLED_MONTHS × monthly); null when not sold. */
  annualCents: number | null;
  /** Monthly-equivalent of the annual fee. */
  annualMonthlyEquivalentCents: number | null;
  priceNote: string;
  includedSeats: number | null;
  extraSeatCents: number | null;
  includedCredits: number;
  creditsNote: string;
  workspaces: number | null;
  /** The number lines (seats, credits, workspaces, twin) then the plan's bullets. */
  lines: string[];
}

export function planOffer(planId: Plan): PlanOffer {
  if (planId === "self_hosted") {
    return {
      id: planId,
      name: "Self-hosted",
      tagline: "Run ShapesOS on your own server.",
      badge: null,
      monthlyCents: null,
      annualCents: null,
      annualMonthlyEquivalentCents: null,
      priceNote: "Free (AGPL)",
      includedSeats: INCLUDED_SEATS.self_hosted,
      extraSeatCents: null,
      includedCredits: TIER_INCLUDED_CREDITS.self_hosted,
      creditsNote: "Bring your own keys, no credits",
      workspaces: WORKSPACE_LIMITS.self_hosted,
      lines: [
        "Unlimited seats and workspaces",
        "Bring your own model and provider keys, no credits",
        `Everything, all ${n(FEATURES.length)} tiered features included`,
      ],
    };
  }
  if (planId === "trial") {
    return {
      id: planId,
      name: "Trial",
      tagline: "Try the Pro features on a hosted workspace.",
      badge: null,
      monthlyCents: null,
      annualCents: null,
      annualMonthlyEquivalentCents: null,
      priceNote: `${plural(TRIAL_DAYS, "day")} free`,
      includedSeats: INCLUDED_SEATS.trial,
      extraSeatCents: null,
      includedCredits: TRIAL_INCLUDED_CREDITS,
      creditsNote: `${n(TRIAL_INCLUDED_CREDITS)} credits, one time`,
      workspaces: WORKSPACE_LIMITS.trial,
      lines: [
        `${plural(INCLUDED_SEATS.trial, "seat")}`,
        `${n(TRIAL_INCLUDED_CREDITS)} AI credits, one time`,
        `${plural(WORKSPACE_LIMITS.trial, "workspace")}`,
        "Pro features",
      ],
    };
  }
  const plan = planById(planId);
  const seats = INCLUDED_SEATS[plan.id];
  const credits = TIER_INCLUDED_CREDITS[plan.id];
  const workspaces = WORKSPACE_LIMITS[plan.id];
  const creditsNote = plan.creditsPooled
    ? `${n(credits)} credits / month, pooled across client workspaces`
    : `${n(credits)} credits / month`;
  const workspacesLine =
    plan.id === "agency"
      ? `${plural(workspaces, "client workspace")} (+${formatUsd(AGENCY_EXTRA_WORKSPACE_PRICE_CENTS)} each extra)`
      : plural(workspaces, "workspace");
  const twin = twinSitesText(plan.id);
  const projects = PROJECT_LIMITS[plan.id];
  return {
    id: plan.id,
    name: plan.name,
    tagline: plan.tagline,
    badge: plan.badge ?? null,
    monthlyCents: planPriceCents(plan, "month"),
    annualCents: planPriceCents(plan, "year"),
    annualMonthlyEquivalentCents: Math.round(planPriceCents(plan, "year") / 12),
    priceNote: "per month",
    includedSeats: seats,
    extraSeatCents: plan.extraSeatCents,
    includedCredits: credits,
    creditsNote,
    workspaces,
    lines: [
      `${plural(seats, "seat")} included, extra seats ${formatUsd(plan.extraSeatCents)} / month each`,
      plan.creditsPooled
        ? `${n(credits)} AI credits / month, pooled`
        : `${n(credits)} AI credits / month`,
      workspacesLine,
      projects === null ? "Unlimited SEO projects" : plural(projects, "SEO project"),
      ...(twin ? [twin] : []),
      ...plan.features,
    ],
  };
}

/** The order pricing surfaces show plans in. */
export const PRICING_ORDER: readonly Plan[] = ["starter", "pro", "business", "agency"];

/** All plan offers for a pricing surface (paid plans, then trial and self-hosted). */
export function pricingCatalog(): { paid: PlanOffer[]; trial: PlanOffer; selfHosted: PlanOffer } {
  return {
    paid: PRICING_ORDER.map((id) => planOffer(id)),
    trial: planOffer("trial"),
    selfHosted: planOffer("self_hosted"),
  };
}

// ── Public pricing page (/pricing) ────────────────────────────────────────

export interface PricingPageData {
  paid: PlanOffer[];
  trial: PlanOffer;
  selfHosted: PlanOffer;
  annualBilledMonths: number;
  /** "1 credit = $0.01". */
  creditValueDisplay: string;
  /** What credits buy, from the live credit table (lib/metering/credits.ts). */
  creditExamples: Array<{ label: string; credits: string }>;
  topUps: Array<{ priceDisplay: string; credits: number }>;
  overagePerCreditDisplay: string;
}

/** Everything /pricing shows, derived from the constants (no number is typed on the page). */
export function pricingPageData(): PricingPageData {
  const c = pricingCatalog();
  const img = Object.values(IMAGE_CREDITS_BY_QUALITY).map((v) => n(v));
  return {
    ...c,
    annualBilledMonths: ANNUAL_BILLED_MONTHS,
    creditValueDisplay: `1 credit = ${formatUsd(100 / CREDITS_PER_DOLLAR)}`,
    creditExamples: [
      { label: "Keyword research run", credits: n(CREDIT_COSTS.keyword_research.credits) },
      { label: "Site audit", credits: n(CREDIT_COSTS.site_audit.credits) },
      { label: "AI article", credits: n(CREDIT_COSTS.ai_article.credits) },
      { label: "An AI image (low, medium or high quality)", credits: `${img.slice(0, -1).join(", ")} or ${img[img.length - 1]}` },
      { label: "Scheduled agent skill run (base fee)", credits: n(CREDIT_COSTS.skill_run_base.credits) },
      // Model-token metering (Phase 15.2) isn't built yet, so no per-turn
      // figure is promised here; add it from the 15.2 constant when it lands.
    ],
    topUps: TOPUP_PACKS.map((p) => ({ priceDisplay: formatUsd(p.priceCents), credits: p.credits })),
    overagePerCreditDisplay: `$${(1 / OVERAGE_CREDITS_PER_CENT / 100).toFixed(3)}`,
  };
}
