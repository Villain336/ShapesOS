// Marketr — skills library: workspace/project skill management service
// (spec §6 data model, §7 MVP scope: per-project enable/disable).
// All functions take the Prisma client (or a test fake) as the first
// argument, following the repo's service convention.

import type { PrismaClient, Skill } from "@prisma/client";

/** Thrown for service-level failures (not found, cross-workspace). */
export class SkillServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillServiceError";
  }
}

/** Every skill installed in a workspace, ordered by name. */
export async function listSkills(db: PrismaClient, workspaceId: string): Promise<Skill[]> {
  return db.skill.findMany({ where: { workspaceId }, orderBy: { name: "asc" } });
}

/** One skill by id, scoped to the workspace. Null when absent. */
export async function getSkill(
  db: PrismaClient,
  workspaceId: string,
  id: string,
): Promise<Skill | null> {
  return db.skill.findFirst({ where: { id, workspaceId } });
}

/**
 * Uninstall a skill: deletes the skill row and all of its ProjectSkill
 * rows. Returns the deleted row for the audit log. Throws SkillServiceError
 * when the skill does not exist in this workspace.
 */
export async function uninstallSkill(
  db: PrismaClient,
  workspaceId: string,
  id: string,
  actorId: string | null,
): Promise<Skill> {
  const skill = await db.skill.findFirst({ where: { id, workspaceId } });
  if (!skill) {
    throw new SkillServiceError(`skill not found in workspace: ${id}`);
  }
  await db.projectSkill.deleteMany({ where: { skillId: id } });
  await db.skill.delete({ where: { id } });
  void actorId; // audit logging is owned by the route layer (spec §7).
  return skill;
}

/**
 * Enable or disable a skill for a project (upsert). The skill must belong
 * to the project's workspace — cross-workspace binds are rejected loudly.
 */
export async function setProjectSkillEnabled(
  db: PrismaClient,
  projectId: string,
  skillId: string,
  enabled: boolean,
  actorId: string | null,
) {
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) {
    throw new SkillServiceError(`project not found: ${projectId}`);
  }
  const skill = await db.skill.findUnique({ where: { id: skillId } });
  if (!skill) {
    throw new SkillServiceError(`skill not found: ${skillId}`);
  }
  if (skill.workspaceId !== project.workspaceId) {
    throw new SkillServiceError(
      `cross-workspace skill bind rejected: skill ${skillId} belongs to workspace ${skill.workspaceId}, project ${projectId} belongs to workspace ${project.workspaceId}`,
    );
  }
  return db.projectSkill.upsert({
    where: { projectId_skillId: { projectId, skillId } },
    create: { projectId, skillId, enabled, enabledBy: actorId },
    update: { enabled, enabledBy: actorId },
  });
}

/** Enabled skills for a project, ordered by name (for prompt injection). */
export async function getEnabledProjectSkills(
  db: PrismaClient,
  projectId: string,
): Promise<Skill[]> {
  const rows = await db.projectSkill.findMany({
    where: { projectId, enabled: true },
    include: { skill: true },
    orderBy: { skill: { name: "asc" } },
  });
  return rows.map((r) => r.skill);
}
