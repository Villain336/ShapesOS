// Marketr — Phase 15 slice 5: catalog drift API.
// GET  /api/integrations/actions/drift — unacknowledged drift reports +
//        stale tier overrides for this workspace (drives the Actions →
//        Activity drift panel).
// POST /api/integrations/actions/drift — { driftId } acknowledges one
//        drift row: the human's re-approval of the change. Clears the
//        banner count and the stale-override flag for that slug (editor
//        role; acknowledging a rename still requires the override to be
//        re-pointed at the new slug — that's the re-approval).

import { z } from "zod";
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import {
  listDriftReports,
  getStaleOverrides,
  acknowledgeDrift,
} from "@/lib/integrations/actions/drift";

export const dynamic = "force-dynamic";

const AckSchema = z.object({
  driftId: z.string().trim().min(1).max(64),
});

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const { reports, unacknowledgedCount } = await listDriftReports(workspace.id);
    const staleOverrides = await getStaleOverrides(workspace.id);
    return Response.json({
      reports: reports.map((r) => ({
        ...r,
        detectedAt: r.detectedAt.toISOString(),
        acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
      })),
      unacknowledgedCount,
      staleOverrides,
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const body = AckSchema.parse(await readJson(req));
    const report = await acknowledgeDrift(workspace.id, body.driftId);
    return Response.json({
      report: {
        ...report,
        detectedAt: report.detectedAt.toISOString(),
        acknowledgedAt: report.acknowledgedAt?.toISOString() ?? null,
      },
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
