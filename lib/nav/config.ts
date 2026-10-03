// ShapesOS — single source of truth for dashboard navigation.
//
// The sidebar (components/AppSidebar.tsx) and the ⌘K "Go" section
// (components/command-bar/CommandBar.tsx) both read this list, so a page is
// either reachable from both or from neither. lib/nav/__tests__ checks that
// every href resolves to a real app/ page and that the command bar covers
// every destination.
//
// Groups follow the product's mental model (REMEDIATION-PLAN Phase 3):
// Grow (get and keep customers) · Design (make things) · Operate (run the
// business) · Agents (what the agents are doing and what needs you), plus
// the account rows (Settings, Billing) pinned to the bottom.

import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Bell,
  Box,
  Briefcase,
  ChartColumn,
  ChartLine,
  ChartSpline,
  CreditCard,
  Database,
  Folder,
  Globe,
  Handshake,
  History,
  Home,
  Inbox,
  Kanban,
  LayoutDashboard,
  Mail,
  Megaphone,
  MessageSquare,
  Mic,
  Network,
  Paintbrush,
  PenLine,
  Phone,
  Radar,
  RefreshCw,
  Brain,
  Scale,
  Scissors,
  Search,
  Send,
  Settings,
  Share2,
  ShieldCheck,
  Star,
  Target,
  UserSearch,
  Zap,
} from "lucide-react";

export type NavGroupId = "home" | "grow" | "design" | "operate" | "agents" | "account";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Extra search words for ⌘K (synonyms, old names). */
  keywords?: string;
  /** One-line description shown as the ⌘K subtitle. */
  description: string;
  /**
   * Path prefix that marks this item current, when it differs from href
   * (e.g. Intelligence opens on Radar but owns all of /dashboard/intelligence).
   */
  activePrefix?: string;
  /** Slot for a live count pill rendered next to the label. */
  badge?: "needs-you";
}

export interface NavGroup {
  id: NavGroupId;
  /** Sentence-case group label; the home and account groups have none. */
  title?: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "home",
    items: [
      { href: "/dashboard", label: "Overview", icon: LayoutDashboard, description: "Home: what needs attention", keywords: "home dashboard main" },
    ],
  },
  {
    id: "grow",
    title: "Grow",
    items: [
      { href: "/dashboard/crm", label: "CRM", icon: Kanban, description: "Leads, pipeline, invoices", keywords: "contacts pipeline kanban leads deals" },
      { href: "/dashboard/prospects", label: "Prospects", icon: UserSearch, description: "Prospect lists and enrichment", keywords: "prospecting enrichment lists outbound" },
      { href: "/dashboard/nurture", label: "Nurture", icon: Send, description: "Nurture sequences and broadcasts", keywords: "sequences drip email sms broadcasts" },
      { href: "/dashboard/projects", label: "SEO projects", icon: Search, description: "Sites, keywords, rankings, content", keywords: "seo keywords rankings content sites projects" },
      { href: "/dashboard/intelligence/radar", label: "Intelligence", icon: Radar, description: "Market radar, competitors, AI visibility", activePrefix: "/dashboard/intelligence", keywords: "radar competitors ai visibility rank corpus knowledge" },
      { href: "/dashboard/social", label: "Social", icon: Share2, description: "Social publishing", keywords: "posts postiz publish" },
      { href: "/dashboard/reviews", label: "Reviews", icon: Star, description: "Review requests and replies", keywords: "ratings reputation" },
      { href: "/dashboard/authority", label: "Authority", icon: Globe, description: "Outreach, PR, listings, AEO", keywords: "outreach pr listings aeo backlinks" },
      { href: "/dashboard/media", label: "Media", icon: Megaphone, description: "Media buying and spend pools", keywords: "ads advertising spend dooh radio" },
      { href: "/dashboard/mail", label: "Direct mail", icon: Mail, description: "Postcards and EDDM", keywords: "postcards eddm letters" },
      { href: "/dashboard/flywheel", label: "Flywheel", icon: RefreshCw, description: "Reallocation, recycling, test lab", keywords: "reallocation recycling ctv dsp tests" },
      { href: "/dashboard/calls", label: "Calls", icon: Phone, description: "Call tracking and bookings", keywords: "phone tracking numbers bookings" },
      { href: "/dashboard/attribution", label: "Attribution", icon: ChartSpline, description: "What drove revenue", keywords: "roi spend channels" },
      { href: "/dashboard/analytics", label: "Analytics", icon: ChartLine, description: "Traffic, social and revenue", keywords: "pageviews umami traffic ga4 search console engagement overview" },
      { href: "/dashboard/reports", label: "Reports", icon: ChartColumn, description: "Reports and exports", keywords: "analytics report pdf" },
    ],
  },
  {
    id: "design",
    title: "Design",
    items: [
      { href: "/dashboard/studio", label: "Studio", icon: Paintbrush, description: "Creative studio", keywords: "creative design ads pages" },
      { href: "/dashboard/clips", label: "Clips", icon: Scissors, description: "Long videos into short clips", keywords: "video clipper shorts" },
      { href: "/dashboard/voice", label: "Voice", icon: Mic, description: "Voice agents, scripts, voiceovers", keywords: "voice agents tts voiceover scripts consent" },
      { href: "/dashboard/cad", label: "CAD", icon: Box, description: "CAD models and hardware projects", keywords: "hardware 3d models prototypes" },
    ],
  },
  {
    id: "operate",
    title: "Operate",
    items: [
      { href: "/dashboard/office", label: "Office", icon: Briefcase, description: "Docs, sheets and decks", keywords: "documents spreadsheets slides" },
      { href: "/dashboard/files", label: "Files", icon: Folder, description: "Workspace files", keywords: "uploads storage" },
      { href: "/dashboard/esign", label: "E-sign", icon: PenLine, description: "Signature envelopes", keywords: "signature contracts documenso" },
      { href: "/dashboard/legal", label: "Legal", icon: Scale, description: "Licenses, filings, compliance", keywords: "compliance obligations permits tax" },
      { href: "/dashboard/insurance", label: "Insurance", icon: ShieldCheck, description: "Policies and renewals", keywords: "policies coverage renewals" },
      { href: "/dashboard/funding", label: "Funding", icon: Handshake, description: "Raise, investors, data room", keywords: "vc investors raise data room" },
      { href: "/dashboard/connector", label: "Network", icon: Network, description: "People, companies, intros", keywords: "connector relationships intros contacts" },
      { href: "/dashboard/datasets", label: "Datasets", icon: Database, description: "Business knowledge datasets", keywords: "data ingest knowledge" },
      { href: "/dashboard/wfh", label: "WFH mode", icon: Home, description: "Remote-work mode", keywords: "remote standups focus rituals expenses" },
      { href: "/dashboard/alerts", label: "Alerts", icon: Bell, description: "Alert history", keywords: "notifications incidents" },
    ],
  },
  {
    id: "agents",
    title: "Agents",
    items: [
      { href: "/dashboard/approvals", label: "Approvals", icon: Inbox, description: "Everything that needs you", keywords: "needs you inbox review approve", badge: "needs-you" },
      { href: "/dashboard/runs", label: "Runs", icon: History, description: "Agent runs and replays", keywords: "replays history executions" },
      { href: "/dashboard/assistant", label: "Assistant", icon: MessageSquare, description: "Chat with your agents", keywords: "chat ai help" },
      { href: "/dashboard/missions", label: "Missions", icon: Target, description: "Goals the agents are working on", keywords: "goals growth strategy" },
      { href: "/dashboard/playbooks", label: "Playbooks", icon: BookOpen, description: "Agent playbooks", keywords: "procedures steps" },
      { href: "/dashboard/actions", label: "Actions", icon: Zap, description: "Connected app actions", keywords: "composio tools connections" },
      { href: "/dashboard/substrate", label: "Substrate", icon: Brain, description: "Business graph and growth memory", keywords: "graph memory campaigns" },
    ],
  },
  {
    id: "account",
    items: [
      { href: "/dashboard/settings", label: "Settings", icon: Settings, description: "Workspace settings", keywords: "config preferences members connectors" },
      { href: "/dashboard/billing", label: "Billing", icon: CreditCard, description: "Plan, credits and invoices", keywords: "plan subscription credits payment" },
    ],
  },
];

/** Every nav item in display order. */
export function allNavItems(groups: NavGroup[] = NAV_GROUPS): NavItem[] {
  return groups.flatMap((g) => g.items);
}

function prefixOf(item: NavItem): string {
  return item.activePrefix ?? item.href;
}

/** True when `pathname` is `prefix` or a path below it (segment boundary). */
export function pathMatches(pathname: string, prefix: string): boolean {
  if (pathname === prefix) return true;
  return pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

/**
 * The href of the nav item that owns `pathname`: the longest matching prefix,
 * so /dashboard/settings/members highlights Settings and not Overview, and
 * /dashboard/mail never lights up /dashboard/media. Overview only matches
 * /dashboard exactly.
 */
export function activeNavHref(pathname: string, groups: NavGroup[] = NAV_GROUPS): string | null {
  let best: NavItem | null = null;
  for (const item of allNavItems(groups)) {
    const prefix = prefixOf(item);
    const hit = prefix === "/dashboard" ? pathname === prefix : pathMatches(pathname, prefix);
    if (hit && (!best || prefix.length > prefixOf(best).length)) best = item;
  }
  return best?.href ?? null;
}

/** ⌥-number shortcuts kept from the original ⌘K Go list. */
export const NAV_HOTKEYS: Record<string, string> = {
  "/dashboard": "⌥1",
  "/dashboard/studio": "⌥2",
  "/dashboard/crm": "⌥3",
  "/dashboard/reports": "⌥4",
  "/dashboard/assistant": "⌥5",
  "/dashboard/settings": "⌥6",
};

export interface NavCommand {
  id: string;
  section: "go";
  title: string;
  subtitle: string;
  keywords: string;
  hotkey?: string;
  action: "go";
  href: string;
  icon: LucideIcon;
}

/** The ⌘K "Go" section: one command per nav destination, in nav order. */
export function navCommands(groups: NavGroup[] = NAV_GROUPS): NavCommand[] {
  return groups.flatMap((g) =>
    g.items.map((item) => ({
      id: `go:${item.href}`,
      section: "go" as const,
      title: item.label,
      subtitle: g.title ? `${g.title} · ${item.description}` : item.description,
      keywords: [g.title ?? "", item.keywords ?? ""].join(" ").trim(),
      ...(NAV_HOTKEYS[item.href] ? { hotkey: NAV_HOTKEYS[item.href] } : {}),
      action: "go" as const,
      href: item.href,
      icon: item.icon,
    })),
  );
}
