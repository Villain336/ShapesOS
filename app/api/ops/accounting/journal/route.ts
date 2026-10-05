// ShapesOS — Phase 10 (finance): GET /api/ops/accounting/journal.
// Journal entries with their lines (newest first). Viewer+.
// Query: from, to (YYYY-MM-DD), sourceType, sourceId, accountId, limit.
// Manual entries are POSTed to /api/ops/journal-entries (gated: OPS_JOURNAL_POST).

import type { NextRequest } from "next/server";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { listJournal, parseReportDate } from "@/lib/ops/accounting";
import { financeError, financeGuard, optString } from "@/lib/ops/finance/http";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const actor = await financeGuard("viewer");
  if (actor instanceof Response) return actor;
  try {
    const q = req.nextUrl.searchParams;
    const limit = Number(q.get("limit") ?? 50);
    const entries = await withWorkspaceScope(actor.workspaceId, (tx) =>
      listJournal(tx, actor.workspaceId, {
        limit: Number.isFinite(limit) ? limit : 50,
        from: parseReportDate(q.get("from"), false),
        to: parseReportDate(q.get("to"), true),
        sourceType: optString(q.get("sourceType")),
        sourceId: optString(q.get("sourceId")),
        accountId: optString(q.get("accountId")),
      }),
    );
    return Response.json({ entries });
  } catch (err) {
    return financeError(err);
  }
}
