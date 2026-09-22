// Marketr — project settings: General (milestone 21, part D2).
// Server: project.domain + project.locale are read-only facts from the
// Project row; brandContext/domains come from ProjectSettings (may be null
// = inherited/default). Mutations go through the settings API.

import { redirect, notFound } from "next/navigation";
import { Card, CardBody, CardHeader } from "@/components/vault/Card";
import { accessibleWorkspaceWhere, requireProjectRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import GeneralForm from "./GeneralForm";

export const dynamic = "force-dynamic";

export default async function GeneralSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const { id } = await params;

  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true, domain: true, locale: true },
  });
  if (!project) notFound();
  if (!(await requireProjectRole(user.id, project.id, "viewer"))) redirect("/dashboard");
  const canEdit = (await requireProjectRole(user.id, project.id, "editor")) !== null;

  const settings = await prisma.projectSettings.findUnique({
    where: { projectId: project.id },
    select: { brandContext: true, domains: true },
  });

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <Card>
        <CardHeader
          title="Project identity"
          description="Read-only facts about this project"
        />
        <CardBody className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-ink-2">Domain</span>
            <span className="text-[13.5px] font-medium text-ink">{project.domain}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-ink-2">Locale</span>
            <span className="text-[13.5px] font-medium text-ink">{project.locale}</span>
          </div>
        </CardBody>
      </Card>

      <GeneralForm
        projectId={project.id}
        canEdit={canEdit}
        initialBrandContext={settings?.brandContext ?? null}
        initialDomains={settings?.domains ?? []}
      />
    </div>
  );
}
