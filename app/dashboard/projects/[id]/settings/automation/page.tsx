// Marketr — project settings: Automation (milestone 21, part D2).
// Server: the project's approvalModeOverride (null = inherit the workspace
// default) plus the workspace default for the inherited label.

import { redirect, notFound } from "next/navigation";
import { Card, CardBody, CardHeader } from "@/components/vault/Card";
import { accessibleWorkspaceWhere, requireProjectRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import AutomationClient from "./AutomationClient";

export const dynamic = "force-dynamic";

export default async function AutomationSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const { id } = await params;

  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true, workspaceId: true },
  });
  if (!project) notFound();
  if (!(await requireProjectRole(user.id, project.id, "viewer"))) redirect("/dashboard");
  const canEdit = (await requireProjectRole(user.id, project.id, "editor")) !== null;

  const [projectSettings, workspaceSettings] = await Promise.all([
    prisma.projectSettings.findUnique({
      where: { projectId: project.id },
      select: { approvalModeOverride: true },
    }),
    prisma.workspaceSettings.findUnique({
      where: { workspaceId: project.workspaceId },
      select: { defaultApprovalMode: true },
    }),
  ]);

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <Card>
        <CardHeader
          title="Approval mode"
          description="How much ShapesOS may act on its own in this project"
        />
        <CardBody>
          <AutomationClient
            projectId={project.id}
            canEdit={canEdit}
            initialOverride={projectSettings?.approvalModeOverride ?? null}
            workspaceDefault={workspaceSettings?.defaultApprovalMode ?? "supervised"}
          />
        </CardBody>
      </Card>
    </div>
  );
}
