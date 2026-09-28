// Marketr — Phase 13B: Brand Voice profile API.
// GET   /api/intelligence/voice?workspaceId=…        → current profile (or null)
// PATCH /api/intelligence/voice {workspaceId, dimensions} → manual tune

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import {
  workspaceIdFrom,
  requireWorkspaceAccess,
  badRequest,
  notFound,
} from "@/lib/route-utils";
import {
  getVoiceProfile,
  updateVoiceDimensions,
  type VoiceDimensions,
} from "@/lib/intelligence/company/voice";

function serialize(profile: NonNullable<Awaited<ReturnType<typeof getVoiceProfile>>>) {
  return {
    id: profile.id,
    dimensions: profile.dimensions,
    derivedFrom: profile.derivedFrom,
    confidence: profile.confidence,
    pinnedByUser: profile.pinnedByUser,
    pendingUpdates: profile.pendingUpdates,
    updatedAt: profile.updatedAt,
  };
}

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const access = await requireWorkspaceAccess(
    user.id,
    workspaceIdFrom(req),
    "viewer",
  );
  if ("error" in access) return access.error;

  const profile = await getVoiceProfile(access.workspaceId);
  return Response.json({ profile: profile ? serialize(profile) : null });
}

export async function PATCH(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { workspaceId?: string; dimensions?: Partial<VoiceDimensions> };
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
  if (!body.dimensions || typeof body.dimensions !== "object") {
    return badRequest("dimensions is required");
  }

  const updated = await updateVoiceDimensions(access.workspaceId, body.dimensions);
  return Response.json({ profile: serialize(updated) });
}

export async function DELETE() {
  return notFound("Voice profiles are never deleted — pin or re-derive instead.");
}
