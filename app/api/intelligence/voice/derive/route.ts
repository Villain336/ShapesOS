// Marketr — Phase 13B: derive the Brand Voice profile from samples.
// POST /api/intelligence/voice/derive { workspaceId, samples? }
//   → { profile, applied }
// Without samples, seeds from the workspace's own content: website text via
// the site IDE working copies, campaign copy, and content docs. A pinned
// profile is read-only to derivation — results land in pendingUpdates
// (applied: false) for user review instead of overwriting dimensions.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import {
  workspaceIdFrom,
  requireWorkspaceAccess,
  badRequest,
} from "@/lib/route-utils";
import { deriveAndStoreVoiceProfile } from "@/lib/intelligence/company/voice";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { workspaceId?: string; samples?: string[] };
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

  const samples =
    Array.isArray(body.samples) && body.samples.length > 0
      ? body.samples.filter((s) => typeof s === "string")
      : undefined;

  try {
    const result = await deriveAndStoreVoiceProfile(
      access.workspaceId,
      samples,
      samples ? 0 : undefined,
    );
    return Response.json({
      dimensions: result.dimensions,
      derivedFrom: result.derivedFrom,
      confidence: result.confidence,
      applied: result.applied,
    });
  } catch (err) {
    return badRequest(
      err instanceof Error ? err.message : "Voice derivation failed",
    );
  }
}
