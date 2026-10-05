// Marketr — POST /api/media/pools/:id/virtual-card
// Issue/attach a virtual card for the pool on the CLIENT's own Brex/Ramp
// account (limit = pool cap). Owner-only. Test-mode-first: fake default;
// Brex/Ramp adapters simulate in test mode; live requires explicit keys.
//
// Only the virtual_card_ref is stored — never a PAN, never in logs.

import type { NextRequest } from "next/server";
import { mediaGuard, badRequest, safetyError, requireMediaOwner } from "../../../_lib";
import { VirtualCardSchema } from "../../../_schemas";
import { mediaStores, safetyTablesReady, logMediaAudit } from "@/lib/media/db";
import { cardProviderFor } from "@/lib/media/cards";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await mediaGuard("editor");
  if (gate instanceof Response) return gate;
  const ownerCheck = requireMediaOwner(gate.mediaRole);
  if (ownerCheck) return ownerCheck;
  if (!(await safetyTablesReady())) {
    return Response.json({ error: "Media safety tables not provisioned yet." }, { status: 503 });
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const parsed = VirtualCardSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const { id } = await params;
    const { pools } = mediaStores();
    const pool = await pools.get(id, gate.workspaceId);
    if (!pool) return Response.json({ error: "Pool not found" }, { status: 404 });

    // The money-layer backstop: card limit = pool cap. A decline here
    // survives Marketr software bugs — this is the layer that kills the
    // €7,937/day failure class (no account-level ceiling existed in Apr 2026).
    const provider = cardProviderFor(parsed.data.provider);
    const card = await provider.issueCard({
      poolId: pool.id,
      workspaceId: gate.workspaceId,
      limitCents: pool.capCents,
      currency: pool.currency,
      providerAccountRef: parsed.data.providerAccountRef,
      memo: `ShapesOS media pool ${pool.name} (${pool.id})`,
    });
    const updated = await pools.attachVirtualCard(id, gate.workspaceId, card.cardRef, card.provider);
    // Append-only audit: card issuance is money-adjacent. Only the ref is
    // logged — never a PAN, never key material.
    const { audit } = mediaStores();
    await logMediaAudit(audit, {
      workspaceId: gate.workspaceId,
      actor: gate.userId,
      action: "virtual_card_issued",
      subjectType: "pool",
      subjectId: pool.id,
      detail: { provider: card.provider, cardRef: card.cardRef, limitCents: card.limitCents, currency: card.currency },
    }).catch((e) => console.error("[media-audit] virtual_card_issued write failed:", e));
    return Response.json({
      pool: updated,
      card: {
        provider: card.provider,
        cardRef: card.cardRef,
        status: card.status,
        limitCents: card.limitCents,
        last4Hint: card.last4Hint ?? null,
      },
    });
  } catch (err) {
    return safetyError(err);
  }
}
