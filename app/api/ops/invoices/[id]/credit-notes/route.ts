// ShapesOS — Phase 10 (finance): POST /api/ops/invoices/[id]/credit-notes.
// Issue a credit note against an open invoice — a gated write
// (OPS_CREDIT_NOTE_ISSUE):
//   { reason, amountCents | lineItems }             → 202 approval_required
//   { reason, amountCents | lineItems, approvalId } → issues CN-0001, reduces
//      the invoice balance and posts Dr Sales + Dr Tax / Cr AR.
// Editor+.

import { z } from "zod";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { getInvoice, issueCreditNote } from "@/lib/ops/finance/invoicing";
import { runGated } from "@/lib/ops/finance/gated";
import { financeError, financeGuard, gatedResponse, optString, readJsonBody } from "@/lib/ops/finance/http";
import { fmtMoney } from "@/lib/ops/finance/money";

export const dynamic = "force-dynamic";

const Body = z.object({
  reason: z.string().min(1).max(500),
  amountCents: z.number().int().positive().max(2_147_483_647).optional(),
  lineItems: z
    .array(
      z.object({
        description: z.string().min(1).max(500),
        qty: z.number().int().min(1).max(100_000),
        priceCents: z.number().int().min(0).max(1_000_000_000),
        taxRateId: z.string().min(1).max(64).optional(),
      }),
    )
    .min(1)
    .max(200)
    .optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await financeGuard("editor");
  if (actor instanceof Response) return actor;
  try {
    const { id } = await params;
    const raw = await readJsonBody(req);
    if (!raw) return Response.json({ error: "Invalid JSON" }, { status: 400 });
    const parsed = Body.safeParse(raw);
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid credit note" }, { status: 400 });
    const input = parsed.data;
    const result = await withWorkspaceScope(actor.workspaceId, async (tx) => {
      const inv = await getInvoice(tx, actor, id);
      const what = input.amountCents !== undefined ? fmtMoney(input.amountCents) : `${input.lineItems?.length ?? 0} line(s)`;
      return runGated(
        tx,
        actor,
        {
          slug: "OPS_CREDIT_NOTE_ISSUE",
          entity: "invoices",
          entityId: id,
          mutation: { id, creditNote: input },
          summary: `Issue a credit note of ${what} against invoice ${String(inv.number ?? id)} — ${input.reason}`,
          approvalId: optString(raw.approvalId),
        },
        () => issueCreditNote(tx, actor, id, input),
      );
    });
    return gatedResponse(result, "result");
  } catch (err) {
    return financeError(err);
  }
}
