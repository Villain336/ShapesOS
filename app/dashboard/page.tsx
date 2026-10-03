// Marketr — dashboard home: attention queue, project vitals, and the
// shortest path from "what's happening" to "what to do next".

import Link from "next/link";
import {
  Bell,
  ChevronRight,
  CheckCircle,
  Clock,
  FileText,
  Kanban,
  Key,
  Crosshair,
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

export const dynamic = "force-dynamic";

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

export default async function DashboardPage() {
  const user = await requireUser();
  if (!user) return null; // layout already redirects

  const workspace = await getOrCreateWorkspace(user.id, user.email);
  // Phase 3: a brand-new workspace opens on first-run setup, once (admins only).
  const me = await getMembership(user.id, workspace.id);
  if (needsOnboarding(workspace, me?.role)) redirect("/dashboard/welcome");
  const projects = await prisma.project.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { keywords: true, contentItems: true, workflows: true } },
    },
  });
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
        <div>
          <h1 className="aos-heading">
            {workspace.name}
          </h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted">
            <span>Plan</span>
            <ValuePill>{workspace.plan}</ValuePill>
            <span aria-hidden className="text-subtle">·</span>
            <span>Data</span>
            <ValuePill>
              {provider.isLive ? "DataForSEO (live)" : "Mock"}
            </ValuePill>
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
        {projects.length > 0 ? (
          <Link
            href={`/dashboard/assistant?project=${projects[0]!.id}`}
            className="aos-press inline-flex h-control items-center gap-2 rounded-full bg-ink px-5.5 text-base font-semibold text-white hover:bg-night-hover"
          >
            <TrendingUp className="size-4" />
            Ask Marketr
          </Link>
        ) : null}
      </div>

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
