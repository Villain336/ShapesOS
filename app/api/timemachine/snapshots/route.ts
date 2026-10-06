// ShapesOS — Phase 18.3 (WS=flow): Time Machine snapshots (admin+).
//   GET  /api/timemachine/snapshots → { settings, snapshots }
//   POST /api/timemachine/snapshots → 201 { snapshot }   (take one now; 409 while one runs)
// A snapshot is the workspace's GDPR export, gzipped, in object storage
// (lib/timemachine/snapshots.ts); audited.

import { errorResponse } from "@/lib/api/errors";
import { tmOverview, tmTakeSnapshot } from "@/lib/timemachine/service";
import { flowGuard } from "../../automations/_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const ctx = await flowGuard("admin");
    if (ctx instanceof Response) return ctx;
    return Response.json(await tmOverview(ctx), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "GET /api/timemachine/snapshots", req);
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await flowGuard("admin");
    if (ctx instanceof Response) return ctx;
    return Response.json({ snapshot: await tmTakeSnapshot(ctx) }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/timemachine/snapshots", req);
  }
}
