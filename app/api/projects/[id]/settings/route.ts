// Marketr — project settings (milestone 21, spec §5 flow 6).
// GET /api/projects/[id]/settings → { settings (auto-created), project: { domain, locale }, workspace: workspaceSettings } (viewer+)
// PUT /api/projects/[id]/settings { brandContext?, domains?, approvalModeOverride?, publishingControls?, overrides? }
//   → { settings } (editor+; audited settings_project_updated)

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { badRequest, notFound, requireProjectAccess } from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";
import { readJsonBody } from "@/lib/sitefiles/api";
import { validateBody, z } from "@/lib/api/validate";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

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
  const { id: projectId } = await params;
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

const BodySchema = z.object({
  brandContext: z.string().max(20_000).nullable().optional(),
  domains: z.array(z.string().max(255)).max(100).optional(),
  approvalModeOverride: z.string().max(40).nullable().optional(),
  // Arbitrary JSON blobs (depth-capped by validateBody).
  publishingControls: z.unknown().optional(),
  overrides: z.unknown().optional(),
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
  const body = v.data;

  const update: {
    updatedBy?: string;
    brandContext?: string | null;
    domains?: string[];
    approvalModeOverride?: string | null;
    publishingControls?: Prisma.InputJsonValue;
    overrides?: Prisma.InputJsonValue;
  } = { updatedBy: user.id };
  if (body.brandContext !== undefined) {
    update.brandContext = body.brandContext;
  }
  if (body.domains !== undefined) {
    update.domains = body.domains.map((d) => d.slice(0, 255));
  }
  if (body.approvalModeOverride !== undefined) {
    if (body.approvalModeOverride !== null && !APPROVAL_MODES.includes(body.approvalModeOverride)) {
      return badRequest(`approvalModeOverride must be one of ${APPROVAL_MODES.join(", ")} or null`);
    }
    update.approvalModeOverride = body.approvalModeOverride;
  }
  if (body.publishingControls !== undefined) update.publishingControls = body.publishingControls as Prisma.InputJsonValue;
  if (body.overrides !== undefined) update.overrides = body.overrides as Prisma.InputJsonValue;

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
