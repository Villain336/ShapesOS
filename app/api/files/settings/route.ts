// ShapesOS — Phase 18.2 (WS=content): the workspace's Files settings.
// GET /api/files/settings?workspaceId=          → { versionRetention } (viewer+)
// PUT /api/files/settings { workspaceId, versionRetention } → { versionRetention, purged }
//       (admin+: how many previous versions each file keeps; lowering it purges the extra
//       versions and frees their storage)

import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { badRequest, requireWorkspaceAccess } from "@/lib/route-utils";
import { getVersionRetention, setVersionRetention, MAX_VERSION_RETENTION } from "@/lib/filesystem/versions";
import { auditEvent } from "@/lib/auditlog";
import { filesErrorResponse } from "@/lib/files/http";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, req.nextUrl.searchParams.get("workspaceId"), "viewer");
  if ("error" in access) return access.error;
  return Response.json({ versionRetention: await getVersionRetention(access.workspaceId), max: MAX_VERSION_RETENTION });
}

export async function PUT(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = z.object({ workspaceId: z.string().min(1).max(120), versionRetention: z.number().int() }).safeParse(await req.json().catch(() => null));
  if (!body.success) return badRequest("Invalid settings.");
  const access = await requireWorkspaceAccess(user.id, body.data.workspaceId, "admin");
  if ("error" in access) return access.error;
  try {
    const res = await setVersionRetention(access.workspaceId, body.data.versionRetention);
    await auditEvent({ workspaceId: access.workspaceId, projectId: null, action: "security_policy_updated", summary: `Files: keep ${res.keep} previous versions per file${res.purged ? ` (${res.purged} older versions purged)` : ""}`, actorUserId: user.id });
    return Response.json({ versionRetention: res.keep, purged: res.purged });
  } catch (err) {
    return filesErrorResponse(err, "PUT /api/files/settings");
  }
}
