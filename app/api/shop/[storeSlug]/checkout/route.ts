// ShapesOS — Phase 10 (store): POST /api/shop/[storeSlug]/checkout
//   { captchaToken? } → { url } (the tenant's Stripe Checkout page)
//
// PUBLIC BY DESIGN (buyers have no account): the store must be PUBLISHED
// (SELECT-only routing policy; unknown/unpublished → 404). The order is
// built ONLY from the database: the signed cart cookie names products and
// quantities, and lib/ops/store/checkout.ts re-validates price, stock and
// the promotion server-side before creating a DRAFT OpsOrder (source web)
// and a Stripe Checkout Session with the WORKSPACE'S OWN Stripe key (FINANCE
// integration; never the platform billing key). No key → 409 telling the
// buyer the store owner must connect Stripe — never a fake success. Nothing
// is paid here: payment is recorded only by the Stripe-signed tenant
// webhook. Bot protection: per-store+IP limit (10 / 10 min) plus the CAPTCHA
// step-up from the second attempt when a provider is configured
// (lib/ops/store/limits.ts, lib/auth/captcha.ts). 4 KiB body cap.

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { OpsError } from "@/lib/ops/doctype";
import { appBaseUrl } from "@/lib/workspace/invite-mail";
import { createStoreCheckout, StoreNotConnectedError } from "@/lib/ops/store/checkout";
import { checkoutCaptchaDue, verifyCaptchaToken } from "@/lib/ops/store/limits";
import { cartFromRequest, readSmallJson, shopContext } from "@/lib/ops/store/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ storeSlug: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const { storeSlug } = await params;
  const ctx = await shopContext(req, storeSlug, "checkout");
  if (ctx instanceof Response) return ctx;
  const body = await readSmallJson(req);
  if (body instanceof Response) return body;
  if (checkoutCaptchaDue(ctx.attempt) && !(await verifyCaptchaToken(typeof body.captchaToken === "string" ? body.captchaToken : "", ctx.ip))) {
    return NextResponse.json({ error: "Complete the security check, then try again.", code: "captcha_required" }, { status: 400 });
  }
  const cart = cartFromRequest(req, ctx.store);
  try {
    const origin = new URL(req.url).origin;
    const out = await createStoreCheckout(ctx.store, cart, { baseUrl: appBaseUrl(process.env, origin) ?? origin });
    return NextResponse.json({ url: out.url }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof StoreNotConnectedError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    if (err instanceof OpsError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error(`[shop-checkout] ${ctx.store.id}: ${(err as Error)?.name ?? "error"}`);
    return NextResponse.json({ error: "Checkout failed. Try again in a moment." }, { status: 500 });
  }
}
