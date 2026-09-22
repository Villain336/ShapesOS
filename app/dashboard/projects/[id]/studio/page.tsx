// Marketr — marketing studio: Canva Connect + Porkbun domains + asset library (milestone 22).
// Server page with a client studio island (Canva, Domains, Assets tabs).

import { accessibleWorkspaceWhere, getMembership, requireProjectRole } from "@/lib/authz";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import StudioStudio from "@/components/StudioStudio";

export const dynamic = "force-dynamic";

export default async function StudioPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return null;
  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true, workspaceId: true, domain: true },
  });
  if (!project) notFound();

  const canEdit = !!(await requireProjectRole(user.id, project.id, "editor"));
  const membership = await getMembership(user.id, project.workspaceId);
  const isOwnerAdmin = !!membership && ["owner", "admin"].includes(membership.role);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <Link href={`/dashboard/projects/${project.id}`} className="text-sm text-zinc-500 hover:text-zinc-600">
          ← {project.domain}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-900">Marketing studio</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Canva designs, domain purchasing, and a shared asset library.
        </p>
      </div>
      <StudioStudio
        projectId={project.id}
        workspaceId={project.workspaceId}
        canEdit={canEdit}
        isOwnerAdmin={isOwnerAdmin}
      />
    </div>
  );
}
