// Marketr — GET /api/flywheel/reallocation/audit
// Immutable audit log view (hash-chained, correlation IDs) + chain verification.

import type { NextRequest } from "next/server";
import {
  flywheelGuard, safetyError,
  getStore, reallocationTablesReady, tablesNotReady,
} from "../_lib";
import { AuditLog } from "@/lib/flywheel/reallocation/audit";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  const gate = await flywheelGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await reallocationTablesReady())) return tablesNotReady();
  try {
    const store = getStore();
    const audit = new AuditLog(store.audit);
    const [events, chain] = await Promise.all([
      audit.list(gate.workspaceId, 200),
      audit.verifyChain(gate.workspaceId),
    ]);
    return Response.json({ events: events.reverse(), chainIntact: chain.ok, brokenAt: chain.brokenAt ?? null });
  } catch (err) {
    return safetyError(err);
  }
}
