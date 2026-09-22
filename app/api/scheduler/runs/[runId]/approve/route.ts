// Marketr — supervised run approval API (Phase B, W2).
// POST /api/scheduler/runs/[runId]/approve { workspaceId } → { run }
//   (skills.install grant or admin+; executes the run). Audited.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { requirePermission, forbidden } from "@/lib/authz";
import { workspaceIdFrom, notFound, requireWorkspaceAccess } from "@/lib/route-utils";
import { validateBody, z } from "@/lib/api/validate";
import { readJsonBody } from "@/lib/sitefiles/api";
import { approveRun, ScheduleServiceError } from "@/lib/scheduler/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ runId: string }> };

const BodySchema = z.object({
  workspaceId: z.string().trim().max(120).optional(),
});

export async function POST(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { runId } = await params;
  const body = await readJsonBody(req);
  const validated = validateBody(BodySchema, body);
  if (!validated.ok) return validated.error;
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req, validated.data), "viewer");
  if ("error" in access) return access.error;
  if (!(await requirePermission(user.id, access.workspaceId, "skills.install"))) {
    return forbidden("skills.install permission required to approve runs.");
  }

  try {
    const id = await approveRun(prisma, runId, access.workspaceId, user.id);
    const run = await prisma.skillRun.findUnique({ where: { id } });
    return Response.json({ run });
  } catch (err) {
    if (err instanceof ScheduleServiceError) return notFound(err.message);
    throw err;
  }
}
