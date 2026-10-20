// ShapesOS — Phase 18.3 (WS=flow): GET /api/timemachine/versions → { items }
// Notes, docs and files with earlier versions that this person can see
// (lib/timemachine/versions.ts). Viewer+.

import { errorResponse } from "@/lib/api/errors";
import { listVersionedItems } from "@/lib/timemachine/versions";
import { flowGuard } from "../../automations/_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const ctx = await flowGuard("viewer");
    if (ctx instanceof Response) return ctx;
    return Response.json({ items: await listVersionedItems(ctx) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "GET /api/timemachine/versions", req);
  }
}
