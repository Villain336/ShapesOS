// ShapesOS — Phase 18.2 (WS=content): revoke one share link.
// DELETE /api/files/[fileId]/shares/[linkId]?workspaceId= → { link } (revoked; idempotent)
// Access: requireWorkspaceAccess (editor+) + the link's maker or the file's owner.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { requireWorkspaceAccess } from "@/lib/route-utils";
import { revokeShareLink } from "@/lib/files/shares";
import { fileActor, filesErrorResponse } from "@/lib/files/http";

export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ fileId: string; linkId: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { fileId, linkId } = await ctx.params;
  const access = await requireWorkspaceAccess(user.id, req.nextUrl.searchParams.get("workspaceId"), "editor");
  if ("error" in access) return access.error;
  try {
    return Response.json({ link: await revokeShareLink(fileActor(user.id, access.workspaceId, access.membership.role), fileId, linkId) });
  } catch (err) {
    return filesErrorResponse(err, "DELETE /api/files/[fileId]/shares/[linkId]");
  }
}
