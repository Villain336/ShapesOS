// Marketr — schedules API (Phase B, W2).
// GET  /api/schedules?workspaceId=&projectId=&status=   → { schedules } (viewer+)
// POST /api/schedules { workspaceId, projectId?, skillId, triggerType, cronExpr?, timezone?, ... }
//   → { schedule } (skills.install grant or admin+ for workspace scope;
//      project editors for project scope). Audited.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { requirePermission, forbidden } from "@/lib/authz";
import { workspaceIdFrom, badRequest, requireWorkspaceAccess, requireProjectAccess } from "@/lib/route-utils";
import { validateBody, z } from "@/lib/api/validate";
import { readJsonBody } from "@/lib/sitefiles/api";
import {
  createSchedule,
  ScheduleServiceError,
  CronParseError,
} from "@/lib/scheduler/service";

export const dynamic = "force-dynamic";

const CreateScheduleSchema = z.object({
  workspaceId: z.string().trim().max(120).optional(),
  projectId: z.string().trim().max(120).nullable().optional(),
  skillId: z.string().trim().min(1).max(120),
  triggerType: z.enum(["cron", "event"]),
  cronExpr: z.string().trim().max(100).nullable().optional(),
  // IANA zone the cron is read in (default UTC); validated by the service.
  timezone: z.string().trim().max(64).nullable().optional(),
  eventSource: z.string().trim().max(60).nullable().optional(),
  eventConfig: z.record(z.string(), z.unknown()).nullable().optional(),
  approvalMode: z.enum(["supervised", "scheduled", "autopilot"]).optional(),
  concurrencyLimit: z.number().int().min(1).max(16).optional(),
});

function serialize(s: {
  id: string;
  workspaceId: string;
  projectId: string | null;
  skillId: string;
  triggerType: string;
  cronExpr: string | null;
  timezone: string;
  eventSource: string | null;
  eventConfigJson: unknown;
  approvalMode: string;
  concurrencyLimit: number;
  status: string;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: s.id,
    workspaceId: s.workspaceId,
    projectId: s.projectId,
    skillId: s.skillId,
    triggerType: s.triggerType,
    cronExpr: s.cronExpr,
    timezone: s.timezone,
    eventSource: s.eventSource,
    eventConfig: s.eventConfigJson,
    approvalMode: s.approvalMode,
    concurrencyLimit: s.concurrencyLimit,
    status: s.status,
    lastRunAt: s.lastRunAt?.toISOString() ?? null,
    nextRunAt: s.nextRunAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "viewer");
  if ("error" in access) return access.error;

  const q = req.nextUrl.searchParams;
  const projectId = q.get("projectId")?.trim() || undefined;
  const status = q.get("status")?.trim();
  const triggerType = q.get("triggerType")?.trim();

  if (projectId) {
    const proj = await requireProjectAccess(user.id, projectId, "viewer");
    if ("error" in proj) return proj.error;
    if (proj.project.workspaceId !== access.workspaceId) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
  }

  const schedules = await prisma.scheduledSkill.findMany({
    where: {
      workspaceId: access.workspaceId,
      ...(projectId ? { projectId } : {}),
      ...(status === "active" || status === "paused" ? { status: status as "active" | "paused" } : {}),
      ...(triggerType === "cron" || triggerType === "event" ? { triggerType: triggerType as "cron" | "event" } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: { skill: { select: { id: true, name: true, slug: true } } },
  });
  return Response.json({
    schedules: schedules.map((s) => ({ ...serialize(s), skill: s.skill })),
  });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJsonBody(req);
  const validated = validateBody(CreateScheduleSchema, body);
  if (!validated.ok) return validated.error;
  const input = validated.data;

  // RBAC (threat model T3): project-scoped → project editor+; workspace-wide
  // → skills.install grant or admin+. Both primitives keep the M11 scan green.
  let workspaceId: string;
  let projectId: string | null = null;
  if (input.projectId) {
    const proj = await requireProjectAccess(user.id, input.projectId, "editor");
    if ("error" in proj) return proj.error;
    workspaceId = proj.project.workspaceId;
    projectId = proj.project.id;
  } else {
    const ws = await requireWorkspaceAccess(user.id, workspaceIdFrom(req, input), "viewer");
    if ("error" in ws) return ws.error;
    if (!(await requirePermission(user.id, ws.workspaceId, "skills.install"))) {
      return forbidden("skills.install permission required to create workspace-wide schedules.");
    }
    workspaceId = ws.workspaceId;
  }

  try {
    const schedule = await createSchedule(
      prisma,
      {
        workspaceId,
        projectId,
        skillId: input.skillId,
        triggerType: input.triggerType,
        cronExpr: input.cronExpr,
        timezone: input.timezone,
        eventSource: input.eventSource,
        eventConfig: (input.eventConfig ?? undefined) as Record<string, unknown> | undefined,
        createdBy: user.id,
        approvalMode: input.approvalMode,
        concurrencyLimit: input.concurrencyLimit,
      },
    );
    return Response.json({ schedule: serialize(schedule) }, { status: 201 });
  } catch (err) {
    if (err instanceof CronParseError) return badRequest(err.message);
    if (err instanceof ScheduleServiceError) return badRequest(err.message);
    throw err;
  }
}
