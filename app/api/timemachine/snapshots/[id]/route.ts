// ShapesOS — Phase 18.3 (WS=flow): DELETE /api/timemachine/snapshots/[id] (admin+, audited).

import { errorResponse } from "@/lib/api/errors";
import { tmDeleteSnapshot } from "@/lib/timemachine/service";
import { flowGuard } from "../../../automations/_lib";

export const dynamic = "force-dynamic";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await flowGuard("admin");
    if (ctx instanceof Response) return ctx;
    const { id } = await params;
    await tmDeleteSnapshot(ctx, id);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "DELETE /api/timemachine/snapshots/[id]", req);
  }
}
