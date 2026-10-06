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
  AppWindow,
  ArrowLeftRight, // Phase 18.1: Switch app
  Columns2, // Phase 18.1: Split view
  BookOpen,
  Bell,
  Building2, // Phase 10 (ops-core): Operations
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
  MessagesSquare,
  Mic,
  Network,
  NotebookPen, // Phase 18.2 (WS=content): Notes
  Gauge, // Phase 18.2 (WS=content): Activity Monitor
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
  /**
   * Phase 18.1 (WS=desk): lowest workspace role that sees the item (the page
   * itself enforces the same role). Absent = every member. The dock overlay
   * (lib/desktop/nav-overlay.ts) keeps gated items gated, pinned or not.
   */
  minRole?: NavRole;
}

/** Workspace roles, lowest first (same ranks as lib/authz ROLE_RANK; kept local so this file stays client-safe). */
export type NavRole = "viewer" | "editor" | "admin" | "owner";
const NAV_ROLE_RANK: Record<NavRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

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
      { href: "/dashboard/crm", label: "CRM", icon: Kanban, description: "Leads, contacts, deals, pipeline", keywords: "contacts companies accounts pipeline kanban leads deals" },
      // Phase 4b: per-lead conversation inbox (SMS + email, inbound + outbound).
      { href: "/dashboard/crm/inbox", label: "Inbox", icon: MessagesSquare, description: "Lead conversations: texts and email", keywords: "conversations messages sms email replies threads unread" },
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
      // Phase 10 (ops-core): the operations apps' home (was tabs inside CRM).
      { href: "/dashboard/ops", label: "Operations", icon: Building2, description: "Orders, invoices, inventory, projects, helpdesk, team", keywords: "ops erp orders payments promotions invoices inventory warehouses purchasing projects tasks timesheets helpdesk tickets team hr leave recruiting workflows" },
      { href: "/dashboard/office", label: "Office", icon: Briefcase, description: "Docs, sheets and decks", keywords: "documents spreadsheets slides" },
      { href: "/dashboard/files", label: "Files", icon: Folder, description: "Workspace files", keywords: "uploads storage" },
      // Phase 18.2 (WS=content): Notes (UniverDoc kind "note"; lib/notes).
      { href: "/dashboard/notes", label: "Notes", icon: NotebookPen, description: "Quick notes, voice notes, notes on any record", keywords: "notes notebook memo jot capture voice meeting notes" },
      { href: "/dashboard/esign", label: "E-sign", icon: PenLine, description: "Signature envelopes", keywords: "signature contracts documenso" },
      { href: "/dashboard/legal", label: "Legal", icon: Scale, description: "Licenses, filings, compliance", keywords: "compliance obligations permits tax" },
      { href: "/dashboard/insurance", label: "Insurance", icon: ShieldCheck, description: "Policies and renewals", keywords: "policies coverage renewals" },
      { href: "/dashboard/funding", label: "Funding", icon: Handshake, description: "Raise, investors, data room", keywords: "vc investors raise data room" },
      { href: "/dashboard/connector", label: "Network", icon: Network, description: "People, companies, intros", keywords: "connector relationships intros contacts" },
      { href: "/dashboard/datasets", label: "Datasets", icon: Database, description: "Business knowledge datasets", keywords: "data ingest knowledge" },
      // Phase 9 (apps): internal mini-apps built from a spec (lib/apps).
      { href: "/dashboard/apps", label: "Apps", icon: AppWindow, description: "Internal mini-apps: lists, forms, boards", keywords: "mini apps internal tools builder forms kanban tracker custom" },
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
      // Phase 18.2 (WS=content): every process in one place (lib/aos/processes.ts).
      { href: "/dashboard/activity", label: "Activity monitor", icon: Gauge, description: "Every run, job and sandbox: cost, time, Stop", keywords: "activity monitor processes jobs queue cron health stop cost task manager" },
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
      // Phase 18.1: the billing page is admin+ (app/dashboard/billing/page.tsx), so is its nav row.
      { href: "/dashboard/billing", label: "Billing", icon: CreditCard, description: "Plan, credits and invoices", keywords: "plan subscription credits payment", minRole: "admin" },
    ],
  },
];

/**
 * Phase 18.1: may a member with `role` see this item? Items without a
 * minRole are for everyone. An unknown role (not signed in to this
 * workspace) only sees the ungated items.
 */
export function navItemVisible(item: Pick<NavItem, "minRole">, role: string | null | undefined): boolean {
  if (!item.minRole) return true;
  const r = NAV_ROLE_RANK[(role ?? "") as NavRole];
  return typeof r === "number" && r >= NAV_ROLE_RANK[item.minRole];
}

/** Phase 18.1: the groups as `role` sees them (gated items removed, empty groups dropped). */
export function visibleNavGroups(role: string | null | undefined, groups: NavGroup[] = NAV_GROUPS): NavGroup[] {
  return groups
    .map((g) => ({ ...g, items: g.items.filter((i) => navItemVisible(i, role)) }))
    .filter((g) => g.items.length > 0);
}

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

/**
 * Phase 18.1 (WS=desk): system destinations that are not sidebar rows — the
 * app switcher and split view. They reach ⌘K through navCommands() (the
 * command bar's extension point), so the palette needs no edit; each href is
 * a real page (lib/nav/__tests__ checks).
 */
export const NAV_SYSTEM_ACTIONS: readonly (NavItem & { hotkey?: string })[] = [
  {
    href: "/dashboard/switch",
    label: "Switch app",
    icon: ArrowLeftRight,
    description: "Jump to a recent app or record (⌃Tab)",
    keywords: "switcher recent recents apps records jump back alt tab ctrl tab",
    hotkey: "⌃ Tab",
  },
  {
    href: "/dashboard/split",
    label: "Split view",
    icon: Columns2,
    description: "Two pages side by side, or a page next to the Assistant",
    keywords: "split side by side two panes assistant compare",
  },
];

/** The ⌘K "Go" section: one command per nav destination, in nav order, then the system actions. */
export function navCommands(
  groups: NavGroup[] = NAV_GROUPS,
  systemActions: readonly (NavItem & { hotkey?: string })[] = NAV_SYSTEM_ACTIONS,
): NavCommand[] {
  return [...navGroupCommands(groups), ...systemActions.map((a) => ({
    id: `go:${a.href}`,
    section: "go" as const,
    title: a.label,
    subtitle: a.description,
    keywords: a.keywords ?? "",
    ...(a.hotkey ? { hotkey: a.hotkey } : {}),
    action: "go" as const,
    href: a.href,
    icon: a.icon,
  }))];
}

function navGroupCommands(groups: NavGroup[]): NavCommand[] {
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
