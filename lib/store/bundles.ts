// ShapesOS Phase 24 - Store bundles (PURE): a curated group of existing
// catalogue items ("one install bundles connector + skill + templates").
//
// A bundle is a SHORTCUT, never a bypass. It adds no install path of its own:
//   - each member installs through installStoreItem (its kind's own role /
//     permission check, its own audit row) - see bundles-service.ts
//   - connectors and MCP servers are never installed here: they need the
//     person's own account, key or OAuth consent, so a bundle can only point
//     at Settings -> Connectors
//   - nothing in a bundle can spend, mint a credential, or make an action
//     auto-approvable; approvals still apply at run time
//   - the person picks the members; unselected members are never touched

import type { StoreItem, StoreKind } from "./catalogue";
import { maxTier } from "./catalogue";
import { getRegistryPack } from "@/lib/skills/registry";
import { MISSION_TEMPLATES } from "@/lib/missions/templates";

export interface BundleMember {
  kind: StoreKind;
  key: string;
  /** Why this member is in the bundle (shown to the person). */
  why: string;
}

export interface StoreBundle {
  key: string;
  name: string;
  description: string;
  members: BundleMember[];
}

export const BUNDLES: readonly StoreBundle[] = [
  {
    key: "seo-growth",
    name: "SEO growth kit",
    description: "Audit a site, brief content, and track rankings and competitors, with the search data sources they read from.",
    members: [
      { kind: "skill", key: "seo-audit", why: "Site audit workflow" },
      { kind: "skill", key: "content-brief", why: "SERP-informed content briefs" },
      { kind: "skill", key: "rank-report", why: "Ranking reports" },
      { kind: "skill", key: "competitor-watch", why: "Competitor gap analysis" },
      { kind: "connector", key: "google-search-console", why: "First-party search data (connect separately)" },
      { kind: "connector", key: "dataforseo", why: "SERP and keyword data the skills call (connect separately)" },
    ],
  },
  {
    key: "local-visibility",
    name: "Local visibility",
    description: "Mission templates for Google Business visibility and review growth, plus the profile connector they read.",
    members: [
      { kind: "mission_template", key: "local-services.gbp-visibility", why: "Google Business visibility mission" },
      { kind: "mission_template", key: "home-services.review-velocity", why: "Review velocity mission" },
      { kind: "skill", key: "rank-report", why: "Ranking reports" },
      { kind: "connector", key: "google-business-profile", why: "Your Business Profile (connect separately)" },
    ],
  },
];

export function getBundle(key: string): StoreBundle | undefined {
  return BUNDLES.find((b) => b.key === key);
}

/** Every member must point at a real registry entry (asserted in tests). */
export function memberExistsInRegistry(m: BundleMember, connectorKeys: readonly string[]): boolean {
  if (m.kind === "skill") return !!getRegistryPack(m.key);
  if (m.kind === "mission_template") return MISSION_TEMPLATES.some((t) => t.id === m.key);
  if (m.kind === "connector") return connectorKeys.includes(m.key);
  return false;
}

export type MemberAction =
  /** Can be installed by this person right now (the kind's own check still runs at install). */
  | "installable"
  | "already_installed"
  /** Needs the person's own account/key: never installed by a bundle. */
  | "connect_separately"
  /** This person's role/permission doesn't allow it. */
  | "blocked"
  /** Not in the catalogue right now. */
  | "unavailable";

export interface MemberPlan {
  kind: StoreKind;
  key: string;
  why: string;
  name: string;
  action: MemberAction;
  reason?: string;
  href?: string;
  /** Highest approval tier among the member's tools (null = none listed). */
  maxTier: number | null;
  /** What it needs (scopes, keys, records, budget), straight from the catalogue. */
  needs: string[];
}

export interface BundlePlan {
  key: string;
  name: string;
  description: string;
  members: MemberPlan[];
}

const ROLE_RANK: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

export function planBundle(
  bundle: StoreBundle,
  items: readonly StoreItem[],
  who: { role: string; canInstallSkills: boolean },
): BundlePlan {
  const members = bundle.members.map((m): MemberPlan => {
    const item = items.find((i) => i.kind === m.kind && i.key === m.key);
    if (!item) {
      return { kind: m.kind, key: m.key, why: m.why, name: m.key, action: "unavailable", reason: "Not available right now.", maxTier: null, needs: [] };
    }
    const base = {
      kind: m.kind,
      key: m.key,
      why: m.why,
      name: item.name,
      maxTier: maxTier(item),
      needs: item.permissions.map((p) => `${p.kind}: ${p.detail}`),
    };
    if (item.install.mode === "link") {
      return { ...base, action: "connect_separately", href: item.install.href, reason: "Needs your own account or key. Connect it in Settings." };
    }
    if (item.installed) return { ...base, action: "already_installed" };
    if (item.install.permission === "skills.install" && !who.canInstallSkills) {
      return { ...base, action: "blocked", reason: "Needs an admin or the skills.install permission." };
    }
    if ((ROLE_RANK[who.role] ?? 0) < ROLE_RANK[item.install.minRole]) {
      return { ...base, action: "blocked", reason: `Needs the ${item.install.minRole} role.` };
    }
    return { ...base, action: "installable" };
  });
  return { key: bundle.key, name: bundle.name, description: bundle.description, members };
}

export const memberId = (m: { kind: string; key: string }) => `${m.kind}:${m.key}`;
