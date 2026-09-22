// Marketr — skill re-pin (milestone 21, spec §5 flow 2).
// POST /api/skills/[id]/repin { workspaceId } → { skill }
// Re-resolves the pinned commit SHA via previewFromUrl(sourceRef).
// Admin+ or skills.install grant. Audited (skill_installed, "re-pinned").

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { requirePermission, forbidden } from "@/lib/authz";
import { workspaceIdFrom, badRequest, notFound, publicSkill } from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";
import { readJsonBody } from "@/lib/sitefiles/api";
import { validateBody, z } from "@/lib/api/validate";
import { previewFromUrl, SkillImportError } from "@/lib/skills/importer";
import { getSkill } from "@/lib/skills/service";

export const dynamic = "force-dynamic";

// workspaceId may also arrive via ?workspaceId= (see workspaceIdFrom), so the
// schema only enforces type/shape here; presence is checked below.
const BodySchema = z.object({
  workspaceId: z.string().trim().max(120).optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await readJsonBody(req);
  const v = validateBody(BodySchema, body);
  if (!v.ok) return v.error;
  const workspaceId = workspaceIdFrom(req, v.data);
  if (!workspaceId) return badRequest("workspaceId is required");
  if (!(await requirePermission(user.id, workspaceId, "skills.install"))) {
    return forbidden("skills.install permission required.");
  }

  const skill = await getSkill(prisma, workspaceId, id);
  if (!skill) return notFound("Skill not found");
  if (skill.source !== "url" || !skill.sourceRef) {
    return badRequest("Only URL-installed skills can be re-pinned");
  }
  try {
    const preview = await previewFromUrl(skill.sourceRef);
    if (!preview.sha) {
      return Response.json(
        { error: "Could not resolve the current commit SHA — re-pin aborted", warnings: preview.warnings },
        { status: 409 },
      );
    }
    const updated = await prisma.skill.update({
      where: { id: skill.id },
      data: { shaPin: preview.sha },
    });
    await auditEvent({
      projectId: null,
      workspaceId,
      action: "skill_installed",
      summary: `Re-pinned skill "${skill.name}" to ${preview.sha.slice(0, 12)}`,
      actorUserId: user.id,
    });
    return Response.json({ skill: publicSkill(updated) });
  } catch (err) {
    if (err instanceof SkillImportError) return badRequest(err.message);
    throw err;
  }
}
