// ShapesOS — Phase 21B (WS=drive): apply an agent's staged proposal. When a run changes a file that
// already exists, the new content is NOT written over it: it waits under /agents/<run>/proposed/… and a
// person applies it here (the original gets a new version; the staged copy goes to the Trash).
// POST /api/drive/proposals { workspaceId, fileId }   (editor+; needs the "version" right on the original)

import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { badRequest, requireWorkspaceAccess } from "@/lib/route-utils";
import { filesErrorResponse } from "@/lib/files/http";
import { applyStaged } from "@/lib/drive/sandbox-bridge";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = z.object({ workspaceId: z.string().min(1).max(120), fileId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid request.");
  const access = await requireWorkspaceAccess(user.id, parsed.data.workspaceId, "editor");
  if ("error" in access) return access.error;
  try {
    return Response.json(await applyStaged({ workspaceId: access.workspaceId, userId: user.id, role: access.membership.role }, parsed.data.fileId));
  } catch (err) {
    return filesErrorResponse(err, "drive proposals");
  }
}
