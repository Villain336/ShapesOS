// Marketr — sites list page (milestone 7).

import { accessibleWorkspaceWhere } from "@/lib/authz";
import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import SitesManager from "@/components/SitesManager";
import HostingManager from "@/components/HostingManager";
import FixAgentManager from "@/components/FixAgentManager";

export const dynamic = "force-dynamic";

export default async function SitesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  if (!user) return null; // layout already redirects
  const { id } = await params;

  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
  });
  if (!project) notFound();

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href={`/dashboard/projects/${project.id}`} className="text-sm text-zinc-500 hover:text-zinc-300">
          ← {project.domain}
        </Link>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Sites & landing pages</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Build landing pages from scratch, or connect a GitHub repo, WordPress, Webflow, SFTP host, or uploaded .zip — then edit, deploy, or publish content.
        </p>
      </div>
      <SitesManager projectId={project.id} />
      <HostingManager projectId={project.id} />
      <FixAgentManager projectId={project.id} />
    </div>
  );
}
