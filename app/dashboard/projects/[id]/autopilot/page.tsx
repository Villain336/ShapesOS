// Marketr — content autopilot studio (milestone 18).
// Server page with a client studio island (rules, approval queue, activity,
// kill switch).

import { accessibleWorkspaceWhere, getMembership, requireProjectRole } from "@/lib/authz";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import AutopilotStudio from "@/components/AutopilotStudio";
import { ValuePill } from "@/components/vault/atoms/ValuePill";
import {
  ArrowLeft,
  Activity as ActivityIcon,
} from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AutopilotPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return null;
  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true, workspaceId: true, domain: true },
  });
  if (!project) notFound();

  const membership = await getMembership(user.id, project.workspaceId);
  const canEdit = await requireProjectRole(user.id, project.id, "editor");
  const isAdmin = !!membership && (membership.role === "owner" || membership.role === "admin");

  const [rules, templates, sites, kill] = await Promise.all([
    prisma.autopilotRule.findMany({
      where: { projectId: project.id },
      orderBy: { updatedAt: "desc" },
      include: { _count: { select: { items: true } } },
    }),
    prisma.programmaticTemplate.findMany({
      where: { projectId: project.id },
      orderBy: { updatedAt: "desc" },
      select: { id: true, name: true },
    }),
    prisma.site.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, sourceType: true },
    }),
    prisma.autopilotKillSwitch.findMany({
      where: {
        scopeKey: { in: [`workspace:${project.workspaceId}`, `project:${project.id}`] },
      },
    }),
  ]);

  const serializedRules = rules.map((r) => ({
    ...r,
    source: r.source as string,
    cadence: r.cadence as string,
    programmaticTemplateId: r.programmaticTemplateId,
    lastRunAt: r.lastRunAt?.toISOString() ?? null,
    publishTarget:
      r.publishTarget && typeof r.publishTarget === "object" && !Array.isArray(r.publishTarget)
        ? (r.publishTarget as { kind?: string; siteId?: string | null })
        : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href={`/dashboard/projects/${project.id}`}
          className="inline-flex items-center gap-1 text-[13px] text-ink-3 hover:text-ink-2"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {project.domain}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-card bg-ink text-page">
            <ActivityIcon className="size-5" />
          </span>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-ink">
              Content autopilot
            </h1>
            <p className="mt-0.5 text-[13.5px] text-ink-2">
              Scheduled pipeline: source → AI draft → <ValuePill tone="orange">your approval</ValuePill> → publish.
              Nothing publishes without passing the approval gate unless a rule explicitly opts in to auto-approve
              low-risk refreshes. The kill switch stops everything immediately.
            </p>
          </div>
        </div>
      </div>
      <AutopilotStudio
        projectId={project.id}
        canEdit={!!canEdit}
        isAdmin={isAdmin}
        initialRules={serializedRules}
        templates={templates}
        sites={sites}
        initialKill={kill}
      />
    </div>
  );
}
