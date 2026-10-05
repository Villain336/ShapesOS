// Marketr — schedule detail API (Phase B, W2).
// GET    /api/schedules/[id]?workspaceId=          → { schedule, recentRuns } (viewer+)
// PATCH  /api/schedules/[id] { workspaceId, ... }  → { schedule } (same grants as create)
// DELETE /api/schedules/[id]?workspaceId=          → { ok } (same grants as create; audited)

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { requirePermission, forbidden } from "@/lib/authz";
import { workspaceIdFrom, badRequest, notFound, requireWorkspaceAccess, requireProjectAccess } from "@/lib/route-utils";
import { validateBody, z } from "@/lib/api/validate";
import { readJsonBody } from "@/lib/sitefiles/api";
import {
  updateSchedule,
  deleteSchedule,
  ScheduleServiceError,
  CronParseError,
} from "@/lib/scheduler/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const UpdateScheduleSchema = z.object({
  workspaceId: z.string().trim().max(120).optional(),
  cronExpr: z.string().trim().max(100).nullable().optional(),
  // IANA zone (cron schedules); null/blank resets to UTC; validated by the service.
  timezone: z.string().trim().max(64).nullable().optional(),
  eventSource: z.string().trim().max(60).nullable().optional(),
  eventConfig: z.record(z.string(), z.unknown()).nullable().optional(),
  approvalMode: z.enum(["supervised", "scheduled", "autopilot"]).optional(),
  concurrencyLimit: z.number().int().min(1).max(16).optional(),
  status: z.enum(["active", "paused"]).optional(),
});

/** Load the schedule scoped to the caller's workspace, then apply the same
 *  create-grants: project editor+ for project-scoped, skills.install/admin+
 *  for workspace-wide. Cross-workspace ids → 404 (no existence oracle). */
async function authorizeMutation(userId: string, workspaceId: string, scheduleId: string) {
  const schedule = await prisma.scheduledSkill.findFirst({
    where: { id: scheduleId, workspaceId },
    select: { id: true, projectId: true, workspaceId: true },
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

  const schedule = await prisma.scheduledSkill.findFirst({
    where: { id, workspaceId: access.workspaceId },
    include: {
      skill: { select: { id: true, name: true, slug: true } },
      runs: {
        orderBy: { startedAt: "desc" },
        take: 20,
        select: {
          id: true, trigger: true, status: true, startedAt: true, finishedAt: true,
          creditsUsed: true, wasMissed: true,
          _count: { select: { subagents: true } },
        },
      },
    },
  });
  if (!schedule) return notFound("Schedule not found");
  return Response.json({ schedule, recentRuns: schedule.runs });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await readJsonBody(req);
  const validated = validateBody(UpdateScheduleSchema, body);
  if (!validated.ok) return validated.error;
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req, validated.data), "viewer");
  if ("error" in access) return access.error;

  const auth = await authorizeMutation(user.id, access.workspaceId, id);
  if ("error" in auth) return auth.error;

  try {
    const schedule = await updateSchedule(prisma, id, access.workspaceId, {
      cronExpr: validated.data.cronExpr ?? undefined,
      timezone: validated.data.timezone,
      eventSource: validated.data.eventSource ?? undefined,
      eventConfig: (validated.data.eventConfig ?? undefined) as Record<string, unknown> | undefined,
      approvalMode: validated.data.approvalMode,
      concurrencyLimit: validated.data.concurrencyLimit,
      status: validated.data.status,
    }, user.id);
    return Response.json({ schedule });
  } catch (err) {
    if (err instanceof CronParseError) return badRequest(err.message);
    if (err instanceof ScheduleServiceError) return badRequest(err.message);
    throw err;
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "viewer");
  if ("error" in access) return access.error;

  const auth = await authorizeMutation(user.id, access.workspaceId, id);
  if ("error" in auth) return auth.error;

  try {
    await deleteSchedule(prisma, id, access.workspaceId, user.id);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof ScheduleServiceError) return notFound(err.message);
    throw err;
  }
}
