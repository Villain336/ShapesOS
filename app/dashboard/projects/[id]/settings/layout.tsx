// Marketr — project settings tab shell (milestone 21, part D2).
// Server: resolve the project, gate viewer+ for read, pass canEdit
// (editor+) to the tab nav so mutating forms can disable themselves.
// The API routes enforce roles for real; this is the UI affordance.

import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/vault/PageHeader";
import { accessibleWorkspaceWhere, requireProjectRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import SettingsTabs from "./SettingsTabs";

export const dynamic = "force-dynamic";

export default async function ProjectSettingsLayout({
  params,
  children,
}: {
  params: Promise<{ id: string }>;
  children: React.ReactNode;
}) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const { id } = await params;

  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true, domain: true },
  });
  if (!project) notFound();
  if (!(await requireProjectRole(user.id, project.id, "viewer"))) redirect("/dashboard");

  const canEdit = (await requireProjectRole(user.id, project.id, "editor")) !== null;

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={`/dashboard/projects/${project.id}`}
        className="inline-flex items-center gap-1.5 self-start text-[0.8125rem] text-ink-2 transition-colors hover:text-ink"
      >
        <ArrowLeft className="size-3.5" />
        {project.domain}
      </Link>

      <PageHeader
        title="Project settings"
        description="Workspace defaults apply unless this project overrides them."
      />

      <SettingsTabs projectId={project.id} />

      {!canEdit && (
        <p className="rounded-control bg-inset px-3 py-2 text-[0.78125rem] text-ink-2">
          You have viewer access — settings are read-only. Ask an editor to make
          changes.
        </p>
      )}

      <div className="min-w-0">{children}</div>
    </div>
  );
}
