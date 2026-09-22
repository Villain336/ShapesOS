// Marketr — per-project connector data-source bindings (milestone 21, spec §5 flows 3–4).
// GET  /api/projects/[id]/data-sources → { bindings } (viewer+)
// POST /api/projects/[id]/data-sources { connectionId, projectConfig? } → { binding }
//   The connection must belong to the project's workspace. (editor+; audited)

import type { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { badRequest, notFound, requireProjectAccess } from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";
import { readJsonBody } from "@/lib/sitefiles/api";
import { validateBody, z, boundedString } from "@/lib/api/validate";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

function publicBinding(b: {
  id: string;
  connectorKey: string;
  connectionId: string;
  projectConfig: unknown;
  createdAt: Date;
  connection: {
    id: string;
    status: string;
    scopes: string[];
    meta: unknown;
    connector: { displayName: string } | null;
  } | null;
}) {
  return {
    id: b.id,
    connectorKey: b.connectorKey,
    connectionId: b.connectionId,
    projectConfig: b.projectConfig,
    createdAt: b.createdAt.toISOString(),
    connection: b.connection
      ? {
          id: b.connection.id,
          status: b.connection.status,
          scopes: b.connection.scopes,
          meta: b.connection.meta,
          displayName: b.connection.connector?.displayName ?? b.connectorKey,
        }
      : null,
  };
}

export async function GET(_req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id: projectId } = await params;
  const access = await requireProjectAccess(user.id, projectId, "viewer");
  if ("error" in access) return access.error;

  const bindings = await prisma.projectDataSource.findMany({
    where: { projectId },
    include: { connection: { include: { connector: { select: { displayName: true } } } } },
    orderBy: { connectorKey: "asc" },
  });
  return Response.json({ bindings: bindings.map(publicBinding) });
}

const BodySchema = z.object({
  connectionId: boundedString(120, "connectionId"),
  // Arbitrary connector-specific config (depth-capped by validateBody).
  projectConfig: z.unknown().optional(),
});

export async function POST(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id: projectId } = await params;
  const access = await requireProjectAccess(user.id, projectId, "editor");
  if ("error" in access) return access.error;

  const rawBody = await readJsonBody(req);
  const v = validateBody(BodySchema, rawBody);
  if (!v.ok) return v.error;
  const body = v.data;
  const connectionId = body.connectionId;
  const connection = await prisma.connectorConnection.findFirst({
    where: { id: connectionId },
  });
  if (!connection) return notFound("Connection not found");
  if (connection.workspaceId !== access.project.workspaceId) {
    return badRequest("Connection belongs to a different workspace");
  }

  let binding;
  try {
    binding = await prisma.projectDataSource.create({
      data: {
        projectId,
        connectionId,
        connectorKey: connection.connectorKey,
        projectConfig:
          body.projectConfig && typeof body.projectConfig === "object"
            ? (body.projectConfig as Prisma.InputJsonValue)
            : undefined,
        createdBy: user.id,
      },
      include: { connection: { include: { connector: { select: { displayName: true } } } } },
    });
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as { code: string }).code === "P2002") {
      return Response.json({ error: "This connection is already bound to the project" }, { status: 409 });
    }
    throw err;
  }
  await auditEvent({
    projectId,
    workspaceId: access.project.workspaceId,
    action: "data_source_bound",
    summary: `Bound ${connection.connectorKey} to project`,
    actorUserId: user.id,
  });
  return Response.json({ binding: publicBinding(binding) }, { status: 201 });
}
