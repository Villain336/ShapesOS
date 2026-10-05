// Marketr — programmatic SEO studio (milestone 17).
// Server page with a client studio island (templates, datasets, pages).

import { accessibleWorkspaceWhere, requireProjectRole } from "@/lib/authz";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import ProgrammaticStudio from "@/components/ProgrammaticStudio";

export const dynamic = "force-dynamic";

export default async function ProgrammaticPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return null;
  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true, workspaceId: true, domain: true },
  });
  if (!project) notFound();

  const canEdit = await requireProjectRole(user.id, project.id, "editor");

  const [templates, datasets, pageCounts] = await Promise.all([
    prisma.programmaticTemplate.findMany({
      where: { projectId: project.id },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.programmaticDataset.findMany({
      where: { projectId: project.id },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true, name: true, schema: true, rowCount: true, columnMapping: true,
        createdAt: true, updatedAt: true,
      },
    }),
    prisma.programmaticPage.groupBy({
      by: ["status"],
      where: { projectId: project.id },
      _count: true,
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/dashboard/projects/${project.id}`} className="text-sm text-muted hover:text-ink">
          ← {project.domain}
        </Link>
        <h1 className="mt-1 text-xl font-heading tracking-heading stretch-heading text-ink">Programmatic SEO</h1>
        <p className="mt-1 text-sm text-muted">
          Templates × datasets → hundreds of pages. Preview first, then generate, review, and publish.
          Quality gates run server-side on approve and publish.
        </p>
      </div>
      <ProgrammaticStudio
        projectId={project.id}
        canEdit={Boolean(canEdit)}
        initialTemplates={JSON.parse(JSON.stringify(templates))}
        initialDatasets={JSON.parse(JSON.stringify(datasets))}
        initialCounts={Object.fromEntries(pageCounts.map((c) => [c.status, c._count]))}
      />
    </div>
  );
}
