// Marketr — workspace settings (milestone 21, spec §5 flow 6).
// GET /api/settings/workspace?workspaceId= → { settings } (admin+; auto-creates the defaults row)
// PUT /api/settings/workspace { workspaceId, defaultModel?, defaultApprovalMode?, notificationDefaults?, dataGovernance?, agentAllowList? }
//   → { settings } (admin+; audited settings_workspace_updated)

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { workspaceIdFrom, badRequest, requireWorkspaceAccess } from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";
import { readJsonBody } from "@/lib/sitefiles/api";
import { validateBody, z } from "@/lib/api/validate";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

const APPROVAL_MODES = ["supervised", "scheduled", "manual"];

function publicSettings(s: {
  workspaceId: string;
  defaultModel: string | null;
  defaultApprovalMode: string;
  notificationDefaults: unknown;
  dataGovernance: unknown;
  agentAllowList: string[];
  updatedBy: string | null;
  updatedAt: Date;
}) {
  return {
    workspaceId: s.workspaceId,
    defaultModel: s.defaultModel,
    defaultApprovalMode: s.defaultApprovalMode,
    notificationDefaults: s.notificationDefaults,
    dataGovernance: s.dataGovernance,
    agentAllowList: s.agentAllowList,
    updatedBy: s.updatedBy,
    updatedAt: s.updatedAt.toISOString(),
  };
}

async function getOrCreate(workspaceId: string, userId: string) {
  const existing = await prisma.workspaceSettings.findUnique({ where: { workspaceId } });
  if (existing) return existing;
  return prisma.workspaceSettings.create({ data: { workspaceId, updatedBy: userId } });
}

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "admin");
  if ("error" in access) return access.error;
  const settings = await getOrCreate(access.workspaceId, user.id);
  return Response.json({ settings: publicSettings(settings) });
}

const BodySchema = z.object({
  workspaceId: z.string().trim().max(120).optional(),
  defaultModel: z.string().max(120).nullable().optional(),
  defaultApprovalMode: z.string().max(40).optional(),
  // Arbitrary JSON blobs (depth-capped by validateBody).
  notificationDefaults: z.unknown().optional(),
  dataGovernance: z.unknown().optional(),
  agentAllowList: z.array(z.string().max(80)).max(200).optional(),
});

export async function PUT(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const rawBody = await readJsonBody(req);
  const v = validateBody(BodySchema, rawBody);
  if (!v.ok) return v.error;
  const body = v.data;
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req, body), "admin");
  if ("error" in access) return access.error;

  const update: {
    updatedBy?: string;
    defaultModel?: string | null;
    defaultApprovalMode?: string;
    notificationDefaults?: Prisma.InputJsonValue;
    dataGovernance?: Prisma.InputJsonValue;
    agentAllowList?: string[];
  } = { updatedBy: user.id };
  if (body.defaultModel !== undefined) {
    update.defaultModel = body.defaultModel;
  }
  if (body.defaultApprovalMode !== undefined) {
    const mode = body.defaultApprovalMode;
    if (!APPROVAL_MODES.includes(mode)) {
      return badRequest(`defaultApprovalMode must be one of ${APPROVAL_MODES.join(", ")}`);
    }
    update.defaultApprovalMode = mode;
  }
  if (body.notificationDefaults !== undefined) update.notificationDefaults = body.notificationDefaults as Prisma.InputJsonValue;
  if (body.dataGovernance !== undefined) update.dataGovernance = body.dataGovernance as Prisma.InputJsonValue;
  if (body.agentAllowList !== undefined) {
    update.agentAllowList = body.agentAllowList.map((val) => val.slice(0, 80));
  }

  const settings = await prisma.workspaceSettings.upsert({
    where: { workspaceId: access.workspaceId },
    create: { workspaceId: access.workspaceId, ...update },
    update,
  });
  await auditEvent({
    projectId: null,
    workspaceId: access.workspaceId,
    action: "settings_workspace_updated",
    summary: "Updated workspace settings",
    actorUserId: user.id,
  });
  return Response.json({ settings: publicSettings(settings) });
}
