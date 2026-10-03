// ShapesOS — settings information architecture (Phase 3, workstream I).
// The settings pages grouped into six sections. One source for the grouped
// tab strip (SettingsNav) and the /dashboard/settings index, so the two can't
// drift. Billing lives at /dashboard/billing but is part of "Billing and
// usage" here, so it's reachable from every settings page.

import {
  Bell,
  Bot,
  Brain,
  BrainCog,
  Briefcase,
  Building2,
  Cloud,
  CreditCard,
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
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export interface SettingsPage {
  href: string;
  label: string;
  description: string;
  icon: LucideIcon;
}

export interface SettingsGroup {
  id: string;
  label: string;
  icon: LucideIcon;
  pages: SettingsPage[];
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    id: "workspace",
    label: "Workspace",
    icon: Building2,
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
    pages: [
      { href: "/dashboard/settings/members", label: "Members", description: "Invite teammates and control what they can do.", icon: Users },
      { href: "/dashboard/settings/clients", label: "Clients", description: "Agency clients: who sees their reports, and how often.", icon: Briefcase },
      { href: "/dashboard/settings/security", label: "Security", description: "Authentication, SSO, and secret-storage posture.", icon: Lock },
      { href: "/dashboard/settings/audit", label: "Audit log", description: "Every consequential action, who did it, and when.", icon: ScrollText },
    ],
  },
  {
    id: "billing",
    label: "Billing and usage",
    icon: CreditCard,
    pages: [
      { href: "/dashboard/billing", label: "Billing", description: "Your plan, subscription, and invoices.", icon: CreditCard },
      { href: "/dashboard/settings/usage", label: "Usage", description: "Credit usage this period, by action and by project.", icon: Gauge },
    ],
  },
  {
    id: "integrations",
    label: "Integrations",
    icon: Plug,
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
    pages: [
      { href: "/dashboard/settings/api-mcp", label: "API and MCP", description: "Expose this workspace to MCP clients with scoped keys.", icon: KeyRound },
      { href: "/dashboard/settings/experiments", label: "Experiments", description: "Feature flags and growth experiments.", icon: FlaskConical },
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
