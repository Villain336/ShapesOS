// ShapesOS — Phase 12 (mfgpos): POST /api/ops/pos/sessions/[id]/sales.
// Ring up a till sale on an open session (editor+):
//   { clientOrderId, lines: [{ productId, variantId?, qty }], promoCode?,
//     payments: [{ method: "cash", amountCents, tenderedCents? }
//              | { method: "card", amountCents, providerRef }] }
//   → 201 { orderId, label, replayed: false, totalCents, changeCents }
//   → 200 { …, replayed: true } when that clientOrderId already landed (the
//     offline queue's replay — never a second sale).
// Prices, promotions and tax are computed server-side (the storefront's
// priceCart); every card payment is re-read from Stripe Terminal (or the
// labelled mock when POS_TERMINAL_MOCK=1) before it is recorded. Stock is
// booked through the ledger; the books are posted when the session closes.

import { z } from "zod";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { financeError, financeGuard, readJsonBody } from "@/lib/ops/finance/http";
import { tenantKeys } from "@/lib/ops/finance/stripe";
import { recordPosSale, type VerifiedPayment } from "@/lib/ops/pos/service";
import { CLIENT_ORDER_ID_RE } from "@/lib/ops/pos/rules";
import { terminalAdapter, TerminalError } from "@/lib/ops/pos/terminal";

export const dynamic = "force-dynamic";

const id = z.string().min(1).max(64);
const Body = z.object({
  clientOrderId: z.string().regex(CLIENT_ORDER_ID_RE, "clientOrderId must be a till order id (pos_…)"),
  lines: z.array(z.object({ productId: id, variantId: id.nullable().optional(), qty: z.number().int().min(1).max(10_000) })).min(1).max(200),
  promoCode: z.string().trim().max(64).nullable().optional(),
  payments: z
    .array(
      z.discriminatedUnion("method", [
        z.object({ method: z.literal("cash"), amountCents: z.number().int().positive().max(2_147_483_647), tenderedCents: z.number().int().positive().max(2_147_483_647).optional() }),
        z.object({ method: z.literal("card"), amountCents: z.number().int().positive().max(2_147_483_647), providerRef: z.string().min(3).max(128) }),
      ]),
    )
    .min(1)
    .max(10),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await financeGuard("editor");
  if (actor instanceof Response) return actor;
  try {
    const { id: sessionId } = await params;
    const raw = await readJsonBody(req);
    const parsed = Body.safeParse(raw);
    if (!raw || !parsed.success) return Response.json({ error: parsed.error?.issues[0]?.message ?? "Invalid sale" }, { status: 400 });
    const input = parsed.data;

    // Card payments: verify with the terminal provider OUTSIDE the DB
    // transaction (a network call never holds row locks).
    const payments: VerifiedPayment[] = [];
    const cards = input.payments.filter((p) => p.method === "card");
    const adapter = cards.length
      ? terminalAdapter((await withWorkspaceScope(actor.workspaceId, (tx) => tenantKeys(tx, actor.workspaceId))).secretKey)
      : null;
    for (const p of input.payments) {
      if (p.method === "cash") {
        payments.push({ ...p, provider: "cash" });
        continue;
      }
      if (!adapter) return Response.json({ error: "Card payments need Stripe connected in Finance settings." }, { status: 409 });
      const got = await adapter.getPayment(p.providerRef);
      if (got.status !== "succeeded") return Response.json({ error: `The card payment isn't complete yet (${got.status.replace(/_/g, " ")}).` }, { status: 409 });
      if (got.amountCents !== p.amountCents) return Response.json({ error: "The card payment amount doesn't match the sale." }, { status: 409 });
      payments.push({ ...p, provider: adapter.provider });
    }

    const result = await withWorkspaceScope(actor.workspaceId, (tx) =>
      recordPosSale(tx, actor, sessionId, { clientOrderId: input.clientOrderId, lines: input.lines, promoCode: input.promoCode ?? null, payments }),
    );
    return Response.json(result, { status: result.replayed ? 200 : 201 });
  } catch (err) {
    if (err instanceof TerminalError) return Response.json({ error: err.message }, { status: err.status === 400 ? 400 : 502 });
    return financeError(err);
  }
}
