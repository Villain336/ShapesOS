// ShapesOS — first-run onboarding for a brand-new workspace (Phase 3, I).
//
// Steps: name → business → connect → report. Shown once: the dashboard home
// sends admins of a workspace whose onboarding isn't finished to
// /dashboard/welcome; finishing or skipping stamps onboardingCompletedAt and
// it never comes back on its own (it stays reachable from Settings →
// General). The current step is saved as the user goes, so leaving midway
// resumes where they stopped. Workspaces that existed before Phase 3 were
// backfilled as completed by the migration.
//
// Business context lands where the company intelligence layer already keeps
// it: one pinned CompanyKnowledge "positioning" entry ("Business profile"),
// readable by agents and editable under Settings → Intelligence. The website
// also becomes the workspace's first project when it has none, which is what
// the onboarding intelligence report reads as the primary domain.

import type { WorkspaceRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { roleAtLeast } from "@/lib/authz";
import { BadRequestError } from "@/lib/api/errors";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

export const ONBOARDING_STEPS = ["name", "business", "connect", "report"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export function isOnboardingStep(v: unknown): v is OnboardingStep {
  return typeof v === "string" && (ONBOARDING_STEPS as readonly string[]).includes(v);
}

export const BUSINESS_TYPES = [
  { id: "local_service", label: "Local service business" },
  { id: "ecommerce", label: "Online store" },
  { id: "b2b_saas", label: "B2B or software" },
  { id: "agency", label: "Agency" },
  { id: "professional", label: "Professional services" },
  { id: "creator", label: "Creator or media" },
  { id: "nonprofit", label: "Nonprofit" },
  { id: "other", label: "Something else" },
] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number]["id"];

export const GOALS = [
  { id: "leads", label: "Get more leads" },
  { id: "search", label: "Rank higher in search" },
  { id: "social", label: "Grow on social" },
  { id: "ads", label: "Make paid ads pay off" },
  { id: "reviews", label: "Get more reviews" },
  { id: "launch", label: "Launch something new" },
  { id: "retention", label: "Bring customers back" },
  { id: "clients", label: "Run marketing for clients" },
] as const;
export type GoalId = (typeof GOALS)[number]["id"];

export interface BusinessProfile {
  businessType: BusinessType | null;
  website: string | null;
  goals: GoalId[];
  notes: string | null;
}

export const PROFILE_TITLE = "Business profile";

/** Bare host from whatever the user typed (https://www.x.com/about → www.x.com). Null when empty. */
export function normalizeWebsite(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw new BadRequestError("Website must be text.");
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    throw new BadRequestError("That website doesn't look like a web address. Try example.com.");
  }
  if (!/^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) {
    throw new BadRequestError("That website doesn't look like a web address. Try example.com.");
  }
  return host;
}

/** Validate the business step's input. Unknown goal ids are rejected, not dropped. */
export function parseBusinessProfile(input: unknown): BusinessProfile {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  let businessType: BusinessType | null = null;
  if (o.businessType !== undefined && o.businessType !== null && o.businessType !== "") {
    if (!BUSINESS_TYPES.some((t) => t.id === o.businessType)) throw new BadRequestError("Pick a business type from the list.");
    businessType = o.businessType as BusinessType;
  }
  const goalsIn = o.goals === undefined || o.goals === null ? [] : o.goals;
  if (!Array.isArray(goalsIn)) throw new BadRequestError("Goals must be a list.");
  const goals: GoalId[] = [];
  for (const g of goalsIn) {
    if (!GOALS.some((x) => x.id === g)) throw new BadRequestError("Pick goals from the list.");
    if (!goals.includes(g as GoalId)) goals.push(g as GoalId);
  }
  let notes: string | null = null;
  if (typeof o.notes === "string" && o.notes.trim()) {
    notes = o.notes.trim();
    if (notes.length > 1000) throw new BadRequestError("Keep the note under 1,000 characters.");
  }
  return { businessType, website: normalizeWebsite(o.website), goals, notes };
}

/** Should this person be sent to the wizard? Only admins+ set a workspace up. */
export function needsOnboarding(
  ws: { onboardingCompletedAt: Date | null },
  role: WorkspaceRole | null | undefined,
): boolean {
  return !ws.onboardingCompletedAt && roleAtLeast(role, "admin");
}

export interface ConnectionSuggestion {
  key: string;
  label: string;
  why: string;
  href: string;
}

const CONNECTIONS: Record<string, ConnectionSuggestion> = {
  gbp: { key: "gbp", label: "Google Business Profile", why: "Reviews, local rankings, and map visibility.", href: "/dashboard/settings/connectors" },
  ga4: { key: "ga4", label: "Google Analytics", why: "Traffic and conversions, so reports show what worked.", href: "/dashboard/settings/connectors" },
  gsc: { key: "gsc", label: "Search Console", why: "The searches you already show up for.", href: "/dashboard/settings/connectors" },
  shopify: { key: "shopify", label: "Shopify", why: "Orders and revenue by product.", href: "/dashboard/settings/connectors" },
  social: { key: "social", label: "Social accounts", why: "Schedule posts and see what lands.", href: "/dashboard/social" },
  ads: { key: "ads", label: "Google Ads or Meta Ads", why: "Spend and results in one place.", href: "/dashboard/settings/connectors" },
  email: { key: "email", label: "Email platform", why: "Lists and newsletters for nurture.", href: "/dashboard/settings/connectors" },
  crm: { key: "crm", label: "Import your contacts", why: "Bring leads and customers into the CRM.", href: "/dashboard/crm" },
};

const BY_TYPE: Record<BusinessType, string[]> = {
  local_service: ["gbp", "ga4", "social", "crm"],
  ecommerce: ["shopify", "ga4", "ads", "email"],
  b2b_saas: ["ga4", "gsc", "crm", "email"],
  agency: ["ga4", "gsc", "ads", "social"],
  professional: ["gbp", "ga4", "crm", "email"],
  creator: ["social", "email", "ga4", "gsc"],
  nonprofit: ["ga4", "social", "email", "crm"],
  other: ["ga4", "gsc", "social", "crm"],
};

/** First connections to suggest, tuned by business type and goals (max 4). */
export function connectionSuggestions(profile: Pick<BusinessProfile, "businessType" | "goals">): ConnectionSuggestion[] {
  const keys = [...BY_TYPE[profile.businessType ?? "other"]];
  const boost: Partial<Record<GoalId, string>> = { reviews: "gbp", ads: "ads", social: "social", search: "gsc", retention: "email", leads: "crm" };
  for (const g of profile.goals) {
    const k = boost[g];
    if (k && !keys.includes(k)) keys.unshift(k);
  }
  return keys.slice(0, 4).map((k) => CONNECTIONS[k]!);
}

// ── Persistence ──────────────────────────────────────────────────────────────

export interface OnboardingState {
  step: OnboardingStep;
  completed: boolean;
  workspaceName: string;
  profile: BusinessProfile;
  hasProject: boolean;
}

export async function loadOnboardingState(workspaceId: string): Promise<OnboardingState> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true, onboardingStep: true, onboardingCompletedAt: true },
  });
  if (!ws) throw new BadRequestError("Workspace not found.");
  const [entry, project] = await Promise.all([
    withWorkspaceScope(workspaceId, (tx) =>
      tx.companyKnowledge.findFirst({
        where: { workspaceId, kind: "positioning", title: PROFILE_TITLE },
        orderBy: { updatedAt: "desc" },
        select: { body: true },
      }),
    ),
    prisma.project.findFirst({ where: { workspaceId }, select: { id: true } }),
  ]);
  const body = (entry?.body ?? {}) as Partial<BusinessProfile>;
  return {
    step: isOnboardingStep(ws.onboardingStep) ? ws.onboardingStep : "name",
    completed: !!ws.onboardingCompletedAt,
    workspaceName: ws.name,
    profile: {
      businessType: BUSINESS_TYPES.some((t) => t.id === body.businessType) ? (body.businessType as BusinessType) : null,
      website: typeof body.website === "string" ? body.website : null,
      goals: Array.isArray(body.goals) ? (body.goals.filter((g) => GOALS.some((x) => x.id === g)) as GoalId[]) : [],
      notes: typeof body.notes === "string" ? body.notes : null,
    },
    hasProject: !!project,
  };
}

/**
 * Save the business step: upsert the pinned "Business profile" knowledge
 * entry, and give the workspace its first project from the website.
 */
export async function saveBusinessProfile(workspaceId: string, profile: BusinessProfile): Promise<{ projectCreated: boolean }> {
  const body = {
    businessType: profile.businessType,
    businessTypeLabel: BUSINESS_TYPES.find((t) => t.id === profile.businessType)?.label ?? null,
    website: profile.website,
    goals: profile.goals,
    goalLabels: profile.goals.map((g) => GOALS.find((x) => x.id === g)?.label ?? g),
    notes: profile.notes,
    source: "onboarding",
  };
  await withWorkspaceScope(workspaceId, async (tx) => {
    const existing = await tx.companyKnowledge.findFirst({
      where: { workspaceId, kind: "positioning", title: PROFILE_TITLE },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    if (existing) {
      await tx.companyKnowledge.update({ where: { id: existing.id }, data: { body, pinned: true } });
    } else {
      await tx.companyKnowledge.create({
        data: { workspaceId, kind: "positioning", title: PROFILE_TITLE, body, pinned: true, confidence: 1 },
      });
    }
  });
  let projectCreated = false;
  if (profile.website) {
    const any = await prisma.project.findFirst({ where: { workspaceId }, select: { id: true } });
    if (!any) {
      await prisma.project.create({ data: { workspaceId, domain: profile.website } });
      projectCreated = true;
    }
  }
  return { projectCreated };
}

export async function setOnboardingStep(workspaceId: string, step: OnboardingStep): Promise<void> {
  await prisma.workspace.update({ where: { id: workspaceId }, data: { onboardingStep: step } });
}

/** Finish or skip: either way the wizard stops appearing on its own. */
export async function completeOnboarding(workspaceId: string, now: Date = new Date()): Promise<void> {
  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { onboardingCompletedAt: now },
  });
}
