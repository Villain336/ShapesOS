// ShapesOS — Phase 18.2 (WS=content): a file's share links.
// GET  /api/files/[fileId]/shares?workspaceId= → { links, canShare } (who can share sees them)
// POST /api/files/[fileId]/shares { workspaceId, access: view|download, expiresInDays (1-90),
//        password? } → 201 { link, token, path } — the token is shown ONCE (SHA-256 at rest).
// Access: requireWorkspaceAccess (editor+ to create) + the file's "share" right.
// The public side is /r/file/<token> (lib/files/shares.ts).

import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { badRequest, requireWorkspaceAccess } from "@/lib/route-utils";
import { createShareLink, listShareLinks } from "@/lib/files/shares";
import { fileActor, filesErrorResponse } from "@/lib/files/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ fileId: string }> };

const CreateSchema = z.object({
  workspaceId: z.string().min(1).max(120),
  access: z.enum(["view", "download"]).default("view"),
  expiresInDays: z.number().int().min(1).max(90).default(7),
  password: z.string().max(128).optional().nullable(),
});

export async function GET(req: NextRequest, ctx: Ctx) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { fileId } = await ctx.params;
  const access = await requireWorkspaceAccess(user.id, req.nextUrl.searchParams.get("workspaceId"), "viewer");
  if ("error" in access) return access.error;
  try {
    return Response.json(await listShareLinks(fileActor(user.id, access.workspaceId, access.membership.role), fileId), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return filesErrorResponse(err, "GET /api/files/[fileId]/shares");
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { fileId } = await ctx.params;
  const body = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return badRequest("Invalid share link settings.");
  const access = await requireWorkspaceAccess(user.id, body.data.workspaceId, "editor");
  if ("error" in access) return access.error;
  try {
    const res = await createShareLink(fileActor(user.id, access.workspaceId, access.membership.role), fileId, {
      access: body.data.access,
      expiresInDays: body.data.expiresInDays,
      password: body.data.password ?? null,
    });
    return Response.json(res, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return filesErrorResponse(err, "POST /api/files/[fileId]/shares");
  }
}
