// ShapesOS — Phase 18.1 (WS=desk): server data loaders for the desktop widgets.
//
// One loader per widget id (lib/desktop/widgets.ts), each a thin read over a
// source that already exists — no second implementation of any of them:
//   needs-you   lib/approvals/inbox.ts (loadInbox, the Needs you inbox)
//   agents,
//   running,
//   work        lib/aos/activity.server.ts (safeAgentActivity, request-cached)
//   attention   the Overview's attention queue (autopilot, decay, radar, alerts)
//   calendar    booking rows + the Google / Outlook calendar connectors' read
//               tool (list_events) — labelled empty state when not connected
//   inbox       lib/crm/inbox.ts listThreads (unread conversations)
//   pipeline    crm_leads by stage (lib/crm/stages.ts labels)
//   cash        lib/ops/overview.ts getOpsOverview
//   twin        lib/twin/state.ts listSites + siteSnapshotFor KPIs
//   key-numbers,
//   projects,
//   suggestions the Overview's project stats (request-cached)
//   briefing    desktop_briefings (lib/desktop/briefing.server.ts)
// Loaders never throw: a source that fails renders as that widget's
// "couldn't load" state, never as a broken Home.

import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { providerStatus } from "@/lib/providers";
import { safeAgentActivity, type ScheduleWork } from "@/lib/aos/activity.server";
import type { AgentNode, AgentTree, MissionView } from "@/lib/aos/agents";
import { SUB_AGENTS } from "@/lib/aos/agents";
import { byStatusThenRecent, type AosStatus } from "@/lib/aos/status";
import { stepCounter } from "@/lib/aos/run-steps";
import { loadInbox, resolveInboxViewer } from "@/lib/approvals/inbox";
import { INBOX_SOURCE_LABELS } from "@/lib/approvals/types";
import { DEFAULT_TIME_ZONE, resolveTimeZone, startOfZonedDay } from "@/lib/time/zoned";
import { CLOSED_STAGES, DEFAULT_STAGES, parseStages } from "@/lib/crm/stages";
import type { TwinKpi } from "@/lib/twin/types";
import type { WidgetId } from "./widgets";

export interface LoaderContext {
  workspaceId: string;
  userId: string;
  role: string;
  now: Date;
  /** The member's IANA time zone (WS=find's preference; UTC until known). */
  timeZone: string;
  workspaceName: string;
}

export type LoadResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function safe<T>(label: string, fn: () => Promise<T>): Promise<LoadResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    console.warn(`[desktop] ${label} widget did not load:`, err instanceof Error ? err.message : err);
    return { ok: false, error: `${label} could not load right now.` };
  }
}

const relFmt = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
export function timeAgo(d: Date, now = new Date()): string {
  const sec = Math.round((d.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(sec);
  if (abs < 60) return relFmt.format(sec, "second");
  if (abs < 3600) return relFmt.format(Math.round(sec / 60), "minute");
  if (abs < 86400) return relFmt.format(Math.round(sec / 3600), "hour");
  return relFmt.format(Math.round(sec / 86400), "day");
}

// ---------------------------------------------------------------------------
// Needs you
// ---------------------------------------------------------------------------

export interface NeedsYouData {
  actionable: number;
  total: number;
  items: { key: string; title: string; source: string; href: string; ago: string; canDecide: boolean }[];
}

async function loadNeedsYou(ctx: LoaderContext): Promise<NeedsYouData> {
  const viewer = await resolveInboxViewer(ctx.userId, ctx.workspaceId);
  if (!viewer) return { actionable: 0, total: 0, items: [] };
  const inbox = await loadInbox(viewer, { limitPerSource: 10 });
  return {
    actionable: inbox.actionable,
    total: inbox.items.length,
    items: inbox.items.slice(0, 6).map((i) => ({
      key: i.key,
      title: i.title,
      source: INBOX_SOURCE_LABELS[i.source] ?? i.typeLabel,
      href: i.href ?? "/dashboard/approvals",
      ago: timeAgo(new Date(i.createdAt), ctx.now),
      canDecide: i.canDecide,
    })),
  };
}

// ---------------------------------------------------------------------------
// Agents (lead + sub-agents), running now, missions and schedules
// ---------------------------------------------------------------------------

export interface AgentsData {
  tree: AgentTree | null;
  leadAction: { label: string; href: string } | null;
  live: {
    run: { title: string; subtitle?: string; progress: { done: number; total: number } | null; href?: string } | null;
    chips: { key: string; status: AosStatus; label: string; href?: string }[];
  } | null;
}

function liveRunFor(tree: AgentTree): NonNullable<AgentsData["live"]> {
  const running = tree.branches.find((b) => b.status === "running");
  const mission = running?.missionId ? tree.missions.find((m) => m.id === running.missionId) : tree.missions.find((m) => m.status === "running");
  const run = running
    ? { title: `${running.name}: ${running.line}`, subtitle: running.missionName ?? undefined, progress: mission?.progress ?? running.progress ?? null, href: running.href ?? undefined }
    : mission
      ? { title: mission.name, subtitle: mission.line, progress: mission.progress ?? null, href: mission.href }
      : null;
  const chips = tree.branches
    .filter((b) => b.status === "needs" || b.status === "failed")
    .slice(0, 4)
    .map((b) => ({
      key: b.key,
      status: b.status,
      label: `${b.name} ${b.status === "needs" ? "needs you" : "failed"}`,
      href: b.status === "needs" ? "/dashboard/approvals" : (b.href ?? undefined),
    }));
  return { run, chips };
}

async function loadAgents(ctx: LoaderContext): Promise<AgentsData> {
  const activity = await safeAgentActivity(ctx.workspaceId);
  const tree = activity?.tree ?? null;
  if (!tree) return { tree: null, leadAction: null, live: null };
  const leadAction = tree.lead.status === "needs" ? { label: "Review all", href: "/dashboard/approvals" } : tree.lead.href ? { label: "Open mission", href: tree.lead.href } : null;
  return { tree, leadAction, live: liveRunFor(tree) };
}

export interface RunningData {
  nodes: { key: string; name: string; line: string; status: AosStatus; href: string; isLead: boolean; depth: number }[];
  counts: Record<string, number> | null;
}

async function loadRunning(ctx: LoaderContext): Promise<RunningData> {
  const activity = await safeAgentActivity(ctx.workspaceId);
  const tree = activity?.tree ?? null;
  if (!tree) return { nodes: [], counts: null };
  const node = (n: AgentNode, depth: number) => ({ key: n.key, name: n.name, line: n.line, status: n.status, href: n.href ?? "/dashboard/runs", isLead: !!n.isLead, depth });
  // DESIGN.md: the lead first, its sub-agents branch beneath it.
  return { nodes: [node(tree.lead, 0), ...tree.branches.filter((b) => b.status !== "done").map((b) => node(b, 1))], counts: tree.counts as unknown as Record<string, number> };
}

export interface WorkCard {
  key: string;
  status: AosStatus;
  title: string;
  eyebrow: string;
  description: string;
  tools: string[];
  meta: string;
  action: { label: string; href: string };
}

function missionTools(m: MissionView): string[] {
  const seen = new Set<string>();
  for (const b of m.branches) {
    const key = b.key as keyof typeof SUB_AGENTS;
    for (const t of SUB_AGENTS[key]?.tools ?? []) seen.add(t);
  }
  return [...seen].slice(0, 3);
}

function missionCard(m: MissionView, now: Date): WorkCard {
  const team = m.branches.map((b) => b.name);
  const action =
    m.status === "needs"
      ? { label: "Review", href: "/dashboard/approvals" }
      : m.status === "failed" && m.runId
        ? { label: "Open run", href: `/dashboard/runs/${m.runId}` }
        : { label: "Open mission", href: m.href };
  return {
    key: `m:${m.id}`,
    status: m.status,
    title: m.name,
    eyebrow: team.length ? `Mission · Strategist → ${team.join(", ")}` : "Mission · Strategist",
    description: m.line,
    tools: missionTools(m),
    meta: m.progress ? stepCounter(m.progress.done, m.progress.total) : `Updated ${timeAgo(new Date(m.updatedAt), now)}`,
    action,
  };
}

function scheduleCard(s: ScheduleWork, now: Date): WorkCard {
  const meta =
    s.status === "failed"
      ? `Stopped ${timeAgo(new Date(s.updatedAt), now)}`
      : s.status === "running"
        ? "Running now"
        : s.status === "needs"
          ? "Waiting for your approval"
          : s.status === "queued"
            ? "Queued"
            : `Ran ${timeAgo(new Date(s.updatedAt), now)}`;
  return {
    key: `s:${s.id}`,
    status: s.status,
    title: s.name,
    eyebrow: "Schedule",
    description: s.status === "failed" && s.error ? s.error : s.description,
    tools: s.tools,
    meta,
    action: s.status === "needs" ? { label: "Review", href: "/dashboard/approvals" } : { label: "Open run", href: s.href },
  };
}

async function loadWork(ctx: LoaderContext): Promise<{ cards: WorkCard[] }> {
  const activity = await safeAgentActivity(ctx.workspaceId);
  const missions = activity?.tree?.missions ?? [];
  const schedules = activity?.schedules ?? [];
  const cards = [
    ...missions.slice(0, 8).map((m) => ({ status: m.status, updatedAt: m.updatedAt, card: missionCard(m, ctx.now) })),
    ...schedules.slice(0, 6).map((s) => ({ status: s.status, updatedAt: s.updatedAt, card: scheduleCard(s, ctx.now) })),
  ]
    .sort(byStatusThenRecent)
    .map((w) => w.card);
  return { cards };
}

// ---------------------------------------------------------------------------
// The Overview's project stats (shared by projects, key numbers, suggestions, attention)
// ---------------------------------------------------------------------------

const overviewStats = cache(async (workspaceId: string) => {
  const projects = await prisma.project.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { keywords: true, contentItems: true, workflows: true } } },
  });
  const projectIds = projects.map((p) => p.id);
  const [latestScores, pendingApprovals, firstPending, openDecay, recentRuns] = await Promise.all([
    projectIds.length
      ? prisma.visibilityScore.findMany({ where: { projectId: { in: projectIds } }, orderBy: { date: "desc" }, distinct: ["projectId"] })
      : Promise.resolve([]),
    projectIds.length ? prisma.autopilotItem.count({ where: { projectId: { in: projectIds }, status: "pending" } }) : Promise.resolve(0),
    projectIds.length
      ? prisma.autopilotItem.findFirst({ where: { projectId: { in: projectIds }, status: "pending" }, select: { projectId: true } })
      : Promise.resolve(null),
    projectIds.length ? prisma.contentDecayFinding.count({ where: { projectId: { in: projectIds }, status: "open" } }) : Promise.resolve(0),
    projectIds.length
      ? prisma.workflowRun.findMany({
          where: { workflow: { projectId: { in: projectIds } } },
          orderBy: { startedAt: "desc" },
          take: 1,
          include: { workflow: { select: { name: true } } },
        })
      : Promise.resolve([]),
  ]);
  const scoreByProject = new Map(latestScores.map((s) => [s.projectId, s.score]));
  return {
    projects,
    projectIds,
    scoreByProject,
    totalKeywords: projects.reduce((s, p) => s + p._count.keywords, 0),
    totalContent: projects.reduce((s, p) => s + p._count.contentItems, 0),
    pendingApprovals,
    firstPending,
    openDecay,
    lastRun: recentRuns[0] ?? null,
  };
});

export interface ProjectsData {
  projects: { id: string; domain: string; locale: string; keywords: number; content: number; workflows: number; score: number | null }[];
  totals: { keywords: number; content: number };
}

async function loadProjects(ctx: LoaderContext): Promise<ProjectsData> {
  const s = await overviewStats(ctx.workspaceId);
  return {
    projects: s.projects.map((p) => ({
      id: p.id,
      domain: p.domain,
      locale: p.locale,
      keywords: p._count.keywords,
      content: p._count.contentItems,
      workflows: p._count.workflows,
      score: s.scoreByProject.get(p.id) ?? null,
    })),
    totals: { keywords: s.totalKeywords, content: s.totalContent },
  };
}

export interface KeyNumbersData {
  items: { label: string; value: string; href: string }[];
  lastAutomation: { name: string; ago: string } | null;
}

async function loadKeyNumbers(ctx: LoaderContext): Promise<KeyNumbersData> {
  const s = await overviewStats(ctx.workspaceId);
  const scores = [...s.scoreByProject.values()];
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  return {
    items: [
      { label: "Projects", value: String(s.projects.length), href: "/dashboard/projects" },
      { label: "Keywords", value: String(s.totalKeywords), href: "/dashboard/projects" },
      { label: "Content pieces", value: String(s.totalContent), href: "/dashboard/projects" },
      { label: "Visibility (avg)", value: avg === null ? "—" : `${avg}/100`, href: "/dashboard/projects" },
    ],
    lastAutomation: s.lastRun ? { name: s.lastRun.workflow.name, ago: timeAgo(s.lastRun.startedAt, ctx.now) } : null,
  };
}

export type SuggestionIcon = "project" | "keywords" | "content" | "autopilot" | "data";
export interface SuggestionsData {
  items: { icon: SuggestionIcon; text: string; href: string; cta: string }[];
}

async function loadSuggestions(ctx: LoaderContext): Promise<SuggestionsData> {
  const s = await overviewStats(ctx.workspaceId);
  const provider = providerStatus();
  const items: SuggestionsData["items"] = [];
  const first = s.projects[0];
  if (!first) {
    items.push({ icon: "project", text: "Add your first project to unlock keyword research.", href: "/dashboard/projects", cta: "Add a project" });
    return { items };
  }
  if (s.totalKeywords === 0) {
    items.push({ icon: "keywords", text: "Run keyword research to find terms worth ranking for.", href: `/dashboard/projects/${first.id}/keywords`, cta: "Research keywords" });
  } else if (s.totalContent === 0) {
    items.push({ icon: "content", text: `Turn ${s.totalKeywords} saved keywords into content briefs.`, href: `/dashboard/projects/${first.id}/content`, cta: "Create a brief" });
  }
  if (s.pendingApprovals === 0 && !s.lastRun) {
    items.push({ icon: "autopilot", text: "Put refreshes and fixes on autopilot with supervised runs.", href: `/dashboard/projects/${first.id}/autopilot`, cta: "Set up autopilot" });
  }
  if (!provider.isLive) {
    items.push({ icon: "data", text: "Connect DataForSEO for live search data instead of mock results.", href: "/dashboard/settings/providers", cta: "Connect data" });
  }
  return { items };
}

export type AttentionIcon = "drafts" | "decay" | "radar" | "alert";
export interface AttentionData {
  rows: { key: string; icon: AttentionIcon; title: string; meta: string; href: string; cta: string }[];
}

async function loadAttention(ctx: LoaderContext): Promise<AttentionData> {
  const s = await overviewStats(ctx.workspaceId);
  const weekAgo = new Date(ctx.now.getTime() - 7 * 24 * 3600 * 1000);
  const [recentAlerts, radarEvents] = await Promise.all([
    prisma.alertEvent.findMany({
      where: { workspaceId: ctx.workspaceId, createdAt: { gte: weekAgo } },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, title: true, createdAt: true, link: true },
    }),
    s.projectIds.length
      ? prisma.competitorRadarEvent.findMany({
          where: { projectId: { in: s.projectIds }, detectedAt: { gte: weekAgo } },
          orderBy: { detectedAt: "desc" },
          take: 4,
          include: { project: { select: { id: true, domain: true } } },
        })
      : Promise.resolve([]),
  ]);
  const rows: AttentionData["rows"] = [];
  if (s.pendingApprovals > 0 && s.firstPending) {
    rows.push({
      key: "approvals",
      icon: "drafts",
      title: `${s.pendingApprovals} draft${s.pendingApprovals === 1 ? "" : "s"} waiting for review`,
      meta: "Autopilot generated these. Approve or reject to keep it moving",
      href: `/dashboard/projects/${s.firstPending.projectId}/autopilot`,
      cta: "Review drafts",
    });
  }
  if (s.openDecay > 0) {
    const p = s.projects[0];
    rows.push({
      key: "decay",
      icon: "decay",
      title: `${s.openDecay} page${s.openDecay === 1 ? "" : "s"} losing traffic`,
      meta: "Content decay engine flagged pages worth refreshing",
      href: p ? `/dashboard/projects/${p.id}/decay` : "/dashboard",
      cta: "See pages",
    });
  }
  for (const e of radarEvents) {
    rows.push({
      key: `radar-${e.id}`,
      icon: "radar",
      title: `Competitor move: ${e.competitorDomain}`,
      meta: `${e.project.domain} · ${timeAgo(e.detectedAt, ctx.now)}`,
      href: `/dashboard/projects/${e.project.id}?tab=competitors`,
      cta: "Investigate",
    });
  }
  for (const a of recentAlerts) {
    rows.push({ key: `alert-${a.id}`, icon: "alert", title: a.title, meta: timeAgo(a.createdAt, ctx.now), href: a.link ?? "/dashboard/alerts", cta: "Open" });
  }
  return { rows: rows.slice(0, 8) };
}

// ---------------------------------------------------------------------------
// Today's calendar: bookings + the calendar connectors' list_events
// ---------------------------------------------------------------------------

export interface CalendarItem {
  id: string;
  title: string;
  start: string;
  end: string | null;
  source: "booking" | "google" | "outlook";
  href: string | null;
  /** The connector answered from its labelled mock path (never in production). */
  mock: boolean;
}

export interface CalendarData {
  items: CalendarItem[];
  connected: { google: boolean; outlook: boolean };
  /** A connected calendar that failed to answer (shown, not hidden). */
  errors: string[];
  timeZone: string;
}

async function connectorEvents(
  ctx: LoaderContext,
  connectorKey: "google-calendar" | "outlook-calendar",
  from: Date,
  to: Date,
): Promise<{ connected: boolean; items: CalendarItem[]; error: string | null }> {
  const conn = await prisma.connectorConnection.findFirst({
    where: { workspaceId: ctx.workspaceId, connectorKey, status: "active" },
    orderBy: { connectedAt: "desc" },
    select: { id: true },
  });
  if (!conn) return { connected: false, items: [], error: null };
  const name = connectorKey === "google-calendar" ? "Google Calendar" : "Outlook Calendar";
  try {
    const { getAdapterForConnection } = await import("@/lib/connectors/m21");
    const { getDecryptedCredential } = await import("@/lib/vault/refresh");
    const adapter = await getAdapterForConnection({ connectorKey });
    const credential = await getDecryptedCredential(conn.id);
    const res = await adapter.invoke("list_events", { from: from.toISOString(), to: to.toISOString(), limit: 20 }, credential, {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
    });
    if (!res.ok) return { connected: true, items: [], error: `${name}: ${res.error ?? "the request failed"}. Reconnect it in Settings → Connectors.` };
    const rows = Array.isArray(res.data) ? (res.data as Array<Record<string, unknown>>) : [];
    return {
      connected: true,
      error: null,
      items: rows.slice(0, 20).map((e, i) => ({
        id: `${connectorKey}:${String(e.id ?? i)}`,
        title: typeof e.title === "string" && e.title.trim() ? e.title : "(no title)",
        start: typeof e.start === "string" ? e.start : from.toISOString(),
        end: typeof e.end === "string" ? e.end : null,
        source: connectorKey === "google-calendar" ? "google" : "outlook",
        href: typeof e.url === "string" && /^https:\/\//.test(e.url) ? e.url : null,
        mock: !!res.mock,
      })),
    };
  } catch (err) {
    return { connected: true, items: [], error: `${name} did not answer (${err instanceof Error ? err.message.slice(0, 120) : "error"}).` };
  }
}

export async function loadCalendar(ctx: LoaderContext): Promise<CalendarData> {
  const tz = resolveTimeZone(ctx.timeZone ?? DEFAULT_TIME_ZONE);
  const from = startOfZonedDay(ctx.now, tz);
  const to = new Date(from.getTime() + 24 * 3600 * 1000);
  const [bookings, google, outlook] = await Promise.all([
    prisma.booking.findMany({
      where: { workspaceId: ctx.workspaceId, startAt: { gte: from, lt: to }, status: { not: "cancelled" } },
      orderBy: { startAt: "asc" },
      take: 20,
      select: { id: true, name: true, startAt: true, endAt: true, page: { select: { title: true } } },
    }),
    connectorEvents(ctx, "google-calendar", from, to),
    connectorEvents(ctx, "outlook-calendar", from, to),
  ]);
  const items: CalendarItem[] = [
    ...bookings.map((b) => ({
      id: `booking:${b.id}`,
      title: `${b.page?.title ?? "Booking"} with ${b.name}`,
      start: b.startAt.toISOString(),
      end: b.endAt.toISOString(),
      source: "booking" as const,
      href: "/dashboard/calls",
      mock: false,
    })),
    ...google.items,
    ...outlook.items,
  ].sort((a, b) => a.start.localeCompare(b.start));
  return {
    items,
    connected: { google: google.connected, outlook: outlook.connected },
    errors: [google.error, outlook.error].filter((e): e is string => !!e),
    timeZone: tz,
  };
}

// ---------------------------------------------------------------------------
// Inbox, pipeline, cash, twin
// ---------------------------------------------------------------------------

export interface InboxData {
  unreadThreads: number;
  threads: { leadId: string; name: string; snippet: string; channel: string; ago: string; unread: number }[];
}

async function loadInboxWidget(ctx: LoaderContext): Promise<InboxData> {
  const { listThreads } = await import("@/lib/crm/inbox");
  const list = await withWorkspaceScope(ctx.workspaceId, (tx) =>
    listThreads(tx, { workspaceId: ctx.workspaceId, userId: ctx.userId, unread: true, assigned: "any", limit: 4 }),
  );
  return {
    unreadThreads: list.unreadThreads,
    threads: list.threads.map((t) => ({
      leadId: t.leadId,
      name: t.leadName,
      snippet: t.lastSnippet,
      channel: t.lastChannel === "sms" ? "Text" : t.lastChannel === "email" ? "Email" : t.lastChannel,
      ago: timeAgo(new Date(t.lastMessageAt), ctx.now),
      unread: t.unreadCount,
    })),
  };
}

export interface PipelineData {
  stages: { id: string; label: string; count: number; valueCents: number }[];
  openCount: number;
  openValueCents: number;
}

async function loadPipeline(ctx: LoaderContext): Promise<PipelineData> {
  const [groups, pipeline] = await Promise.all([
    prisma.lead.groupBy({
      by: ["stage"],
      where: { workspaceId: ctx.workspaceId, stage: { notIn: [...CLOSED_STAGES] } },
      _count: { _all: true },
      _sum: { valueCents: true },
    }),
    prisma.pipeline.findFirst({ where: { workspaceId: ctx.workspaceId }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }], select: { stages: true } }),
  ]);
  let stages = DEFAULT_STAGES;
  try {
    if (pipeline) stages = parseStages(pipeline.stages);
  } catch {
    stages = DEFAULT_STAGES;
  }
  const byId = new Map(groups.map((g) => [g.stage, g]));
  const ordered = stages
    .filter((s) => !CLOSED_STAGES.has(s.id))
    .map((s) => ({ id: s.id, label: s.label, count: byId.get(s.id)?._count._all ?? 0, valueCents: byId.get(s.id)?._sum.valueCents ?? 0 }));
  // Stages a lead sits in that the default pipeline doesn't list (other pipelines).
  for (const g of groups) {
    if (!ordered.some((s) => s.id === g.stage)) ordered.push({ id: g.stage, label: g.stage, count: g._count._all, valueCents: g._sum.valueCents ?? 0 });
  }
  return {
    stages: ordered,
    openCount: ordered.reduce((s, x) => s + x.count, 0),
    openValueCents: ordered.reduce((s, x) => s + x.valueCents, 0),
  };
}

export interface CashData {
  paymentsLast30dCents: number;
  openInvoices: number;
  overdueInvoices: number;
  pendingApprovals: number;
}

async function loadCash(ctx: LoaderContext): Promise<CashData> {
  const { getOpsOverview } = await import("@/lib/ops/overview");
  const o = await withWorkspaceScope(ctx.workspaceId, (tx) => getOpsOverview(tx, ctx.workspaceId));
  return { paymentsLast30dCents: o.paymentsLast30dCents, openInvoices: o.openInvoices, overdueInvoices: o.overdueInvoices, pendingApprovals: o.pendingOpsApprovals };
}

export interface TwinData {
  site: { id: string; name: string; kind: string } | null;
  kpis: TwinKpi[];
}

async function loadTwin(ctx: LoaderContext): Promise<TwinData> {
  const { listSites, siteSnapshotFor, canViewSite } = await import("@/lib/twin/state");
  const canEdit = ["editor", "admin", "owner"].includes(ctx.role);
  const sites = (await listSites(ctx.workspaceId)).filter((s) => canViewSite(s.status, canEdit));
  const site = sites[0];
  if (!site) return { site: null, kpis: [] };
  const snap = await siteSnapshotFor(ctx.workspaceId, site.id, canEdit);
  return { site: { id: site.id, name: site.name, kind: site.kind }, kpis: snap.kpis.slice(0, 6) };
}

// ---------------------------------------------------------------------------
// The Today briefing
// ---------------------------------------------------------------------------

export interface BriefingData {
  enabled: boolean;
  day: string;
  status: "off" | "none" | "pending" | "ready" | "failed";
  body: string | null;
  error: string | null;
  writtenAt: string | null;
  model: string | null;
}

async function loadBriefing(ctx: LoaderContext): Promise<BriefingData> {
  const { readTodayBriefing } = await import("./briefing.server");
  return readTodayBriefing(ctx.workspaceId, ctx.userId, ctx.timeZone, ctx.now);
}

// ---------------------------------------------------------------------------

export interface WidgetDataMap {
  briefing: BriefingData;
  "needs-you": NeedsYouData;
  agents: AgentsData;
  running: RunningData;
  work: { cards: WorkCard[] };
  attention: AttentionData;
  calendar: CalendarData;
  inbox: InboxData;
  pipeline: PipelineData;
  cash: CashData;
  twin: TwinData;
  "key-numbers": KeyNumbersData;
  projects: ProjectsData;
  suggestions: SuggestionsData;
}

export const WIDGET_LOADERS: { [K in WidgetId]: (ctx: LoaderContext) => Promise<WidgetDataMap[K]> } = {
  briefing: loadBriefing,
  "needs-you": loadNeedsYou,
  agents: loadAgents,
  running: loadRunning,
  work: loadWork,
  attention: loadAttention,
  calendar: loadCalendar,
  inbox: loadInboxWidget,
  pipeline: loadPipeline,
  cash: loadCash,
  twin: loadTwin,
  "key-numbers": loadKeyNumbers,
  projects: loadProjects,
  suggestions: loadSuggestions,
};

/** Load the data for the widgets on a desktop (only those placed; in parallel). */
export async function loadWidgets(ctx: LoaderContext, ids: readonly WidgetId[]): Promise<{ [K in WidgetId]?: LoadResult<WidgetDataMap[K]> }> {
  const entries = await Promise.all(
    [...new Set(ids)].map(async (id) => [id, await safe(id, () => (WIDGET_LOADERS[id] as (c: LoaderContext) => Promise<unknown>)(ctx))] as const),
  );
  return Object.fromEntries(entries) as { [K in WidgetId]?: LoadResult<WidgetDataMap[K]> };
}
