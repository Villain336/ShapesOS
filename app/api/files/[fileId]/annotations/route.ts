// ShapesOS — Phase 18.2 (WS=content): PDF highlights and comments of a file version.
// GET  /api/files/[fileId]/annotations?workspaceId=[&version=N]  → { annotations } (viewer+)
// GET  …&export=1 → the file's annotations, every version, as a JSON download
// POST /api/files/[fileId]/annotations { workspaceId, version?, page, kind: highlight|comment,
//        rects: [{x,y,w,h}] (page fractions), quote?, body? } → 201 { annotation }
//        (editor+ and the file's "annotate" right). Stored per version, never in the PDF.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { badRequest, requireWorkspaceAccess } from "@/lib/route-utils";
import { createAnnotation, exportAnnotations, listAnnotations } from "@/lib/files/annotations";
import { fileActor, filesErrorResponse } from "@/lib/files/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ fileId: string }> };

const CreateSchema = z.object({
  workspaceId: z.string().min(1).max(120),
  version: z.number().int().min(1).optional(),
  page: z.number().int().min(1).max(10_000),
  kind: z.enum(["highlight", "comment"]),
  rects: z.array(z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })).min(1).max(64),
  quote: z.string().max(4000).optional().nullable(),
  body: z.string().max(10_000).optional().nullable(),
});

export async function GET(req: NextRequest, ctx: Ctx) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { fileId } = await ctx.params;
  const qs = req.nextUrl.searchParams;
  const access = await requireWorkspaceAccess(user.id, qs.get("workspaceId"), "viewer");
  if ("error" in access) return access.error;
  const actor = fileActor(user.id, access.workspaceId, access.membership.role);
  try {
    if (qs.get("export") === "1") {
      const doc = await exportAnnotations(actor, fileId);
      const name = `${doc.file.filename.replace(/["\\\r\n]/g, "_").slice(0, 150)}.annotations.json`;
      return new Response(JSON.stringify(doc, null, 2), {
        headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "x-content-type-options": "nosniff", "cache-control": "no-store" },
      });
    }
    const v = qs.get("version");
    return Response.json({ annotations: await listAnnotations(actor, fileId, v ? Number(v) : undefined) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return filesErrorResponse(err, "GET /api/files/[fileId]/annotations");
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { fileId } = await ctx.params;
  const body = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return badRequest("Invalid annotation.");
  const access = await requireWorkspaceAccess(user.id, body.data.workspaceId, "editor");
  if ("error" in access) return access.error;
  try {
    const annotation = await createAnnotation(fileActor(user.id, access.workspaceId, access.membership.role), fileId, body.data);
    return Response.json({ annotation }, { status: 201 });
  } catch (err) {
    return filesErrorResponse(err, "POST /api/files/[fileId]/annotations");
  }
}
