// Marketr — POST /api/flywheel/reallocation/breakers/:id/acknowledge
//
// Human acknowledgment STARTS the mandatory ≥72h cool-down — it does not
// end it. Owner/admin only.

import type { NextRequest } from "next/server";
import {
  flywheelGuard, safetyError, requireOwner,
  getStore, reallocationTablesReady, tablesNotReady,
} from "../../../_lib";
import { acknowledgeBreaker } from "@/lib/flywheel/reallocation/breakers";
import { AuditLog } from "@/lib/flywheel/reallocation/audit";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await flywheelGuard("editor");
  if (gate instanceof Response) return gate;
  const owner = requireOwner(gate);
  if (owner) return owner;
  if (!(await reallocationTablesReady())) return tablesNotReady();
  const { id } = await ctx.params;

  try {
    const store = getStore();
    const events = await store.listBreakerEvents(gate.workspaceId, 500);
    const event = events.find((e) => e.id === id);
    if (!event) return Response.json({ error: "Breaker event not found in workspace" }, { status: 404 });
    const acked = acknowledgeBreaker(event, gate.userId);
    const saved = await store.updateBreakerEvent(id, gate.workspaceId, {
      acknowledgedBy: acked.acknowledgedBy,
      acknowledgedAt: acked.acknowledgedAt,
      cooldownUntil: acked.cooldownUntil,
    });
    const audit = new AuditLog(store.audit);
    await audit.append(gate.workspaceId, "breaker_acknowledged", gate.userId, {
      breakerId: id, type: event.breakerType, scope: event.scope,
      cooldownUntil: saved.cooldownUntil,
    });
    return Response.json({ breaker: saved });
  } catch (err) {
    return safetyError(err);
  }
}
