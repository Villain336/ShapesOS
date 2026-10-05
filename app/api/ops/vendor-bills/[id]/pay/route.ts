// ShapesOS — Phase 10 (finance): POST /api/ops/vendor-bills/[id]/pay.
// Paying a vendor moves money — a gated write (OPS_BILL_PAY):
//   { amountCents, note?, providerRef? }             → 202 approval_required
//   { amountCents, note?, providerRef?, approvalId } → records the payout,
//      Dr AP / Cr Cash; the bill is paid when nothing is left. Editor+.
// ShapesOS records the payment; the money itself moves in your bank.

import { z } from "zod";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { payBill } from "@/lib/ops/finance/purchasing";
import { runGated } from "@/lib/ops/finance/gated";
import { financeError, financeGuard, gatedResponse, optString, readJsonBody } from "@/lib/ops/finance/http";
import { fmtMoney } from "@/lib/ops/finance/money";

export const dynamic = "force-dynamic";

const Body = z.object({
  amountCents: z.number().int().positive().max(2_147_483_647),
  note: z.string().max(2000).optional(),
  providerRef: z.string().max(128).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await financeGuard("editor");
  if (actor instanceof Response) return actor;
  try {
    const { id } = await params;
    const raw = await readJsonBody(req);
    const parsed = Body.safeParse(raw);
    if (!raw || !parsed.success) return Response.json({ error: parsed.error?.issues[0]?.message ?? "Invalid payment" }, { status: 400 });
    const input = parsed.data;
    const result = await withWorkspaceScope(actor.workspaceId, async (tx) => {
      const bill = await tx.opsVendorBill.findFirst({ where: { id, workspaceId: actor.workspaceId }, include: { vendor: { select: { name: true } } } });
      if (!bill) return null;
      return runGated(
        tx,
        actor,
        {
          slug: "OPS_BILL_PAY",
          entity: "vendor-bills",
          entityId: id,
          mutation: { id, pay: input },
          summary: `Pay ${fmtMoney(input.amountCents)} to ${bill.vendor?.name ?? "vendor"} on bill ${bill.number ?? id} (${fmtMoney(bill.totalCents - bill.paidCents)} open)`,
          approvalId: optString(raw.approvalId),
        },
        () => payBill(tx, actor, id, input),
      );
    });
    if (!result) return Response.json({ error: `vendor-bills "${id}" not found in workspace` }, { status: 404 });
    return gatedResponse(result, "result");
  } catch (err) {
    return financeError(err);
  }
}
