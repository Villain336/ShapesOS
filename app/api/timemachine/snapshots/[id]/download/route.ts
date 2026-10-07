// ShapesOS — Phase 18.3 (WS=flow): GET /api/timemachine/snapshots/[id]/download
// The snapshot file (.json.gz — the workspace export format). Admin+, audited.

import { errorResponse } from "@/lib/api/errors";
import { tmDownload } from "@/lib/timemachine/service";
import { flowGuard } from "../../../../automations/_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await flowGuard("admin");
    if (ctx instanceof Response) return ctx;
    const { id } = await params;
    const { view, bytes } = await tmDownload(ctx, id);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="shapesos-snapshot-${view.createdAt.slice(0, 10)}-${view.id}.json.gz"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err, "GET /api/timemachine/snapshots/[id]/download", req);
  }
}
