// Marketr — project mission control: live vitals, redesigned Explore nav,
// visibility score, and keyword lists.

import Link from "next/link";
import {
  ArrowLeft,
  Rocket,
  CodeXml,
  Clock,
  Crosshair,
  FileText,
  Globe,
  Key,
  Layers,
  LinkIcon,
  ListChecks,
  Mail,
  MapPin,
  Megaphone,
  MessageCircle,
  Network,
  Palette,
  Target,
  Share2,
  Quote,
  TrendingDown,
  TrendingUp,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { accessibleWorkspaceWhere } from "@/lib/authz";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import DeleteProjectButton from "@/components/DeleteProjectButton";
import VisibilityScoreWidget from "@/components/VisibilityScoreWidget";
import { Stat } from "@/components/vault/Stat";
import { Card, CardBody, CardHeader } from "@/components/vault/Card";
import { EmptyState } from "@/components/vault/EmptyState";
import { ValuePill } from "@/components/vault/atoms/ValuePill";
import { buttonVariants } from "@/components/vault/atoms/button-variants";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

type ExploreLink = {
  href: string;
  label: string;
  description: string;
  icon: LucideIcon;
};

const EXPLORE_SECTIONS: { title: string; links: ExploreLink[] }[] = [
  {
    title: "Research",
    links: [
      { href: "keywords", label: "Keyword research", description: "Find terms worth ranking for", icon: Key },
      { href: "competitors", label: "Competitor gaps", description: "What rivals rank for that you don't", icon: Crosshair },
      { href: "rankings", label: "Rank tracking", description: "Watch positions move day by day", icon: TrendingUp },
      { href: "ai-search", label: "AI search", description: "Track citations in AI answers", icon: Quote },
      { href: "radar", label: "Competitor radar", description: "Get alerted when rivals move", icon: Target },
      { href: "backlinks", label: "Backlinks", description: "Links pointing at your domain", icon: LinkIcon },
    ],
  },
  {
    title: "Content",
    links: [
      { href: "content", label: "Content engine", description: "Briefs, drafts, and published pieces", icon: FileText },
      { href: "decay", label: "Content decay", description: "Pages losing traffic, and why", icon: TrendingDown },
      { href: "autopilot", label: "Content autopilot", description: "Supervised runs that refresh and fix", icon: Rocket },
      { href: "newsletter", label: "Newsletter", description: "Broadcasts and subscriber lists", icon: Mail },
      { href: "social", label: "Social", description: "Scheduled posts across channels", icon: Share2 },
    ],
  },
  {
    title: "Sites",
    links: [
      { href: "ide", label: "Site IDE", description: "Edit and deploy your site", icon: CodeXml },
      { href: "sites", label: "Sites & landing pages", description: "Pages hosted by Marketr", icon: Globe },
      { href: "programmatic", label: "Programmatic SEO", description: "Template-driven pages at scale", icon: Layers },
      { href: "local", label: "Local SEO", description: "Grid rankings and reviews", icon: MapPin },
      { href: "internal-links", label: "Internal links", description: "Suggested links between your pages", icon: Network },
    ],
  },
  {
    title: "Automate",
    links: [
      { href: "automations", label: "Automations", description: "Workflows that run on a schedule", icon: Zap },
      { href: "automations/schedules", label: "Scheduled skills", description: "Cron & event runs with parallel subagents", icon: Clock },
      { href: "chat", label: "Chat", description: "Ask AI, or message your team", icon: MessageCircle },
      { href: "ads", label: "Ad factory", description: "Campaigns and creatives", icon: Megaphone },
      { href: "studio", label: "Studio", description: "Brand assets and domains", icon: Palette },
    ],
  },
];

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  if (!user) return null; // layout already redirects
  const { id } = await params;

  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
    include: {
      keywords: { orderBy: [{ list: "asc" }, { volume: "desc" }] },
      competitors: { select: { id: true } },
      contentItems: { select: { id: true } },
      siteConnections: { select: { id: true } },
      _count: { select: { keywords: { where: { tracked: true } } } },
    },
  });
  if (!project) notFound();

  const trackedCount = project._count.keywords;

  const lists = new Map<string, number>();
  for (const k of project.keywords) {
    lists.set(k.list ?? "Saved keywords", (lists.get(k.list ?? "Saved keywords") ?? 0) + 1);
  }

  const base = `/dashboard/projects/${project.id}`;

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/dashboard"
        className={cn(buttonVariants({ variant: "quiet", size: "xs" }), "self-start")}
      >
        <ArrowLeft className="size-3.5" />
        Overview
      </Link>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink">
            {project.domain}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-ink-2">
            <span>{project.locale}</span>
            <span aria-hidden className="text-ink-3">·</span>
            <ValuePill>
              {project.siteConnections.length} site connection
              {project.siteConnections.length === 1 ? "" : "s"}
            </ValuePill>
          </p>
        </div>
        <DeleteProjectButton projectId={project.id} />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Keywords saved" value={project.keywords.length} icon={<Key className="size-4" />} />
        <Stat label="Tracked" value={trackedCount} icon={<TrendingUp className="size-4" />} />
        <Stat label="Competitors" value={project.competitors.length} icon={<Crosshair className="size-4" />} />
        <Stat label="Content items" value={project.contentItems.length} icon={<FileText className="size-4" />} />
      </div>

      <VisibilityScoreWidget projectId={project.id} />

      <Card>
        <CardHeader title="Explore" description="Every workspace for this project" />
        <CardBody className="grid gap-6 p-4 sm:grid-cols-2">
          {EXPLORE_SECTIONS.map((section) => (
            <div key={section.title}>
              <div className="mb-1.5 px-2 text-[12.5px] font-medium text-ink-3">
                {section.title}
              </div>
              <ul className="flex flex-col">
                {section.links.map((link) => {
                  const Icon = link.icon;
                  return (
                    <li key={link.href}>
                      <Link
                        href={`${base}/${link.href}`}
                        className="group flex items-center gap-3 rounded-control px-2 py-2 transition-[background-color] duration-150 hover:bg-hover"
                      >
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-inset text-ink-2">
                          <Icon className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13.5px] font-medium text-ink">
                            {link.label}
                          </span>
                          <span className="block truncate text-[12px] text-ink-3">
                            {link.description}
                          </span>
                        </span>
                        <span
                          aria-hidden
                          className="size-1.5 shrink-0 rounded-full bg-line-strong opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                        />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Keyword lists" description="Saved keyword collections for this project" />
        <CardBody className="p-0">
          {lists.size === 0 ? (
            <EmptyState
              icon={<ListChecks className="size-5" />}
              title="Nothing saved yet"
              description="Run keyword research and save winners to a list."
              action={
                <Link href={`${base}/keywords`} className={buttonVariants({ variant: "accent", size: "sm" })}>
                  <Key className="size-3.5" />
                  Start keyword research
                </Link>
              }
            />
          ) : (
            <ul className="flex flex-col">
              {[...lists.entries()].map(([name, count]) => (
                <li
                  key={name}
                  className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-b-0"
                >
                  <span className="truncate text-[14px] font-medium text-ink">{name}</span>
                  <ValuePill>
                    {count} keyword{count === 1 ? "" : "s"}
                  </ValuePill>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
