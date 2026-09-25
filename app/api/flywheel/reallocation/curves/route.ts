// Marketr — GET /api/flywheel/reallocation/curves
// Per-channel fitted curves: type, params, R², calibration factors.

import type { NextRequest } from "next/server";
import {
  flywheelGuard, safetyError,
  getStore, reallocationTablesReady, tablesNotReady,
} from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await flywheelGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await reallocationTablesReady())) return tablesNotReady();
  try {
    const store = getStore();
    const channel = new URL(req.url).searchParams.get("channel") ?? undefined;
    const curves = await store.listCurves(gate.workspaceId, channel);
    return Response.json({ curves });
  } catch (err) {
    return safetyError(err);
  }
}
