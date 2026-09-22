// Marketr — per-project skill enable/disable (milestone 21, spec §5 flow 1).
// GET /api/projects/[id]/skills → { skills: [{ ...skill, enabled }] } (viewer+)
// PUT /api/projects/[id]/skills { skillId, enabled } → { ok } (editor+; audited)

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { badRequest, requireProjectAccess, publicSkill } from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";
import { readJsonBody } from "@/lib/sitefiles/api";
import { validateBody, z, boundedString } from "@/lib/api/validate";
import {
  getSkill,
  setProjectSkillEnabled,
  SkillServiceError,
} from "@/lib/skills/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id: projectId } = await params;
  const access = await requireProjectAccess(user.id, projectId, "viewer");
  if ("error" in access) return access.error;

  const [skills, enabled] = await Promise.all([
    prisma.skill.findMany({
      where: { workspaceId: access.project.workspaceId },
      orderBy: { name: "asc" },
    }),
    prisma.projectSkill.findMany({
      where: { projectId, enabled: true },
      select: { skillId: true },
    }),
  ]);
  const enabledIds = new Set(enabled.map((e) => e.skillId));
  return Response.json({
    skills: skills.map((s) => ({ ...publicSkill(s), enabled: enabledIds.has(s.id) })),
  });
}

const BodySchema = z.object({
  skillId: boundedString(120, "skillId"),
  enabled: z.boolean({ error: "enabled must be a boolean" }),
});

export async function PUT(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id: projectId } = await params;
  const access = await requireProjectAccess(user.id, projectId, "editor");
  if ("error" in access) return access.error;

  const rawBody = await readJsonBody(req);
  const v = validateBody(BodySchema, rawBody);
  if (!v.ok) return v.error;
  const { skillId, enabled } = v.data;

  try {
    await setProjectSkillEnabled(prisma, projectId, skillId, enabled, user.id);
  } catch (err) {
    if (err instanceof SkillServiceError) return badRequest(err.message);
    throw err;
  }
  const skill = await getSkill(prisma, access.project.workspaceId, skillId);
  await auditEvent({
    projectId,
    workspaceId: access.project.workspaceId,
    action: enabled ? "skill_enabled" : "skill_disabled",
    summary: `${enabled ? "Enabled" : "Disabled"} skill "${skill?.name ?? skillId}" for project`,
    actorUserId: user.id,
  });
  return Response.json({ ok: true });
}
