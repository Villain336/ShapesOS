// Marketr — create a Stripe Checkout Session for a credit top-up pack.
// POST /api/billing/topup { workspaceId, packId } → { url }
// Admin-only (M11: requireWorkspaceAccess). The workspace credited is the
// authenticated admin's workspace — never a client-supplied target.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { workspaceIdFrom, requireWorkspaceAccess, badRequest } from "@/lib/route-utils";
import { StripeBillingSink, BillingNotConfiguredError, packById } from "@/lib/metering/billing";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let body: { packId?: unknown; workspaceId?: unknown } | null = null;
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid JSON");
  }
  const packId = typeof body?.packId === "string" ? body.packId : "";
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req, body), "admin");
  if ("error" in access) return access.error;

  let pack;
  try {
    pack = packById(packId);
  } catch {
    return badRequest("unknown top-up pack");
  }

  const sink = new StripeBillingSink();
  const origin = req.nextUrl.origin;
  try {
    const { url } = await sink.createTopUpCheckout({
      workspaceId: access.workspaceId,
      packId: pack.id,
      successUrl: `${origin}/dashboard/settings/usage?topup=success`,
      cancelUrl: `${origin}/dashboard/settings/usage?topup=cancelled`,
    });
    return Response.json({ url });
  } catch (e) {
    if (e instanceof BillingNotConfiguredError) {
      return Response.json({ error: e.message }, { status: 503 });
    }
    return Response.json({ error: "Failed to create checkout session" }, { status: 500 });
  }
}
