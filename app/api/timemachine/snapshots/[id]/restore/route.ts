// ShapesOS — Phase 18.3 (WS=flow): POST /api/timemachine/snapshots/[id]/restore { name?, confirmed: true }
//   → { report }  — restores into a NEW workspace (never over this one), owned
// by the person restoring; the report lists what could not come back.
// Admin+; audited in both workspaces.

import { errorResponse } from "@/lib/api/errors";
import { tmRestore } from "@/lib/timemachine/service";
import { flowGuard, readJsonObject } from "../../../../automations/_lib";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await flowGuard("admin");
    if (ctx instanceof Response) return ctx;
    const { id } = await params;
    const body = await readJsonObject(req);
    if (body?.confirmed !== true) return Response.json({ error: "Restoring needs your confirmation." }, { status: 400 });
    const name = typeof body.name === "string" ? body.name.slice(0, 80) : null;
    const report = await tmRestore(ctx, id, name);
    return Response.json({ report }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/timemachine/snapshots/[id]/restore", req);
  }
}
