// ShapesOS — Phase 18.3 (WS=trust): the audit timeline (Privacy & Security center).
//   GET /api/trust/timeline?actor=person|agent|system&source=a,b&from=&to=&cursor=
//     → { entries, next, errors }
//   &format=csv → text/csv attachment (audited: audit_timeline_exported)
// admin+ — every audit trail of THIS workspace, through one read-side view
// (lib/audit-timeline). Nothing is copied or written (except the export's
// own audit row).

import type { NextRequest } from "next/server";
import { auditEvent } from "@/lib/auditlog";
import { errorResponse } from "@/lib/api/errors";
import { loadTimeline, timelineCsv } from "@/lib/audit-timeline/timeline.server";
import { filterFromQuery } from "@/lib/audit-timeline/query";
import { NO_STORE, trustGuard } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const ctx = await trustGuard("admin");
  if (ctx instanceof Response) return ctx;
  try {
    const q = req.nextUrl.searchParams;
    const filter = filterFromQuery(q);
    if (q.get("format") === "csv") {
      const { csv, rows } = await timelineCsv(ctx.workspaceId, filter);
      await auditEvent({ projectId: null, workspaceId: ctx.workspaceId, action: "audit_timeline_exported", actorUserId: ctx.userId, summary: `Exported ${rows} audit timeline rows as CSV` });
      return new Response(csv, {
        headers: {
          ...NO_STORE,
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="audit-timeline-${ctx.workspaceId}.csv"`,
        },
      });
    }
    const page = await loadTimeline(ctx.workspaceId, filter, q.get("cursor"));
    return Response.json(page, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, "GET /api/trust/timeline");
  }
}
