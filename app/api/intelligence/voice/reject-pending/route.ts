// Marketr — Phase 13B: reject the learner's pending voice updates.
// POST /api/intelligence/voice/reject-pending { workspaceId }
// Discards pendingUpdates without touching dimensions.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import {
  workspaceIdFrom,
  requireWorkspaceAccess,
  badRequest,
} from "@/lib/route-utils";
import { rejectPendingVoiceUpdates } from "@/lib/intelligence/company/voice";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { workspaceId?: string };
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

  await rejectPendingVoiceUpdates(access.workspaceId);
  return Response.json({ ok: true });
}
