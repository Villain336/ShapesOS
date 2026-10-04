// ShapesOS — the agent home (Overview). Top to bottom: status banners when
// something needs the user (approvals waiting → yellow "Review all"; work
// that stopped → red "Reconnect" / "Open"), the lead agent's card with its
// sub-agents branching beneath it (one lead per workspace — DESIGN.md
// "Agents: one lead, many sub-agents"), live activity, the missions and
// schedules in flight as status-band cards, then the attention queue and
// projects. An empty workspace gets an invitation to hand over a first task.

import Link from "next/link";
import {
  Bell,
  BookOpen,
  ChevronRight,
  CheckCircle,
  Clock,
  FileText,
  Kanban,
  Key,
  Crosshair,
  Plus,
  Rocket,
  ShieldCheck,
  TrendingUp,
  TriangleAlert,
} from "lucide-react";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { redirect } from "next/navigation";
import { getMembership } from "@/lib/authz";
import { needsOnboarding } from "@/lib/workspace/onboarding";
import { providerStatus } from "@/lib/providers";
import ProjectCreateForm from "@/components/ProjectCreateForm";
import { Card, CardBody, CardHeader } from "@/components/vault/Card";
import { EmptyState } from "@/components/vault/EmptyState";
import { ValuePill } from "@/components/vault/atoms/ValuePill";
import { safeAgentActivity, type ScheduleWork } from "@/lib/aos/activity.server";
import { deriveBanners, failedWorkFromTree, type FailedWork } from "@/lib/aos/home";
import { SUB_AGENTS, type AgentTree, type MissionView } from "@/lib/aos/agents";
import { stepCounter } from "@/lib/aos/run-steps";
import { byStatusThenRecent } from "@/lib/aos/status";
import { loadInbox, resolveInboxViewer } from "@/lib/approvals/inbox";
import { AgentCard, Banner, LeadAgentCard, LiveActivity, LogoMark, aosButton, type LiveChip, type LiveRun } from "@/components/aos";

export const dynamic = "force-dynamic";

const NEW_TASK_HREF = "/dashboard/assistant";

const relFmt = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
function timeAgo(d: Date): string {
  const sec = Math.round((d.getTime() - Date.now()) / 1000);
  const abs = Math.abs(sec);
  if (abs < 60) return relFmt.format(sec, "second");
  if (abs < 3600) return relFmt.format(Math.round(sec / 60), "minute");
  if (abs < 86400) return relFmt.format(Math.round(sec / 3600), "hour");
  return relFmt.format(Math.round(sec / 86400), "day");
}

type AttentionRow = {
  key: string;
  icon: React.ReactNode;
  title: string;
  meta: string;
  href: string;
  cta: string;
};

/** Approvals waiting on this member, grouped by queue (best effort). */
async function approvalsSummary(userId: string, workspaceId: string) {
  try {
    const viewer = await resolveInboxViewer(userId, workspaceId);
    if (!viewer) return { actionable: 0, sources: [] as string[] };
    const inbox = await loadInbox(viewer, { limitPerSource: 25 });
    return {
      actionable: inbox.actionable,
      sources: inbox.sources.filter((s) => s.actionable > 0).map((s) => s.label),
    };
  } catch {
    return { actionable: 0, sources: [] as string[] };
  }
}

// ── Work cards (missions + schedules) ──────────────────────────────────────

function missionTools(m: MissionView): string[] {
  const seen = new Set<string>();
  for (const b of m.branches) {
    const key = b.key as keyof typeof SUB_AGENTS;
    for (const t of SUB_AGENTS[key]?.tools ?? []) seen.add(t);
  }
  return [...seen].slice(0, 3);
}

function missionCard(m: MissionView) {
  const team = m.branches.map((b) => b.name);
  const action =
    m.status === "needs"
      ? { label: "Review", href: "/dashboard/approvals" }
      : m.status === "failed" && m.runId
        ? { label: "Open run", href: `/dashboard/runs/${m.runId}` }
        : { label: "Open mission", href: m.href };
  return (
    <AgentCard
      key={`m:${m.id}`}
      status={m.status}
      title={m.name}
      eyebrow={team.length ? `Mission · Strategist → ${team.join(", ")}` : "Mission · Strategist"}
      description={m.line}
      tools={missionTools(m)}
      meta={m.progress ? stepCounter(m.progress.done, m.progress.total) : `Updated ${timeAgo(new Date(m.updatedAt))}`}
      action={action}
    />
  );
}

function scheduleCard(s: ScheduleWork) {
  const meta =
    s.status === "failed"
      ? `Stopped ${timeAgo(new Date(s.updatedAt))}`
      : s.status === "running"
        ? "Running now"
        : s.status === "needs"
          ? "Waiting for your approval"
          : s.status === "queued"
            ? "Queued"
            : `Ran ${timeAgo(new Date(s.updatedAt))}`;
  const action = s.status === "needs" ? { label: "Review", href: "/dashboard/approvals" } : { label: "Open run", href: s.href };
  return (
    <AgentCard
      key={`s:${s.id}`}
      status={s.status}
      title={s.name}
      eyebrow="Schedule"
      description={s.status === "failed" && s.error ? s.error : s.description}
      tools={s.tools}
      meta={meta}
      action={action}
    />
  );
}

function liveRunFor(tree: AgentTree): { run: LiveRun | null; chips: LiveChip[] } {
  const running = tree.branches.find((b) => b.status === "running");
  const mission = running?.missionId ? tree.missions.find((m) => m.id === running.missionId) : tree.missions.find((m) => m.status === "running");
  const run: LiveRun | null = running
    ? {
        title: `${running.name}: ${running.line}`,
        subtitle: running.missionName ?? undefined,
        progress: mission?.progress ?? null,
        href: running.href ?? undefined,
      }
    : mission
      ? { title: mission.name, subtitle: mission.line, progress: mission.progress, href: mission.href }
      : null;
  const chips: LiveChip[] = tree.branches
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

export default async function DashboardPage() {
  const user = await requireUser();
  if (!user) return null; // layout already redirects

  const workspace = await getOrCreateWorkspace(user.id, user.email);
  // Phase 3: a brand-new workspace opens on first-run setup, once (admins only).
  const me = await getMembership(user.id, workspace.id);
  if (needsOnboarding(workspace, me?.role)) redirect("/dashboard/welcome");
  const [projects, activity, approvals] = await Promise.all([
    prisma.project.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { keywords: true, contentItems: true, workflows: true } },
      },
    }),
    safeAgentActivity(workspace.id),
    approvalsSummary(user.id, workspace.id),
  ]);
  const projectIds = projects.map((p) => p.id);
  const provider = providerStatus();

  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);

  const [
    latestScores,
    pendingApprovals,
    firstPending,
    openDecay,
    recentAlerts,
    radarEvents,
    recentRuns,
  ] = await Promise.all([
    projectIds.length
      ? prisma.visibilityScore.findMany({
          where: { projectId: { in: projectIds } },
          orderBy: { date: "desc" },
          distinct: ["projectId"],
        })
      : Promise.resolve([]),
    projectIds.length
      ? prisma.autopilotItem.count({
          where: { projectId: { in: projectIds }, status: "pending" },
        })
      : Promise.resolve(0),
    projectIds.length
      ? prisma.autopilotItem.findFirst({
          where: { projectId: { in: projectIds }, status: "pending" },
          select: { projectId: true },
        })
      : Promise.resolve(null),
    projectIds.length
      ? prisma.contentDecayFinding.count({
          where: { projectId: { in: projectIds }, status: "open" },
        })
      : Promise.resolve(0),
    prisma.alertEvent.findMany({
      where: { workspaceId: workspace.id, createdAt: { gte: weekAgo } },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, title: true, trigger: true, createdAt: true, link: true },
    }),
    projectIds.length
      ? prisma.competitorRadarEvent.findMany({
          where: { projectId: { in: projectIds }, detectedAt: { gte: weekAgo } },
          orderBy: { detectedAt: "desc" },
          take: 4,
          include: { project: { select: { id: true, domain: true } } },
        })
      : Promise.resolve([]),
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
  const totalKeywords = projects.reduce((s, p) => s + p._count.keywords, 0);
  const totalContent = projects.reduce((s, p) => s + p._count.contentItems, 0);

  // ── agents: lead → sub-agents, work cards, banners ───────
  const tree = activity?.tree ?? null;
  const schedules = activity?.schedules ?? [];
  const failedSchedules: FailedWork[] = schedules
    .filter((s) => s.status === "failed")
    .map((s) => ({ key: `schedule:${s.id}`, name: s.name, detail: s.error ?? "The last scheduled run failed", href: s.href }));
  const banners = deriveBanners({ approvals, failed: [...failedWorkFromTree(tree), ...failedSchedules] });
  // Missions and schedules in flight, most urgent first (needs > failed > running > …).
  const workCards = [
    ...(tree?.missions ?? []).slice(0, 8).map((m) => ({ status: m.status, updatedAt: m.updatedAt, el: missionCard(m) })),
    ...schedules.slice(0, 6).map((s) => ({ status: s.status, updatedAt: s.updatedAt, el: scheduleCard(s) })),
  ]
    .sort(byStatusThenRecent)
    .map((w) => w.el);
  const live = tree ? liveRunFor(tree) : null;
  const hasAgentWork = !!tree || schedules.length > 0;
  const leadAction = tree
    ? tree.lead.status === "needs"
      ? { label: "Review all", href: "/dashboard/approvals" }
      : tree.lead.href
        ? { label: "Open mission", href: tree.lead.href }
        : null
    : null;

  // ── attention queue ──────────────────────────────────────
  const attention: AttentionRow[] = [];
  if (pendingApprovals > 0 && firstPending) {
    attention.push({
      key: "approvals",
      icon: <ShieldCheck className="size-5" />,
      title: `${pendingApprovals} draft${pendingApprovals === 1 ? "" : "s"} waiting for review`,
      meta: "Autopilot generated these — approve or reject to keep it moving",
      href: `/dashboard/projects/${firstPending.projectId}/autopilot`,
      cta: "Review drafts",
    });
  }
  if (openDecay > 0) {
    const p = projects[0];
    attention.push({
      key: "decay",
      icon: <TrendingUp className="size-5" />,
      title: `${openDecay} page${openDecay === 1 ? "" : "s"} losing traffic`,
      meta: "Content decay engine flagged pages worth refreshing",
      href: p ? `/dashboard/projects/${p.id}/decay` : "/dashboard",
      cta: "See pages",
    });
  }
  for (const e of radarEvents) {
    attention.push({
      key: `radar-${e.id}`,
      icon: <Crosshair className="size-5" />,
      title: `Competitor move: ${e.competitorDomain}`,
      meta: `${e.project.domain} · ${timeAgo(e.detectedAt)}`,
      href: `/dashboard/projects/${e.project.id}?tab=competitors`,
      cta: "Investigate",
    });
  }
  for (const a of recentAlerts) {
    attention.push({
      key: `alert-${a.id}`,
      icon: <Bell className="size-5" />,
      title: a.title,
      meta: `${timeAgo(a.createdAt)}`,
      href: a.link ?? "/dashboard/alerts",
      cta: "Open",
    });
  }

  // ── "win this week" suggestions ──────────────────────────
  const suggestions: { icon: React.ReactNode; text: string; href: string; cta: string }[] = [];
  if (projects.length === 0) {
    suggestions.push({
      icon: <Kanban className="size-4" />,
      text: "Add your first project to unlock keyword research.",
      href: "#new-project",
      cta: "Add a project",
    });
  } else {
    if (totalKeywords === 0) {
      suggestions.push({
        icon: <Key className="size-4" />,
        text: "Run keyword research to find terms worth ranking for.",
        href: `/dashboard/projects/${projects[0]!.id}/keywords`,
        cta: "Research keywords",
      });
    } else if (totalContent === 0) {
      suggestions.push({
        icon: <FileText className="size-4" />,
        text: `Turn ${totalKeywords} saved keywords into content briefs.`,
        href: `/dashboard/projects/${projects[0]!.id}/content`,
        cta: "Create a brief",
      });
    }
    if (pendingApprovals === 0 && recentRuns.length === 0) {
      suggestions.push({
        icon: <Rocket className="size-4" />,
        text: "Put refreshes and fixes on autopilot with supervised runs.",
        href: `/dashboard/projects/${projects[0]!.id}/autopilot`,
        cta: "Set up autopilot",
      });
    }
    if (!provider.isLive) {
      suggestions.push({
        icon: <TriangleAlert className="size-4" />,
        text: "Connect DataForSEO for live search data instead of mock results.",
        href: "/dashboard/settings/providers",
        cta: "Connect data",
      });
    }
  }

  const lastRun = recentRuns[0];

  return (
    <div className="flex flex-col gap-6">
      {/* Page headline */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="aos-heading">{workspace.name}</h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted">
            <span>Plan</span>
            <ValuePill>{workspace.plan}</ValuePill>
            <span aria-hidden className="text-subtle">·</span>
            <span>Data</span>
            <ValuePill>{provider.isLive ? "DataForSEO (live)" : "Mock"}</ValuePill>
            {lastRun ? (
              <>
                <span aria-hidden className="text-subtle">·</span>
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3.5" />
                  Last automation “{lastRun.workflow.name}” ran {timeAgo(lastRun.startedAt)}
                </span>
              </>
            ) : null}
          </p>
        </div>
        <Link href={NEW_TASK_HREF} className={aosButton({ variant: "primary" })}>
          <Plus className="size-4" aria-hidden />
          New task
        </Link>
      </div>

      {/* Status banners: only when something needs the user. */}
      {banners.length ? (
        <div className="flex flex-col gap-2.5" aria-label="Needs your attention">
          {banners.map((b) => (
            <Banner
              key={b.key}
              status={b.status as "needs" | "failed"}
              title={b.title}
              description={b.description}
              action={b.action}
            />
          ))}
        </div>
      ) : null}

      {hasAgentWork ? (
        <>
          <section aria-labelledby="agents-h" className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between">
              <h2 id="agents-h" className="aos-subheading">
                Your agents
              </h2>
              <Link href="/dashboard/runs" className="text-sm font-semibold text-ink hover:underline">
                All runs
              </Link>
            </div>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
              {tree ? <LeadAgentCard tree={tree} action={leadAction} /> : null}
              <div className="flex min-w-0 flex-col gap-4">
                {tree ? <LiveActivity counts={tree.counts} run={live?.run} chips={live?.chips} /> : null}
                {/* The most urgent piece of work sits beside the lead. */}
                {workCards[0] ?? null}
              </div>
            </div>
            {workCards.length > 1 ? (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{workCards.slice(1)}</div>
            ) : null}
          </section>
        </>
      ) : (
        <section
          aria-labelledby="empty-agents-h"
          className="flex flex-col items-start gap-4 rounded-lg bg-paper p-6 shadow-hairline sm:flex-row sm:items-center sm:p-8"
        >
          <LogoMark size={56} />
          <div className="min-w-0 flex-1">
            <h2 id="empty-agents-h" className="text-2xl leading-tight font-extrabold stretch-display tracking-display text-ink">
              Hand your first goal to an agent
            </h2>
            <p className="mt-2 max-w-[60ch] text-md text-muted">
              Describe what you want done. The lead agent plans it, hands each step to a sub-agent, and asks you before
              anything goes out. Live work shows up here and under Running now.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href={NEW_TASK_HREF} className={aosButton({ variant: "primary" })}>
              <Plus className="size-4" aria-hidden />
              New task
            </Link>
            <Link href="/dashboard/missions" className={aosButton({ variant: "secondary" })}>
              <BookOpen className="size-4" aria-hidden />
              Mission templates
            </Link>
          </div>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        {/* Main column */}
        <div className="flex min-w-0 flex-col gap-6">
          {/* Attention queue */}
          <section aria-labelledby="attention-h">
            <div className="mb-2 flex items-baseline justify-between">
              <h2 id="attention-h" className="aos-subheading">
                Needs your attention
              </h2>
              {attention.length > 0 ? (
                <span className="text-xs text-subtle">
                  {attention.length} item{attention.length === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>
            {attention.length === 0 ? (
              <div className="rounded-lg bg-paper px-4 py-6 text-center shadow-hairline">
                <CheckCircle className="mx-auto size-6 text-ink" />
                <p className="aos-subheading mt-2">All quiet</p>
                <p className="mx-auto mt-1 max-w-[38ch] text-sm text-muted">
                  Nothing needs you right now. New drafts, decay alerts, and competitor moves
                  will show up here.
                </p>
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {attention.slice(0, 6).map((row, i) => (
                  <li
                    key={row.key}
                    className="widget-enter rounded-lg bg-paper shadow-hairline"
                    style={{ animationDelay: `${i * 45}ms` }}
                  >
                    <Link
                      href={row.href}
                      className="group flex items-center gap-3 px-4 py-3 transition-[background-color] duration-150 hover:bg-hover-paper"
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-canvas text-muted">
                        {row.icon}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-base font-medium text-ink">
                          {row.title}
                        </span>
                        <span className="block truncate text-sm text-muted">{row.meta}</span>
                      </span>
                      <span className="shrink-0 text-sm font-semibold text-ink">
                        {row.cta}
                      </span>
                      <ChevronRight className="size-4 shrink-0 text-subtle transition-transform duration-150 group-hover:translate-x-0.5" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Projects */}
          <section aria-labelledby="projects-h" id="new-project">
            <div className="mb-2 flex items-baseline justify-between">
              <h2 id="projects-h" className="aos-subheading">
                Projects
              </h2>
              <span className="text-xs text-subtle">
                {projects.length} project{projects.length === 1 ? "" : "s"} ·{" "}
                {totalKeywords} keywords · {totalContent} content pieces
              </span>
            </div>
            <Card>
              <CardBody className="p-0">
                {projects.length === 0 ? (
                  <EmptyState
                    icon={<Kanban className="size-5" />}
                    title="No projects yet"
                    description="Add a domain to start keyword research, track rankings, and generate content."
                  />
                ) : (
                  <ul className="flex flex-col">
                    {projects.map((p) => {
                      const score = scoreByProject.get(p.id);
                      return (
                        <li key={p.id} className="border-b border-line last:border-b-0">
                          <Link
                            href={`/dashboard/projects/${p.id}`}
                            className="group flex items-center justify-between gap-3 px-4 py-3.5 transition-[background-color] duration-150 hover:bg-hover-paper"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-base font-medium text-ink">
                                {p.domain}
                              </span>
                              <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-muted">
                                <ValuePill>
                                  {p._count.keywords} keyword{p._count.keywords === 1 ? "" : "s"}
                                </ValuePill>
                                <ValuePill>
                                  {p._count.contentItems} content
                                </ValuePill>
                                <ValuePill>
                                  {p._count.workflows} automation{p._count.workflows === 1 ? "" : "s"}
                                </ValuePill>
                                <span className="text-subtle">{p.locale}</span>
                              </span>
                            </span>
                            {score !== undefined ? (
                              <span
                                className="flex size-11 shrink-0 flex-col items-center justify-center rounded-md bg-canvas shadow-hairline"
                                title={`Visibility score ${score}/100`}
                              >
                                <span className="text-base font-semibold tabular-nums text-ink">
                                  {score}
                                </span>
                                <span className="text-2xs leading-none text-subtle">score</span>
                              </span>
                            ) : null}
                            <ChevronRight className="size-4 shrink-0 text-subtle transition-transform duration-150 group-hover:translate-x-0.5" />
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardBody>
            </Card>
          </section>

          <ProjectCreateForm />
        </div>

        {/* Side rail — win this week */}
        <aside className="flex min-w-0 flex-col gap-4" aria-label="Suggested next steps">
          <Card>
            <CardHeader title="Win this week" description="The shortest path to more traffic" />
            <CardBody className="flex flex-col gap-1 p-2">
              {suggestions.length === 0 ? (
                <p className="px-2 py-1 text-sm text-muted">
                  You’re on top of everything. Check back after the next scheduled run.
                </p>
              ) : (
                suggestions.map((s, i) => (
                  <Link
                    key={i}
                    href={s.href}
                    className="group flex items-start gap-2.5 rounded-md px-2 py-2 transition-[background-color] duration-150 hover:bg-hover-paper"
                  >
                    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-canvas text-muted">
                      {s.icon}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm leading-snug text-muted">{s.text}</span>
                      <span className="mt-0.5 inline-block text-sm font-semibold text-ink">
                        {s.cta}
                      </span>
                    </span>
                  </Link>
                ))
              )}
            </CardBody>
          </Card>
        </aside>
      </div>
    </div>
  );
}
