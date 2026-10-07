// ShapesOS — settings information architecture (Phase 3, workstream I).
// Phase 18.1 (WS=find): a "You" group first — the person's own preferences
// (General, Appearance, Language and region, Accessibility, Notifications)
// plus "Your security" and "Your account", regrouped here from Members and
// access. The other six groups are the workspace's settings, unchanged.
// Phase 18.3 (WS=trust): System Settings in two halves (SettingsGroup.half):
// "You" (the person's own preferences — adds Keyboard and Privacy) and the
// Workspace (every existing workspace page, regrouped; adds the "Privacy and
// security" group for the Privacy & Security center, with Security and the
// Audit log moved into it from Members and access). Every page keeps its URL.
// The settings pages grouped into sections. One source for the grouped
// tab strip (SettingsNav) and the /dashboard/settings index, so the two can't
// drift. Billing lives at /dashboard/billing but is part of "Billing and
// usage" here, so it's reachable from every settings page.

import {
  BookOpen,
  Webhook,
  Bell,
  Bot,
  Brain,
  BrainCog,
  Briefcase,
  Building2,
  Cloud,
  CreditCard,
  Fingerprint,
  FlaskConical,
  Gauge,
  Globe,
  KeyRound,
  Lock,
  Mail,
  Palette,
  PenLine,
  Plug,
  Scale,
  ScrollText,
  Shield,
  SlidersHorizontal,
  Siren,
  Terminal,
  UserRound,
  Users,
  Wrench,
  type LucideIcon,
  Shapes,
  Accessibility,
  Languages,
  SunMoon,
  BellRing,
  // Phase 18.3 (WS=trust)
  Keyboard,
  EyeOff,
  ShieldCheck,
  AppWindow,
  FileSearch,
  BrainCircuit,
  MousePointer2, // Phase 19A (WS=server): Settings → You → Cursor
} from "lucide-react";

export interface SettingsPage {
  href: string;
  label: string;
  description: string;
  icon: LucideIcon;
}

/** Phase 18.3: which half of System Settings a group sits in. */
export type SettingsHalf = "you" | "workspace";

export interface SettingsGroup {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Phase 18.3: "you" (personal) or "workspace". */
  half: SettingsHalf;
  pages: SettingsPage[];
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    id: "you",
    label: "You",
    icon: UserRound,
    half: "you",
    pages: [
      { href: "/dashboard/settings/you", label: "General", description: "Your name, time zone and how ShapesOS starts.", icon: UserRound },
      { href: "/dashboard/settings/you/appearance", label: "Appearance", description: "Light or dark, contrast, text size and density.", icon: SunMoon },
      // Phase 18.3: the order of the plan's "You" half.
      { href: "/dashboard/settings/you/notifications", label: "Notifications", description: "Which notifications reach you, and where.", icon: BellRing },
      { href: "/dashboard/settings/you/keyboard", label: "Keyboard", description: "Every shortcut, and the keys you changed.", icon: Keyboard },
      { href: "/dashboard/settings/you/accessibility", label: "Accessibility", description: "Motion, contrast, text size and focus.", icon: Accessibility },
      { href: "/dashboard/settings/you/language", label: "Language and region", description: "Language, time zone and clock.", icon: Languages },
      { href: "/dashboard/settings/you/privacy", label: "Privacy", description: "Where you're signed in, what agents read for you, and what they remember.", icon: EyeOff },
      // Phase 19A (WS=server): the voice cursor (ShapesOS Desktop).
      { href: "/dashboard/settings/you/cursor", label: "Cursor", description: "The voice cursor in ShapesOS Desktop: its voice, talk minutes and the download.", icon: MousePointer2 },
      { href: "/dashboard/settings/account-security", label: "Your security", description: "Two-factor sign-in and passkeys for your own account.", icon: Fingerprint },
      { href: "/dashboard/settings/account", label: "Your account", description: "Download your data or delete your account.", icon: UserRound },
    ],
  },
  {
    id: "workspace",
    label: "Workspace",
    icon: Building2,
    half: "workspace",
    pages: [
      { href: "/dashboard/settings/workspace", label: "General", description: "Name, plan, setup, and creating or deleting workspaces.", icon: Building2 },
      { href: "/dashboard/settings/defaults", label: "Defaults", description: "The baseline every project inherits: model, locale, tone.", icon: SlidersHorizontal },
      { href: "/dashboard/settings/automation", label: "Automation", description: "What agents may do on their own, what asks first, and what never runs.", icon: Bot },
      { href: "/dashboard/settings/governance", label: "Governance", description: "Retention and sharing defaults, inherited by every project.", icon: Scale },
      { href: "/dashboard/settings/notifications", label: "Notifications", description: "Workspace-wide notification defaults.", icon: Bell },
      { href: "/dashboard/settings/alerts", label: "Alert rules", description: "Rules that watch for rank drops, AI Overview changes, and run completions.", icon: Siren },
    ],
  },
  {
    id: "access",
    label: "Members and access",
    icon: Users,
    half: "workspace",
    pages: [
      { href: "/dashboard/settings/members", label: "Members", description: "Invite teammates and control what they can do.", icon: Users },
      { href: "/dashboard/settings/clients", label: "Clients", description: "Agency clients: who sees their reports, and how often.", icon: Briefcase },
    ],
  },
  // Phase 18.3 (WS=trust): the Privacy & Security center (admins), with the
  // workspace's sign-in policy and the Audit log moved here (same URLs).
  {
    id: "privacy",
    label: "Privacy and security",
    icon: ShieldCheck,
    half: "workspace",
    pages: [
      { href: "/dashboard/settings/security-center", label: "Security center", description: "One timeline of everything people and agents did, across every audit trail.", icon: ShieldCheck },
      { href: "/dashboard/settings/security-center/apps", label: "Agent app access", description: "Which apps agents may use in this workspace.", icon: AppWindow },
      { href: "/dashboard/settings/security-center/data-access", label: "Data access log", description: "Which agent read which app's data, and when.", icon: FileSearch },
      { href: "/dashboard/settings/security-center/memory", label: "Memory controls", description: "See and forget what agents remember about this workspace.", icon: BrainCircuit },
      { href: "/dashboard/settings/security", label: "Security", description: "Workspace sign-in policy, SCIM provisioning, SSO, and secret storage.", icon: Lock },
      { href: "/dashboard/settings/audit", label: "Audit log", description: "Every consequential action, who did it, and when.", icon: ScrollText },
    ],
  },
  {
    id: "billing",
    label: "Billing and usage",
    icon: CreditCard,
    half: "workspace",
    pages: [
      { href: "/dashboard/billing", label: "Billing", description: "Your plan, subscription, and invoices.", icon: CreditCard },
      { href: "/dashboard/settings/usage", label: "Usage", description: "Credit usage this period, by action and by project.", icon: Gauge },
    ],
  },
  {
    id: "integrations",
    label: "Integrations",
    icon: Plug,
    half: "workspace",
    pages: [
      { href: "/dashboard/settings/connectors", label: "Connectors", description: "Connect data sources once; credentials live in the vault.", icon: Plug },
      { href: "/dashboard/settings/providers", label: "Providers", description: "Which external providers ShapesOS is using.", icon: Cloud },
      { href: "/dashboard/settings/skills", label: "Skills", description: "Install skills that teach agents how your team works.", icon: Wrench },
      { href: "/dashboard/settings/mail", label: "Direct mail", description: "Senders, postage, and mail defaults.", icon: Mail },
      { href: "/dashboard/settings/signing", label: "Signing", description: "Document signing requests and status.", icon: PenLine },
      { href: "/dashboard/settings/media", label: "Media safety", description: "Spend guardrails, approvals, and kill switches.", icon: Shield },
    ],
  },
  {
    id: "brand",
    label: "Brand",
    icon: Palette,
    half: "workspace",
    pages: [
      { href: "/dashboard/settings/brand-kits", label: "Brand kits", description: "Identity for client reports: logo, colors, fonts, tone.", icon: Palette },
      { href: "/dashboard/settings/brand/intelligence", label: "Intelligence", description: "Brand voice, company knowledge, style rules, and content.", icon: BrainCog },
      { href: "/dashboard/settings/agents", label: "Agent memory", description: "What agents have learned: lessons, preferences, personas.", icon: Brain },
      { href: "/dashboard/settings/white-label", label: "White-label", description: "Client-facing identity for public pages: logo, custom domain, color.", icon: Globe },
    ],
  },
  {
    id: "developer",
    label: "Developer",
    icon: Terminal,
    half: "workspace",
    pages: [
      { href: "/dashboard/settings/api-mcp", label: "API and MCP", description: "Expose this workspace to MCP clients with scoped keys.", icon: KeyRound },
      // Phase 4a: API reference (OpenAPI) + outbound webhooks.
      { href: "/dashboard/settings/developers", label: "API reference", description: "The public API and webhook events, from the OpenAPI spec.", icon: BookOpen },
      { href: "/dashboard/settings/webhooks", label: "Webhooks", description: "Signed events to your own endpoints, with a delivery log.", icon: Webhook },
      { href: "/dashboard/settings/experiments", label: "Experiments", description: "Feature flags and growth experiments.", icon: FlaskConical },
      // Phase 4d: the Agentic OS kit rendered from components/aos, every state.
      { href: "/dashboard/settings/design", label: "Design kit", description: "Every Agentic OS component in every state, next to the kit renders.", icon: Shapes },
    ],
  },
];

function matches(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The group and page a pathname belongs to (longest match wins). */
export function settingsLocation(pathname: string): { group: SettingsGroup; page: SettingsPage | null } {
  let best: { group: SettingsGroup; page: SettingsPage } | null = null;
  for (const group of SETTINGS_GROUPS) {
    for (const page of group.pages) {
      if (matches(pathname, page.href) && (!best || page.href.length > best.page.href.length)) {
        best = { group, page };
      }
    }
  }
  return best ?? { group: SETTINGS_GROUPS[0]!, page: null };
}

/** Phase 18.3: the groups of one half, in order. */
export function settingsHalf(half: SettingsHalf): SettingsGroup[] {
  return SETTINGS_GROUPS.filter((g) => g.half === half);
}

/** Phase 18.3: every settings page with its group, in nav order. */
export function allSettingsPages(): Array<SettingsPage & { groupId: string }> {
  return SETTINGS_GROUPS.flatMap((g) => g.pages.map((p) => ({ ...p, groupId: g.id })));
}

/** Normalise text for settings search: lower case, accents off. */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * Phase 18.3: settings search. Pages whose (translated) label, description
 * or group label contain every word of the query, label matches first.
 * PURE — `text` supplies the strings in the person's language.
 */
export function searchSettings(
  query: string,
  text: (page: SettingsPage, groupId: string) => { label: string; description: string; group: string },
): Array<SettingsPage & { groupId: string }> {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const scored: Array<{ page: SettingsPage & { groupId: string }; score: number; order: number }> = [];
  allSettingsPages().forEach((page, order) => {
    const t = text(page, page.groupId);
    const label = fold(t.label);
    const hay = `${label} ${fold(t.description)} ${fold(t.group)}`;
    if (!words.every((w) => hay.includes(w))) return;
    const score = words.every((w) => label.includes(w)) ? (label.startsWith(words[0]!) ? 0 : 1) : 2;
    scored.push({ page, score, order });
  });
  return scored.sort((a, b) => a.score - b.score || a.order - b.order).map((s) => s.page);
}
