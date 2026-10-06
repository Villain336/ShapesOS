// ShapesOS — Phase 18.2 (WS=content): who can do what with one file.
// GET /api/files/[fileId]/access?workspaceId= → { entries, canManage } (anyone who sees the file)
// PUT /api/files/[fileId]/access { workspaceId, userId, role: viewer|editor|owner|null }
//       → { entries } — set or clear a member's override; never wider than their
//       workspace role (lib/files/acl.ts). The file's owner or an admin.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { badRequest, requireWorkspaceAccess } from "@/lib/route-utils";
import { listFileAccess, setFileAccess } from "@/lib/files/access";
import { fileActor, filesErrorResponse } from "@/lib/files/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ fileId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { fileId } = await ctx.params;
  const access = await requireWorkspaceAccess(user.id, req.nextUrl.searchParams.get("workspaceId"), "viewer");
  if ("error" in access) return access.error;
  try {
    return Response.json(await listFileAccess(fileActor(user.id, access.workspaceId, access.membership.role), fileId), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return filesErrorResponse(err, "GET /api/files/[fileId]/access");
  }
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { fileId } = await ctx.params;
  const body = z
    .object({ workspaceId: z.string().min(1).max(120), userId: z.string().min(1).max(200), role: z.enum(["viewer", "editor", "owner"]).nullable() })
    .safeParse(await req.json().catch(() => null));
  if (!body.success) return badRequest("Invalid access change.");
  const access = await requireWorkspaceAccess(user.id, body.data.workspaceId, "editor");
  if ("error" in access) return access.error;
  try {
    const entries = await setFileAccess(fileActor(user.id, access.workspaceId, access.membership.role), fileId, body.data.userId, body.data.role);
    return Response.json({ entries });
  } catch (err) {
    return filesErrorResponse(err, "PUT /api/files/[fileId]/access");
  }
}
