// Marketr — Phase 13B: approve the learner's pending voice updates.
// POST /api/intelligence/voice/approve-pending { workspaceId }
// Merges pendingUpdates.dimensions into dimensions and clears pendingUpdates.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import {
  workspaceIdFrom,
  requireWorkspaceAccess,
  badRequest,
} from "@/lib/route-utils";
import { approvePendingVoiceUpdates } from "@/lib/intelligence/company/voice";

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

  try {
    const updated = await approvePendingVoiceUpdates(access.workspaceId);
    return Response.json({
      profile: {
        id: updated.id,
        dimensions: updated.dimensions,
        confidence: updated.confidence,
        pinnedByUser: updated.pinnedByUser,
        pendingUpdates: updated.pendingUpdates,
      },
    });
  } catch (err) {
    return badRequest(
      err instanceof Error ? err.message : "Approval failed",
    );
  }
}
