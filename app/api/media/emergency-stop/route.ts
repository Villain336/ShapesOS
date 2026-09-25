// Marketr — POST /api/media/emergency-stop (owner-only + written reason).
//
// One action: pauses every active entity for the client across all
// platforms, revokes pending approvals, freezes all pools, and exports the
// audit trail. Logged immutably.

import type { NextRequest } from "next/server";
import { mediaGuard, badRequest, safetyError, requireMediaOwner } from "../_lib";
import { EmergencyStopSchema } from "../_schemas";
import { mediaStores, safetyTablesReady, logMediaAudit } from "@/lib/media/db";
import { emergencyStop } from "@/lib/media/killswitch";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
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
    return badRequest("Invalid JSON");
  }
  const parsed = EmergencyStopSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const { approvals, pools, audit } = mediaStores();
    const result = await emergencyStop(
      {
        workspaceId: gate.workspaceId,
        clientId: parsed.data.clientId,
        reason: parsed.data.reason,
        actor: gate.userId,
        actorMediaRole: gate.mediaRole,
      },
      {
        poolStore: pools,
        approvalStore: approvals,
        // Platform pause hooks are B-track implementations (Meta bulk_pause,
        // Google Ads campaign PAUSED). Fake/test mode: no-op with logging.
        pauseAllClientEntities: async (workspaceId, clientId) => {
          console.log(`[emergency-stop] pauseAllClientEntities (fake): ws=${workspaceId} client=${clientId}`);
          return { paused: 0 };
        },
        now: () => new Date(),
      },
    );
    // Immutable audit: the stop itself is logged with the exported trail.
    await logMediaAudit(audit, {
      workspaceId: gate.workspaceId,
      actor: gate.userId,
      action: "emergency_stop",
      subjectType: "workspace",
      subjectId: null,
      detail: {
        clientId: parsed.data.clientId,
        reason: parsed.data.reason,
        entitiesPaused: result.entitiesPaused,
        approvalsRevoked: result.approvalsRevoked,
        poolsFrozen: result.poolsFrozen,
      },
    }).catch((e) => console.error("[media-audit] emergency_stop write failed:", e));
    return Response.json(result);
  } catch (err) {
    return safetyError(err);
  }
}
