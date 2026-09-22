// Marketr — project detail: saved-keyword overview + entry points.

import Link from "next/link";
import {
  ArrowLeft,
  Bot,
  Code2,
  Crosshair,
  FileText,
  Globe,
  KeyRound,
  Layers,
  Link2,
  ListChecks,
  Mail,
  MapPin,
  Megaphone,
  MessageSquare,
  Network,
  Palette,
  Radar,
  Share2,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Zap,
} from "lucide-react";
import { accessibleWorkspaceWhere } from "@/lib/authz";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import DeleteProjectButton from "@/components/DeleteProjectButton";
import VisibilityScoreWidget from "@/components/VisibilityScoreWidget";
import { PageHeader } from "@/components/vault/PageHeader";
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
  icon: React.ComponentType<{ className?: string }>;
  primary?: boolean;
};

const EXPLORE_SECTIONS: { title: string; links: ExploreLink[] }[] = [
  {
    title: "Research",
    links: [
      { href: "keywords", label: "Keyword research", icon: KeyRound, primary: true },
      { href: "competitors", label: "Competitor gaps", icon: Crosshair },
      { href: "rankings", label: "Rank tracking", icon: TrendingUp },
      { href: "ai-search", label: "AI search", icon: Sparkles },
      { href: "radar", label: "Competitor radar", icon: Radar },
      { href: "backlinks", label: "Backlinks", icon: Link2 },
    ],
  },
  {
    title: "Content",
    links: [
      { href: "content", label: "Content engine", icon: FileText },
      { href: "decay", label: "Content decay", icon: TrendingDown },
      { href: "autopilot", label: "Content autopilot", icon: Bot },
      { href: "newsletter", label: "Newsletter", icon: Mail },
      { href: "social", label: "Social", icon: Share2 },
    ],
  },
  {
    title: "Sites",
    links: [
      { href: "ide", label: "Site IDE", icon: Code2 },
      { href: "sites", label: "Sites & landing pages", icon: Globe },
      { href: "programmatic", label: "Programmatic SEO", icon: Layers },
      { href: "local", label: "Local SEO", icon: MapPin },
      { href: "internal-links", label: "Internal links", icon: Network },
    ],
  },
  {
    title: "Automate",
    links: [
      { href: "automations", label: "Automations", icon: Zap },
      { href: "chat", label: "Chat", icon: MessageSquare },
      { href: "ads", label: "Ad factory", icon: Megaphone },
      { href: "studio", label: "Studio", icon: Palette },
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
        Projects
      </Link>

      <PageHeader
        title={project.domain}
        description={
          <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
            {project.locale}
            <span aria-hidden>·</span>
            <ValuePill>
              {project.siteConnections.length} site connection
              {project.siteConnections.length === 1 ? "" : "s"}
            </ValuePill>
          </span>
        }
        actions={<DeleteProjectButton projectId={project.id} />}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Keywords saved" value={project.keywords.length} icon={<KeyRound className="size-4" />} />
        <Stat
          label="Tracked"
          value={trackedCount}
          icon={<TrendingUp className="size-4" />}
        />
        <Stat
          label="Competitors"
          value={project.competitors.length}
          icon={<Crosshair className="size-4" />}
        />
        <Stat
          label="Content items"
          value={project.contentItems.length}
          icon={<FileText className="size-4" />}
        />
      </div>

      <Card>
        <CardHeader title="Explore" description="Jump into a workspace for this project" />
        <CardBody className="flex flex-col gap-5">
          {EXPLORE_SECTIONS.map((section) => (
            <div key={section.title}>
              <div className="mb-2 text-[11px] font-medium uppercase tracking-widest text-ink-3">
                {section.title}
              </div>
              <div className="flex flex-wrap gap-2">
                {section.links.map((link) => {
                  const Icon = link.icon;
                  return (
                    <Link
                      key={link.href}
                      href={`${base}/${link.href}`}
                      className={buttonVariants({
                        variant: link.primary ? "accent" : "secondary",
                        size: "sm",
                      })}
                    >
                      <Icon className="size-3.5" />
                      {link.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </CardBody>
      </Card>

      <VisibilityScoreWidget projectId={project.id} />

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
                  <KeyRound className="size-3.5" />
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
