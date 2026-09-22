// Marketr — project settings: Skills (milestone 21, part D2).
// Server: list the workspace's installed skills plus this project's
// enablement map. Client toggles via PUT /api/projects/[id]/skills.

import { redirect, notFound } from "next/navigation";
import { Card, CardBody, CardHeader } from "@/components/vault/Card";
import { EmptyState } from "@/components/vault/EmptyState";
import { ListChecks } from "@/components/vault/phosphor";
import { accessibleWorkspaceWhere, requireProjectRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import SkillsClient from "./SkillsClient";

export const dynamic = "force-dynamic";

export default async function SkillsSettingsPage({
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

  const skills = await prisma.skill.findMany({
    where: { workspaceId: project.workspaceId },
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      version: true,
      trustTier: true,
    },
    orderBy: { name: "asc" },
  });
  const projectSkills = await prisma.projectSkill.findMany({
    where: { projectId: project.id },
    select: { skillId: true, enabled: true },
  });
  const enabledById = new Map(projectSkills.map((ps) => [ps.skillId, ps.enabled]));

  const initial = skills.map((s) => ({
    id: s.id,
    name: s.name,
    slug: s.slug,
    description: s.description,
    version: s.version,
    trustTier: String(s.trustTier),
    enabled: enabledById.get(s.id) ?? false,
  }));

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <Card>
        <CardHeader
          title="Project skills"
          description="Skills installed in the workspace — enable the ones this project should use"
        />
        <CardBody>
          {initial.length === 0 ? (
            <EmptyState
              icon={<ListChecks className="size-5" weight="duotone" />}
              title="No skills installed"
              description="Install skills from the workspace Skills settings first, then enable them here per project."
            />
          ) : (
            <SkillsClient
              projectId={project.id}
              canEdit={canEdit}
              initialSkills={initial}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
