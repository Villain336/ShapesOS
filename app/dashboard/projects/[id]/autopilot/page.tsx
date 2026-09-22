// Marketr — content autopilot studio (milestone 18).
// Server page with a client studio island (rules, approval queue, activity,
// kill switch).

import { accessibleWorkspaceWhere, getMembership, requireProjectRole } from "@/lib/authz";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import AutopilotStudio from "@/components/AutopilotStudio";

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
        <Link href={`/dashboard/projects/${project.id}`} className="text-sm text-zinc-500 hover:text-zinc-600">
          ← {project.domain}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold text-zinc-900">Content autopilot</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Scheduled pipeline: source → AI draft → <span className="text-amber-700">your approval</span> → publish.
          Nothing publishes without passing the approval gate unless a rule explicitly opts in to auto-approve
          low-risk refreshes. The kill switch stops everything immediately.
        </p>
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
