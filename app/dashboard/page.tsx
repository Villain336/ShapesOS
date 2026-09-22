// Marketr — dashboard home: attention queue, project vitals, and the
// shortest path from "what's happening" to "what to do next".

import Link from "next/link";
import {
  Bell,
  CaretRight,
  CheckCircle,
  Clock,
  FileText,
  Kanban,
  Key,
  Crosshair,
  Rocket,
  ShieldCheck,
  TrendUp,
  Warning,
} from "@/components/vault/phosphor";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { providerStatus } from "@/lib/providers";
import ProjectCreateForm from "@/components/ProjectCreateForm";
import { Card, CardBody, CardHeader } from "@/components/vault/Card";
import { EmptyState } from "@/components/vault/EmptyState";
import { ValuePill } from "@/components/vault/atoms/ValuePill";
import { cn } from "@/lib/utils";

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
      icon: <ShieldCheck className="size-5" weight="duotone" />,
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
      icon: <TrendUp className="size-5" weight="duotone" />,
      title: `${openDecay} page${openDecay === 1 ? "" : "s"} losing traffic`,
      meta: "Content decay engine flagged pages worth refreshing",
      href: p ? `/dashboard/projects/${p.id}/decay` : "/dashboard",
      cta: "See pages",
    });
  }
  for (const e of radarEvents) {
    attention.push({
      key: `radar-${e.id}`,
      icon: <Crosshair className="size-5" weight="duotone" />,
      title: `Competitor move: ${e.competitorDomain}`,
      meta: `${e.project.domain} · ${timeAgo(e.detectedAt)}`,
      href: `/dashboard/projects/${e.project.id}?tab=competitors`,
      cta: "Investigate",
    });
  }
  for (const a of recentAlerts) {
    attention.push({
      key: `alert-${a.id}`,
      icon: <Bell className="size-5" weight="duotone" />,
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
      icon: <Kanban className="size-4" weight="duotone" />,
      text: "Add your first project to unlock keyword research.",
      href: "#new-project",
      cta: "Add a project",
    });
  } else {
    if (totalKeywords === 0) {
      suggestions.push({
        icon: <Key className="size-4" weight="duotone" />,
        text: "Run keyword research to find terms worth ranking for.",
        href: `/dashboard/projects/${projects[0]!.id}/keywords`,
        cta: "Research keywords",
      });
    } else if (totalContent === 0) {
      suggestions.push({
        icon: <FileText className="size-4" weight="duotone" />,
        text: `Turn ${totalKeywords} saved keywords into content briefs.`,
        href: `/dashboard/projects/${projects[0]!.id}/content`,
        cta: "Create a brief",
      });
    }
    if (pendingApprovals === 0 && recentRuns.length === 0) {
      suggestions.push({
        icon: <Rocket className="size-4" weight="duotone" />,
        text: "Put refreshes and fixes on autopilot with supervised runs.",
        href: `/dashboard/projects/${projects[0]!.id}/autopilot`,
        cta: "Set up autopilot",
      });
    }
    if (!provider.isLive) {
      suggestions.push({
        icon: <Warning className="size-4" weight="duotone" />,
        text: "Connect DataForSEO for live search data instead of mock results.",
        href: "/dashboard/settings",
        cta: "Connect data",
      });
    }
  }

  const lastRun = recentRuns[0];

  return (
    <div className="flex flex-col gap-6">
      {/* Page headline — display serif, sentence case */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="display-serif text-[28px] font-medium text-ink sm:text-[32px]">
            {workspace.name}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-ink-2">
            <span>Plan</span>
            <ValuePill>{workspace.plan}</ValuePill>
            <span aria-hidden className="text-ink-3">·</span>
            <span>Data</span>
            <ValuePill tone={provider.isLive ? "green" : "orange"}>
              {provider.isLive ? "DataForSEO (live)" : "Mock"}
            </ValuePill>
            {lastRun ? (
              <>
                <span aria-hidden className="text-ink-3">·</span>
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
            className="pressable inline-flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-[13.5px] font-medium text-white transition-colors hover:bg-accent-hover"
          >
            <TrendUp className="size-4" weight="duotone" />
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
              <h2 id="attention-h" className="text-[15px] font-semibold text-ink">
                Needs your attention
              </h2>
              {attention.length > 0 ? (
                <span className="text-[12.5px] text-ink-3">
                  {attention.length} item{attention.length === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>
            {attention.length === 0 ? (
              <div className="rounded-card border border-line bg-surface px-4 py-6 text-center">
                <CheckCircle className="mx-auto size-6 text-green" weight="duotone" />
                <p className="display-serif mt-2 text-[17px] text-ink">All quiet</p>
                <p className="mx-auto mt-1 max-w-[38ch] text-[13px] text-ink-2">
                  Nothing needs you right now. New drafts, decay alerts, and competitor moves
                  will show up here.
                </p>
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {attention.slice(0, 6).map((row, i) => (
                  <li
                    key={row.key}
                    className="widget-enter rounded-card border border-line bg-surface"
                    style={{ animationDelay: `${i * 45}ms` }}
                  >
                    <Link
                      href={row.href}
                      className="group flex items-center gap-3 px-4 py-3 transition-[background-color] duration-150 hover:bg-hover"
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-inset text-ink-2">
                        {row.icon}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-medium text-ink">
                          {row.title}
                        </span>
                        <span className="block truncate text-[12.5px] text-ink-2">{row.meta}</span>
                      </span>
                      <span className="shrink-0 text-[13px] font-medium text-accent-ink">
                        {row.cta}
                      </span>
                      <CaretRight className="size-4 shrink-0 text-ink-3 transition-transform duration-150 group-hover:translate-x-0.5" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Projects */}
          <section aria-labelledby="projects-h" id="new-project">
            <div className="mb-2 flex items-baseline justify-between">
              <h2 id="projects-h" className="text-[15px] font-semibold text-ink">
                Projects
              </h2>
              <span className="text-[12.5px] text-ink-3">
                {projects.length} project{projects.length === 1 ? "" : "s"} ·{" "}
                {totalKeywords} keywords · {totalContent} content pieces
              </span>
            </div>
            <Card>
              <CardBody className="p-0">
                {projects.length === 0 ? (
                  <EmptyState
                    icon={<Kanban className="size-5" weight="duotone" />}
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
                            className="group flex items-center justify-between gap-3 px-4 py-3.5 transition-[background-color] duration-150 hover:bg-hover"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[14px] font-medium text-ink">
                                {p.domain}
                              </span>
                              <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12.5px] text-ink-2">
                                <ValuePill>
                                  {p._count.keywords} keyword{p._count.keywords === 1 ? "" : "s"}
                                </ValuePill>
                                <ValuePill>
                                  {p._count.contentItems} content
                                </ValuePill>
                                <ValuePill>
                                  {p._count.workflows} automation{p._count.workflows === 1 ? "" : "s"}
                                </ValuePill>
                                <span className="text-ink-3">{p.locale}</span>
                              </span>
                            </span>
                            {score !== undefined ? (
                              <span
                                className={cn(
                                  "flex size-11 shrink-0 flex-col items-center justify-center rounded-card border border-line bg-inset",
                                )}
                                title={`Visibility score ${score}/100`}
                              >
                                <span className="text-[14px] font-semibold tabular-nums text-ink">
                                  {score}
                                </span>
                                <span className="text-[9.5px] leading-none text-ink-3">score</span>
                              </span>
                            ) : null}
                            <CaretRight className="size-4 shrink-0 text-ink-3 transition-transform duration-150 group-hover:translate-x-0.5" />
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
                <p className="px-2 py-1 text-[13px] text-ink-2">
                  You’re on top of everything. Check back after the next scheduled run.
                </p>
              ) : (
                suggestions.map((s, i) => (
                  <Link
                    key={i}
                    href={s.href}
                    className="group flex items-start gap-2.5 rounded-control px-2 py-2 transition-[background-color] duration-150 hover:bg-hover"
                  >
                    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-control bg-inset text-ink-2">
                      {s.icon}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13px] leading-snug text-ink-2">{s.text}</span>
                      <span className="mt-0.5 inline-block text-[13px] font-medium text-accent-ink">
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
