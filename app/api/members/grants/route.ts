// Marketr — permission grants (milestone 21, spec §7).
// GET  /api/members/grants?workspaceId= → { grants } (admin+)
// POST /api/members/grants { workspaceId, permission: "skills.install"|"connectors.connect", userId?, role? }
//   → { grant }. Exactly one of userId/role. (admin+; audited)
// owner/admin hold every permission by default — grants extend to others.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getMembership } from "@/lib/authz";
import { workspaceIdFrom, badRequest, requireWorkspaceAccess } from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";
import { readJsonBody } from "@/lib/sitefiles/api";
import { validateBody, z, boundedString } from "@/lib/api/validate";
import type { WorkspaceRole } from "@prisma/client";

export const dynamic = "force-dynamic";

const GRANTABLE = ["skills.install", "connectors.connect"] as const;
const GRANTABLE_ROLES: WorkspaceRole[] = ["viewer", "editor", "admin"];

function publicGrant(g: {
  id: string;
  userId: string | null;
  role: WorkspaceRole | null;
  permission: string;
  grantedBy: string;
  createdAt: Date;
}) {
  return {
    id: g.id,
    userId: g.userId,
    role: g.role,
    permission: g.permission,
    grantedBy: g.grantedBy,
    createdAt: g.createdAt.toISOString(),
  };
}

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "admin");
  if ("error" in access) return access.error;

  const grants = await prisma.permissionGrant.findMany({
    where: { workspaceId: access.workspaceId },
    orderBy: { createdAt: "desc" },
  });
  return Response.json({ grants: grants.map(publicGrant) });
}

const GrantBodySchema = z.object({
  workspaceId: z.string().trim().max(120).optional(),
  permission: boundedString(120, "permission"),
  userId: z.string().trim().max(120).optional(),
  role: z.string().trim().max(40).optional(),
});

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const rawBody = await readJsonBody(req);
  const v = validateBody(GrantBodySchema, rawBody);
  if (!v.ok) return v.error;
  const body = v.data;
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req, body), "admin");
  if ("error" in access) return access.error;

  const permission = body.permission;
  if (!(GRANTABLE as readonly string[]).includes(permission)) {
    return badRequest(`permission must be one of ${GRANTABLE.join(", ")}`);
  }
  const userId = body.userId?.trim() ? body.userId.trim() : null;
  const role = body.role?.trim() ? (body.role.trim() as WorkspaceRole) : null;
  if ((userId && role) || (!userId && !role)) {
    return badRequest("Exactly one of userId or role is required");
  }
  if (role && !GRANTABLE_ROLES.includes(role)) {
    return badRequest(`role must be one of ${GRANTABLE_ROLES.join(", ")}`);
  }
  if (userId) {
    const target = await getMembership(userId, access.workspaceId);
    if (!target) return badRequest("userId is not a member of this workspace");
  }

  const existing = await prisma.permissionGrant.findFirst({
    where: {
      workspaceId: access.workspaceId,
      permission,
      userId,
      role,
    },
  });
  if (existing) {
    return Response.json({ error: "This grant already exists", grant: publicGrant(existing) }, { status: 409 });
  }

  const grant = await prisma.permissionGrant.create({
    data: {
      workspaceId: access.workspaceId,
      userId,
      role,
      permission,
      grantedBy: user.id,
    },
  });
  await auditEvent({
    projectId: null,
    workspaceId: access.workspaceId,
    action: "permission_grant_created",
    summary: `Granted ${permission} to ${userId ?? `role ${role}`}`,
    actorUserId: user.id,
  });
  return Response.json({ grant: publicGrant(grant) }, { status: 201 });
}
