// ShapesOS — Phase 12 (mfgpos): POST /api/ops/pos/sessions/[id]/quote.
// Price a till sale without writing anything: { lines, promoCode? } →
// { quote: { subtotalCents, discountCents, taxCents, totalCents, promo, blocker } }.
// The same server-side pricing the sale itself uses (priceCart: catalog
// prices, the promotion, the register's tax rate). Editor+ (cashiers).

import { z } from "zod";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { financeError, financeGuard, readJsonBody } from "@/lib/ops/finance/http";
import { quoteSale } from "@/lib/ops/pos/service";

export const dynamic = "force-dynamic";

const id = z.string().min(1).max(64);
const Body = z.object({
  lines: z.array(z.object({ productId: id, variantId: id.nullable().optional(), qty: z.number().int().min(1).max(10_000) })).max(200),
  promoCode: z.string().trim().max(64).nullable().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await financeGuard("editor");
  if (actor instanceof Response) return actor;
  try {
    const { id: sessionId } = await params;
    const raw = await readJsonBody(req);
    const parsed = Body.safeParse(raw);
    if (!raw || !parsed.success) return Response.json({ error: parsed.error?.issues[0]?.message ?? "Invalid sale" }, { status: 400 });
    const quote = await withWorkspaceScope(actor.workspaceId, (tx) => quoteSale(tx, actor, sessionId, parsed.data.lines, parsed.data.promoCode ?? null));
    return Response.json({ quote });
  } catch (err) {
    return financeError(err);
  }
}
