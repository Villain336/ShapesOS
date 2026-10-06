// ShapesOS — Phase 18.3 (WS=flow): "Undo this agent run".
//   GET  /api/agent-runs/[runId]/undo → { plan }  (what it changed: revertible or not, and why)
//   POST /api/agent-runs/[runId]/undo { confirmed: true, itemIds? } → { outcomes, plan }
// A person's action (Tier 1: the UI asks first; confirmed is required).
// Only the run's starter or an admin may undo (requireWorkspaceRole for
// membership, then lib/timemachine/undo.ts checks starter-or-admin). There
// is no agent tool for this: an agent can never undo a run on its own.

import { errorResponse } from "@/lib/api/errors";
import { executeUndo, loadUndoPlan } from "@/lib/timemachine/undo";
import { flowGuard, readJsonObject } from "../../../automations/_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const ctx = await flowGuard("viewer");
    if (ctx instanceof Response) return ctx;
    const { runId } = await params;
    return Response.json({ plan: await loadUndoPlan(ctx, runId) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "GET /api/agent-runs/[runId]/undo", req);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const ctx = await flowGuard("viewer");
    if (ctx instanceof Response) return ctx;
    const { runId } = await params;
    const body = await readJsonObject(req);
    const itemIds = Array.isArray(body?.itemIds) ? body!.itemIds.filter((x): x is string => typeof x === "string").slice(0, 200) : undefined;
    return Response.json(await executeUndo(ctx, runId, { confirmed: body?.confirmed === true, itemIds }));
  } catch (err) {
    return errorResponse(err, "POST /api/agent-runs/[runId]/undo", req);
  }
}
