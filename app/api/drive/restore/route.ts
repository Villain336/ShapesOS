// ShapesOS — Phase 21B (WS=drive): restore a folder as of a time, beside the whole-workspace Time Machine.
// POST /api/drive/restore  { workspaceId, folder, asOf (ISO time), apply? }   (viewer+ for the plan; editor+ to apply)
// The default is a DRY RUN: it returns the plan and changes nothing. With apply: true, files whose content
// differs get the old bytes as NEW versions, files trashed since come back, and nothing is ever deleted.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { badRequest, requireWorkspaceAccess } from "@/lib/route-utils";
import { filesErrorResponse } from "@/lib/files/http";
import { restoreFolderAsOf } from "@/lib/drive/restore";

export const dynamic = "force-dynamic";

const Body = z.object({ workspaceId: z.string().min(1).max(120), folder: z.string().min(1).max(1100), asOf: z.string().min(10).max(40), apply: z.boolean().optional() });

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid request.");
  const b = parsed.data;
  const asOf = new Date(b.asOf);
  if (Number.isNaN(asOf.getTime())) return badRequest("asOf must be a time.");
  const access = await requireWorkspaceAccess(user.id, b.workspaceId, b.apply ? "editor" : "viewer");
  if ("error" in access) return access.error;
  try {
    const report = await restoreFolderAsOf({ actor: { workspaceId: access.workspaceId, userId: user.id, role: access.membership.role }, folder: b.folder, asOf, apply: b.apply });
    return Response.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return filesErrorResponse(err, "drive restore");
  }
}
