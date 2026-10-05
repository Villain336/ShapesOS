// Marketr — schedule runs API (Phase B, W2).
// GET  /api/schedules/[id]/runs?workspaceId=  → { runs } (viewer+)
// POST /api/schedules/[id]/runs { workspaceId } → { run } manual trigger
//   (same grants as create/edit; supervised schedules produce an
//   awaiting_approval run, never an immediate execution).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { requirePermission, forbidden } from "@/lib/authz";
import { workspaceIdFrom, notFound, requireWorkspaceAccess, requireProjectAccess } from "@/lib/route-utils";
import { validateBody, z, intQuery, parseQuery } from "@/lib/api/validate";
import { readJsonBody } from "@/lib/sitefiles/api";
import { triggerManual, ScheduleServiceError } from "@/lib/scheduler/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const TriggerSchema = z.object({
  workspaceId: z.string().trim().max(120).optional(),
});

async function authorize(userId: string, workspaceId: string, scheduleId: string) {
  const schedule = await prisma.scheduledSkill.findFirst({
    where: { id: scheduleId, workspaceId },
    select: { id: true, projectId: true },
  });
  if (!schedule) return { error: notFound("Schedule not found") } as const;
  if (schedule.projectId) {
    const proj = await requireProjectAccess(userId, schedule.projectId, "editor");
    if ("error" in proj) return { error: proj.error } as const;
  } else if (!(await requirePermission(userId, workspaceId, "skills.install"))) {
    return { error: forbidden("skills.install permission required.") } as const;
  }
  return { schedule };
}

export async function GET(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "viewer");
  if ("error" in access) return access.error;
  const auth = await authorize(user.id, access.workspaceId, id);
  if ("error" in auth) return auth.error;

  const q = req.nextUrl.searchParams;
  const takeQuery = parseQuery(z.object({ take: intQuery(50, 1, 200) }), q);
  if (!takeQuery.ok) return takeQuery.error;
  const take = takeQuery.data.take;
  const runs = await prisma.skillRun.findMany({
    where: { scheduleId: id, workspaceId: access.workspaceId },
    orderBy: { startedAt: "desc" },
    take,
    include: { _count: { select: { subagents: true } } },
  });
  return Response.json({ runs });
}

export async function POST(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await readJsonBody(req);
  const validated = validateBody(TriggerSchema, body);
  if (!validated.ok) return validated.error;
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req, validated.data), "viewer");
  if ("error" in access) return access.error;
  const auth = await authorize(user.id, access.workspaceId, id);
  if ("error" in auth) return auth.error;

  try {
    const result = await triggerManual(prisma, id, access.workspaceId, user.id);
    if (!result.fired) {
      return Response.json({ error: result.blockedReason ?? "Trigger blocked" }, { status: 429 });
    }
    const run = await prisma.skillRun.findUnique({ where: { id: result.runId } });
    return Response.json({ run, awaitingApproval: result.awaitingApproval ?? false }, { status: 201 });
  } catch (err) {
    if (err instanceof ScheduleServiceError) return notFound(err.message);
    throw err;
  }
}
