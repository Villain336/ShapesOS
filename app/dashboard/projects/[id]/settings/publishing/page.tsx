// Marketr — project settings: Publishing (milestone 21, part D2).
// Server: the project's publishingControls JSON (absent keys = disallowed).

import { redirect, notFound } from "next/navigation";
import { Card, CardBody, CardHeader } from "@/components/vault/Card";
import { accessibleWorkspaceWhere, requireProjectRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import PublishingClient from "./PublishingClient";

export const dynamic = "force-dynamic";

export default async function PublishingSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const { id } = await params;

  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true },
  });
  if (!project) notFound();
  if (!(await requireProjectRole(user.id, project.id, "viewer"))) redirect("/dashboard");
  const canEdit = (await requireProjectRole(user.id, project.id, "editor")) !== null;

  const settings = await prisma.projectSettings.findUnique({
    where: { projectId: project.id },
    select: { publishingControls: true },
  });

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <Card>
        <CardHeader
          title="Publishing controls"
          description="Which destinations ShapesOS may publish to for this project"
        />
        <CardBody>
          <PublishingClient
            projectId={project.id}
            canEdit={canEdit}
            initialControls={
              (settings?.publishingControls as Record<string, boolean> | null) ?? {}
            }
          />
        </CardBody>
      </Card>
    </div>
  );
}
