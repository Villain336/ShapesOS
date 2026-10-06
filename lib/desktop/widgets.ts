// ShapesOS — Phase 18.1 (WS=desk): the desktop widget registry.
//
// Home (/dashboard) is a grid of widgets the member arranges. Every widget is
// one of the cards the Overview already had (lead agent, live work, the
// attention queue, projects, "win this week") or a card over a data source
// that already exists (approvals inbox, agent activity, bookings + calendar
// connectors, the CRM inbox, twin KPIs, the CRM pipeline, the ops overview,
// the Today briefing). Nothing here fetches: this file is the PURE contract
// (client-safe) — the server loaders live in lib/desktop/loaders.server.ts and
// the components in components/desktop/widgets/*, both keyed by these ids, and
// a unit test fails when either side is missing one.

import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bell,
  CalendarDays,
  Gauge,
  Globe,
  Inbox,
  Kanban,
  Lightbulb,
  MessagesSquare,
  Network,
  Newspaper,
  NotebookPen, // Phase 18.2 (WS=content): Notes
  Target,
  Wallet,
  Warehouse,
} from "lucide-react";

export type DeskRole = "viewer" | "editor" | "admin" | "owner";

const ROLE_RANK: Record<DeskRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

/** Same ranks as lib/authz ROLE_RANK, kept local so this file stays client-safe. */
export function deskRoleAtLeast(role: string | null | undefined, min: DeskRole): boolean {
  const r = ROLE_RANK[(role ?? "") as DeskRole];
  return typeof r === "number" && r >= ROLE_RANK[min];
}

export const WIDGET_IDS = [
  "briefing",
  "needs-you",
  "agents",
  "running",
  "work",
  "attention",
  "calendar",
  "inbox",
  "pipeline",
  "cash",
  "twin",
  "key-numbers",
  "projects",
  "suggestions",
  // Phase 18.2 (WS=content)
  "notes",
] as const;

export type WidgetId = (typeof WIDGET_IDS)[number];

export interface WidgetSize {
  /** Columns on the 12-column grid. */
  w: number;
  /** Rows (each GRID_ROW_PX tall). */
  h: number;
}

export interface WidgetDef {
  id: WidgetId;
  /** Sentence case, the card's heading. */
  title: string;
  /** One line for the "Add widget" menu. */
  description: string;
  icon: LucideIcon;
  defaultSize: WidgetSize;
  minSize: WidgetSize;
  maxSize: WidgetSize;
  /** Lowest workspace role that may place (and load) it. */
  minRole: DeskRole;
  /** Where the full app lives ("Open" in the widget header). */
  href: string;
  /** The existing source it reads (documentation + the registry test). */
  source: string;
}

export const GRID_COLS = 12;
/** Height of one grid row in px (widgets span whole rows). */
export const GRID_ROW_PX = 84;
/** The desktop never grows past this many rows (validation bound). */
export const GRID_MAX_ROWS = 64;
/** At most this many widgets on one desktop. */
export const MAX_WIDGETS = 24;

const full = { w: GRID_COLS, h: 10 };

export const WIDGETS: Readonly<Record<WidgetId, WidgetDef>> = Object.freeze({
  briefing: {
    id: "briefing",
    title: "Today",
    description: "Your morning briefing, written by your lead agent",
    icon: Newspaper,
    defaultSize: { w: 6, h: 3 },
    minSize: { w: 4, h: 3 },
    maxSize: { w: 12, h: 8 },
    minRole: "viewer",
    href: "/dashboard",
    source: "desktop_briefings (lib/desktop/briefing.ts)",
  },
  "needs-you": {
    id: "needs-you",
    title: "Needs you",
    description: "Approvals and questions waiting on you",
    icon: Inbox,
    defaultSize: { w: 6, h: 3 },
    minSize: { w: 3, h: 3 },
    maxSize: { w: 12, h: 8 },
    minRole: "viewer",
    href: "/dashboard/approvals",
    source: "lib/approvals/inbox.ts loadInbox",
  },
  agents: {
    id: "agents",
    title: "Your agents",
    description: "The lead agent and its sub-agents, with live activity",
    icon: Network,
    defaultSize: { w: 8, h: 5 },
    minSize: { w: 6, h: 4 },
    maxSize: full,
    minRole: "viewer",
    href: "/dashboard/runs",
    source: "lib/aos/activity.server.ts safeAgentActivity",
  },
  running: {
    id: "running",
    title: "Running now",
    description: "Every agent that is working, waiting or stopped",
    icon: Activity,
    defaultSize: { w: 4, h: 5 },
    minSize: { w: 3, h: 3 },
    maxSize: { w: 6, h: 8 },
    minRole: "viewer",
    href: "/dashboard/runs",
    source: "lib/aos/activity.server.ts safeAgentActivity",
  },
  work: {
    id: "work",
    title: "Missions and schedules",
    description: "Work in flight, the most urgent first",
    icon: Target,
    defaultSize: { w: 12, h: 4 },
    minSize: { w: 4, h: 3 },
    maxSize: full,
    minRole: "viewer",
    href: "/dashboard/missions",
    source: "lib/aos/activity.server.ts safeAgentActivity (missions + schedules)",
  },
  attention: {
    id: "attention",
    title: "Needs your attention",
    description: "Drafts to review, pages losing traffic, competitor moves, alerts",
    icon: Bell,
    defaultSize: { w: 8, h: 4 },
    minSize: { w: 4, h: 3 },
    maxSize: full,
    minRole: "viewer",
    href: "/dashboard/alerts",
    source: "autopilot items, content decay, competitor radar, alert events",
  },
  calendar: {
    id: "calendar",
    title: "Today's calendar",
    description: "Bookings and connected calendar events for today",
    icon: CalendarDays,
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 3 },
    maxSize: { w: 6, h: 8 },
    minRole: "viewer",
    href: "/dashboard/calls",
    source: "booking + Google/Outlook calendar connector reads",
  },
  inbox: {
    id: "inbox",
    title: "Inbox",
    description: "Unread lead conversations (texts and email)",
    icon: MessagesSquare,
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 3 },
    maxSize: { w: 6, h: 8 },
    minRole: "viewer",
    href: "/dashboard/crm/inbox",
    source: "lib/crm/inbox.ts listThreads",
  },
  pipeline: {
    id: "pipeline",
    title: "Pipeline",
    description: "Open leads and their value by stage",
    icon: Kanban,
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 3 },
    maxSize: { w: 8, h: 6 },
    minRole: "viewer",
    href: "/dashboard/crm",
    source: "crm_leads grouped by stage (lib/crm/stages.ts)",
  },
  cash: {
    id: "cash",
    title: "Cash",
    description: "Payments in the last 30 days and invoices still open",
    icon: Wallet,
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 3 },
    maxSize: { w: 6, h: 6 },
    minRole: "viewer",
    href: "/dashboard/ops/payments",
    source: "lib/ops/overview.ts getOpsOverview",
  },
  twin: {
    id: "twin",
    title: "Twin",
    description: "Live numbers from your warehouse, factory or store twin",
    icon: Warehouse,
    defaultSize: { w: 6, h: 3 },
    minSize: { w: 4, h: 3 },
    maxSize: full,
    minRole: "viewer",
    href: "/dashboard/ops/twin",
    source: "lib/twin/state.ts siteSnapshot KPIs",
  },
  "key-numbers": {
    id: "key-numbers",
    title: "Key numbers",
    description: "Projects, keywords, content and visibility at a glance",
    icon: Gauge,
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 2 },
    maxSize: { w: 12, h: 4 },
    minRole: "viewer",
    href: "/dashboard/projects",
    source: "projects + visibility_scores (the Overview's KPIs)",
  },
  projects: {
    id: "projects",
    title: "Projects",
    description: "Your SEO projects, with a form to add one",
    icon: Globe,
    defaultSize: { w: 8, h: 4 },
    minSize: { w: 4, h: 4 },
    maxSize: full,
    minRole: "viewer",
    href: "/dashboard/projects",
    source: "projects (the Overview's project list)",
  },
  suggestions: {
    id: "suggestions",
    title: "Win this week",
    description: "The shortest path to more traffic",
    icon: Lightbulb,
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 3, h: 3 },
    maxSize: { w: 6, h: 8 },
    minRole: "viewer",
    href: "/dashboard/projects",
    source: "the Overview's suggestions",
  },
  // Phase 18.2 (WS=content): pinned and recent notes + a quick note.
  notes: {
    id: "notes",
    title: "Notes",
    description: "Pinned and recent notes, and a quick note",
    icon: NotebookPen,
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 3 },
    maxSize: { w: 6, h: 8 },
    minRole: "viewer",
    href: "/dashboard/notes",
    source: "univer_docs kind note (lib/notes/service.ts listNotes)",
  },
});

export function isWidgetId(v: unknown): v is WidgetId {
  return typeof v === "string" && (WIDGET_IDS as readonly string[]).includes(v);
}

/** Widgets this role may place, in registry order. */
export function widgetsForRole(role: string | null | undefined): WidgetDef[] {
  return WIDGET_IDS.map((id) => WIDGETS[id]).filter((w) => deskRoleAtLeast(role, w.minRole));
}
