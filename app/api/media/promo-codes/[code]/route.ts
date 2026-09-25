// Marketr — POST /api/media/promo-codes/[code] (record a redemption).
// { orderRef? } → { promo, orderRef }. Redemption flows into the ledger.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { mediaGuard, badRequest } from "../../_lib";
import { getMediaStore } from "@/lib/media/store";
import { createPromoService } from "@/lib/media/promo";

export const dynamic = "force-dynamic";

const RedeemSchema = z.object({
  orderRef: z.string().trim().max(128).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const gate = await mediaGuard("editor");
  if (gate instanceof Response) return gate;
  const { code } = await params;

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = RedeemSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const svc = createPromoService(getMediaStore());
    const result = await svc.redeem(gate.workspaceId, decodeURIComponent(code), parsed.data.orderRef ?? null);
    return Response.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Redemption failed";
    return Response.json({ error: msg }, { status: msg.includes("not found") ? 404 : 400 });
  }
}
