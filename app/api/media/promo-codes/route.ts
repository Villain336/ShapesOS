// Marketr — /api/media/promo-codes.
// POST: mint a unique code per station/spot/publication.
//   { channelRefs: string[], prefix?, buyId?, maxRedemptions? }
// GET ?buyId=: list codes (+ rollup).

import type { NextRequest } from "next/server";
import { z } from "zod";
import { mediaGuard, badRequest } from "../_lib";
import { getMediaStore } from "@/lib/media/store";
import { createPromoService, promoRollup } from "@/lib/media/promo";

export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  channelRefs: z.array(z.string().trim().min(1).max(80)).min(1).max(200),
  prefix: z.string().trim().min(1).max(12).optional(),
  buyId: z.string().trim().min(1).max(64).optional(),
  maxRedemptions: z.number().int().positive().nullable().optional(),
});

export async function POST(req: NextRequest) {
  const gate = await mediaGuard("editor");
  if (gate instanceof Response) return gate;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const parsed = CreateSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const svc = createPromoService(getMediaStore());
    const codes = await svc.generate({
      workspaceId: gate.workspaceId,
      buyId: parsed.data.buyId ?? null,
      channelRefs: parsed.data.channelRefs,
      prefix: parsed.data.prefix,
      maxRedemptions: parsed.data.maxRedemptions ?? null,
    });
    return Response.json({ codes, rollup: promoRollup(codes) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Mint failed" }, { status: 400 });
  }
}

export async function GET(req: NextRequest) {
  const gate = await mediaGuard("viewer");
  if (gate instanceof Response) return gate;
  const buyId = req.nextUrl.searchParams.get("buyId") ?? undefined;
  const svc = createPromoService(getMediaStore());
  const codes = await svc.list(gate.workspaceId, buyId);
  return Response.json({ codes, rollup: promoRollup(codes) });
}
