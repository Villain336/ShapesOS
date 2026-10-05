// ShapesOS — Phase 10 (finance): POST /api/ops/accounting/journal/[id]/reverse.
// Reversing an entry moves the books — a gated write (OPS_JOURNAL_REVERSE):
//   { memo? }              → 202 { approval_required, approval }
//   { memo?, approvalId }  → verifies (fail-closed) and posts the mirror entry.
// Editor+. One reversal per entry; a reversal can't be reversed.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { getJournalEntry, reverseEntry } from "@/lib/ops/accounting";
import { runGated } from "@/lib/ops/finance/gated";
import { financeError, financeGuard, gatedResponse, optString, readJsonBody } from "@/lib/ops/finance/http";
import { fmtMoney } from "@/lib/ops/finance/money";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await financeGuard("editor");
  if (actor instanceof Response) return actor;
  try {
    const { id } = await params;
    const body = await readJsonBody(req);
    if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });
    const memo = optString(body.memo)?.slice(0, 2000) ?? null;
    const result = await withWorkspaceScope(actor.workspaceId, async (tx) => {
      const entry = await getJournalEntry(tx, actor.workspaceId, id);
      return runGated(
        tx,
        actor,
        {
          slug: "OPS_JOURNAL_REVERSE",
          entity: "journal-entries",
          entityId: id,
          mutation: { id, reverse: true, memo },
          summary: `Reverse journal entry ${id} (${fmtMoney(entry.totalCents)})${entry.memo ? ` — ${entry.memo}` : ""}`,
          approvalId: optString(body.approvalId),
        },
        async () => (await reverseEntry(tx, actor, id, { memo })).entry,
      );
    });
    return gatedResponse(result, "entry");
  } catch (err) {
    return financeError(err);
  }
}
