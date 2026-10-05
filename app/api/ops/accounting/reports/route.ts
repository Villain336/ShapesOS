// ShapesOS — Phase 10 (finance): GET /api/ops/accounting/reports.
//   ?kind=trial_balance|profit_and_loss|balance_sheet&from=YYYY-MM-DD&to=YYYY-MM-DD
// Trial balance and balance sheet are cumulative to `to` (as-of); P&L covers
// [from, to]. Viewer+.

import type { NextRequest } from "next/server";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { parseReportDate, runReport, type ReportKind } from "@/lib/ops/accounting";
import { financeError, financeGuard } from "@/lib/ops/finance/http";

export const dynamic = "force-dynamic";

const KINDS: ReportKind[] = ["trial_balance", "profit_and_loss", "balance_sheet"];

export async function GET(req: NextRequest) {
  const actor = await financeGuard("viewer");
  if (actor instanceof Response) return actor;
  try {
    const q = req.nextUrl.searchParams;
    const kind = (q.get("kind") ?? "trial_balance") as ReportKind;
    if (!KINDS.includes(kind)) {
      return Response.json({ error: `kind must be one of ${KINDS.join(", ")}` }, { status: 400 });
    }
    const from = parseReportDate(q.get("from"), false);
    const to = parseReportDate(q.get("to"), true);
    const report = await withWorkspaceScope(actor.workspaceId, (tx) =>
      runReport(tx, actor.workspaceId, kind, { from, to }),
    );
    return Response.json({ kind, from: from ?? null, to: to ?? null, report });
  } catch (err) {
    return financeError(err);
  }
}
