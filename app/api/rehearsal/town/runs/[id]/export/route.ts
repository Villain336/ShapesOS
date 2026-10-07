// ShapesOS — Phase 19B (WS=engine): export a town run's report.
// POST /api/rehearsal/town/runs/:id/export → the report JSON as a download;
// a copy is kept in blob storage (namespace "rehearsal") and the run keeps the ref. Viewer+.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { townActor } from "@/lib/sim/http.server";
import { exportTownRun } from "@/lib/sim/service.server";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace } = await guardWorkspace();
    const { id } = await params;
    const out = await exportTownRun(await townActor(user.id, workspace.id), id);
    return new Response(JSON.stringify({ synthetic: true, banner: out.report.banner, report: out.report }, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="${out.filename}"`, "Cache-Control": "no-store" },
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
