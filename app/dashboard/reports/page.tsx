// Marketr — reports dashboard (milestone 12: white-label reporting).
// Template list, editorcn block-editor editing, on-demand generation, history.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import ReportsManager from "@/components/ReportsManager";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) redirect("/dashboard");

  const [templates, brandKits, projects] = await Promise.all([
    prisma.reportTemplate.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { updatedAt: "desc" },
      include: {
        brandKit: { select: { id: true, name: true } },
        project: { select: { id: true, domain: true } },
        _count: { select: { reports: true } },
      },
    }),
    prisma.brandKit.findMany({
      where: { workspaceId: workspace.id },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      select: { id: true, name: true },
    }),
    prisma.project.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { domain: "asc" },
      select: { id: true, domain: true },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink">Reports</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Editable templates, branded PDF generation, and schedules. A paragraph containing only{" "}
          <span className="font-mono text-zinc-500">{"{{rankings_table}}"}</span> becomes the keyword
          rankings table at generation time.
        </p>
      </div>
      <ReportsManager
        initialTemplates={templates.map((t) => ({
          id: t.id,
          name: t.name,
          type: t.type,
          content: t.content,
          brandKitId: t.brandKitId,
          projectId: t.projectId,
          schedule: t.schedule,
          lastRunAt: t.lastRunAt?.toISOString() ?? null,
          brandKit: t.brandKit,
          project: t.project,
          _count: t._count,
        }))}
        brandKits={brandKits}
        projects={projects}
      />
    </div>
  );
}
