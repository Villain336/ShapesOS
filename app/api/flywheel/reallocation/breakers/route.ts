// Marketr — GET /api/flywheel/reallocation/breakers
// Breaker events with live frozen-scope computation.

import type { NextRequest } from "next/server";
import {
  flywheelGuard, safetyError,
  getStore, reallocationTablesReady, tablesNotReady,
} from "../_lib";
import { frozenScopes } from "@/lib/flywheel/reallocation/breakers";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  const gate = await flywheelGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await reallocationTablesReady())) return tablesNotReady();
  try {
    const store = getStore();
    const events = await store.listBreakerEvents(gate.workspaceId, 200);
    return Response.json({ breakers: events, frozenScopes: frozenScopes(events, new Date()) });
  } catch (err) {
    return safetyError(err);
  }
}
