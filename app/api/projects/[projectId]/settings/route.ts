// Marketr — project settings (milestone 21, spec §5 flow 6).
// GET /api/projects/[projectId]/settings → { settings (auto-created), project: { domain, locale }, workspace: workspaceSettings } (viewer+)
// PUT /api/projects/[projectId]/settings { brandContext?, domains?, approvalModeOverride?, publishingControls?, overrides? }
//   → { settings } (editor+; audited settings_project_updated)

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { badRequest, notFound, requireProjectAccess } from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";
import { readJsonBody } from "@/lib/sitefiles/api";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

const APPROVAL_MODES = ["supervised", "scheduled", "manual"];

function publicProjectSettings(s: {
  projectId: string;
  overrides: unknown;
  brandContext: string | null;
  domains: string[];
  approvalModeOverride: string | null;
  publishingControls: unknown;
  updatedBy: string | null;
  updatedAt: Date;
}) {
  return {
    projectId: s.projectId,
    overrides: s.overrides,
    brandContext: s.brandContext,
    domains: s.domains,
    approvalModeOverride: s.approvalModeOverride,
    publishingControls: s.publishingControls,
    updatedBy: s.updatedBy,
    updatedAt: s.updatedAt.toISOString(),
  };
}

export async function GET(_req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { projectId } = await params;
  const access = await requireProjectAccess(user.id, projectId, "viewer");
  if ("error" in access) return access.error;

  const [project, settings, workspaceSettings] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { domain: true, locale: true },
    }),
    prisma.projectSettings.upsert({
      where: { projectId },
      create: { projectId, updatedBy: user.id },
      update: {},
    }),
    prisma.workspaceSettings.findUnique({ where: { workspaceId: access.project.workspaceId } }),
  ]);
  if (!project) return notFound("Project not found");
  return Response.json({
    settings: publicProjectSettings(settings),
    project: { domain: project.domain, locale: project.locale },
    workspace: workspaceSettings
      ? {
          defaultModel: workspaceSettings.defaultModel,
          defaultApprovalMode: workspaceSettings.defaultApprovalMode,
          notificationDefaults: workspaceSettings.notificationDefaults,
          dataGovernance: workspaceSettings.dataGovernance,
          agentAllowList: workspaceSettings.agentAllowList,
        }
      : null,
  });
}

export async function PUT(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { projectId } = await params;
  const access = await requireProjectAccess(user.id, projectId, "editor");
  if ("error" in access) return access.error;

  const body = await readJsonBody<{
    brandContext?: unknown;
    domains?: unknown;
    approvalModeOverride?: unknown;
    publishingControls?: unknown;
    overrides?: unknown;
  }>(req);

  const update: {
    updatedBy?: string;
    brandContext?: string | null;
    domains?: string[];
    approvalModeOverride?: string | null;
    publishingControls?: Prisma.InputJsonValue;
    overrides?: Prisma.InputJsonValue;
  } = { updatedBy: user.id };
  if (body?.brandContext !== undefined) {
    update.brandContext = body.brandContext === null ? null : String(body.brandContext).slice(0, 20_000);
  }
  if (body?.domains !== undefined) {
    if (!Array.isArray(body.domains) || !body.domains.every((d) => typeof d === "string")) {
      return badRequest("domains must be an array of strings");
    }
    update.domains = body.domains.map((d) => String(d).slice(0, 255));
  }
  if (body?.approvalModeOverride !== undefined) {
    if (body.approvalModeOverride !== null && !APPROVAL_MODES.includes(String(body.approvalModeOverride))) {
      return badRequest(`approvalModeOverride must be one of ${APPROVAL_MODES.join(", ")} or null`);
    }
    update.approvalModeOverride = body.approvalModeOverride === null ? null : String(body.approvalModeOverride);
  }
  if (body?.publishingControls !== undefined) update.publishingControls = body.publishingControls as Prisma.InputJsonValue;
  if (body?.overrides !== undefined) update.overrides = body.overrides as Prisma.InputJsonValue;

  const settings = await prisma.projectSettings.upsert({
    where: { projectId },
    create: { projectId, ...update },
    update,
  });
  await auditEvent({
    projectId,
    workspaceId: access.project.workspaceId,
    action: "settings_project_updated",
    summary: "Updated project settings",
    actorUserId: user.id,
  });
  return Response.json({ settings: publicProjectSettings(settings) });
}
