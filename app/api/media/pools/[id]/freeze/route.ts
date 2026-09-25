// Marketr — POST /api/media/pools/:id/freeze (owner-only).
// Freeze blocks new encumbrance; existing encumbrances stay until released.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { mediaGuard, badRequest, safetyError, requireMediaOwner } from "../../../_lib";
import { mediaStores, safetyTablesReady, logMediaAudit } from "@/lib/media/db";
import { freezePool } from "@/lib/media/pools";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await mediaGuard("editor");
  if (gate instanceof Response) return gate;
  const ownerCheck = requireMediaOwner(gate.mediaRole);
  if (ownerCheck) return ownerCheck;
  if (!(await safetyTablesReady())) {
    return Response.json({ error: "Media safety tables not provisioned yet." }, { status: 503 });
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = z.object({ reason: z.string().trim().min(1).max(500).default("manual freeze") }).safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const { id } = await params;
    const { pools, audit } = mediaStores();
    const pool = await freezePool(pools, id, gate.workspaceId, gate.userId, parsed.data.reason);
    await logMediaAudit(audit, {
      workspaceId: gate.workspaceId,
      actor: gate.userId,
      action: "pool_frozen",
      subjectType: "pool",
      subjectId: pool.id,
      detail: { reason: parsed.data.reason },
    }).catch((e) => console.error("[media-audit] pool_frozen write failed:", e));
    return Response.json({ pool });
  } catch (err) {
    return safetyError(err);
  }
}
