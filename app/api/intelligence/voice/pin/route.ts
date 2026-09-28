// Marketr — Phase 13B: pin / unpin the Brand Voice profile.
// POST /api/intelligence/voice/pin { workspaceId, pinned }
// A pinned profile is read-only to the learner (worker 6): derivation
// results go to pendingUpdates instead of overwriting dimensions.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import {
  workspaceIdFrom,
  requireWorkspaceAccess,
  badRequest,
} from "@/lib/route-utils";
import { setVoicePinned } from "@/lib/intelligence/company/voice";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { workspaceId?: string; pinned?: boolean };
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const access = await requireWorkspaceAccess(
    user.id,
    workspaceIdFrom(req, body),
    "editor",
  );
  if ("error" in access) return access.error;
  if (typeof body.pinned !== "boolean") {
    return badRequest("pinned (boolean) is required");
  }

  const updated = await setVoicePinned(access.workspaceId, body.pinned);
  return Response.json({ pinnedByUser: updated.pinnedByUser });
}
