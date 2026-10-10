// ShapesOS — Phase 21A round 2 (WS=agentweb): checkout orchestration (PURE over adapters).
//
// What may complete a checkout: a VerifiedMandate (lib/agentweb/commerce/mandate.ts) for
// exactly this cart, and nothing else. completeCheckout is the only way to reach an
// adapter's complete(); it refuses anything the verifier did not produce. When a merchant
// supports neither ACP nor AP2, or no payment rail is configured, the agent fills the cart
// and STOPS: the person finishes at the merchant's own payment page (a typed outcome with
// the link). Card details never pass through here: assertNoCardData guards every request.

import { assertNoCardData, totalMinor, type Cart } from "./cart";
import { isVerified, type VerifiedMandate } from "./mandate";

export class MandateRequired extends Error {
  constructor() {
    super("A checkout can only be completed with a cart mandate the person signed for exactly this cart.");
    this.name = "MandateRequired";
  }
}

/** What the merchant's checkout reports after we create a session. */
export interface CheckoutSession {
  id: string;
  currency: string;
  totalMinor: number;
  /** Where the person can finish this checkout themselves. */
  continueUrl: string | null;
  status: string;
}

export interface PaymentCredential {
  /** The payment handler the merchant accepts (ACP handler id), e.g. a Stripe shared payment token handler. */
  handlerId: string;
  /** An opaque delegated token (NOT a card number). */
  token: string;
  tokenType: string;
}

export interface OrderRef {
  id: string;
  checkoutSessionId: string;
  permalinkUrl: string | null;
}

export interface CheckoutAdapter {
  readonly id: "acp";
  createSession(cart: Cart, mandate: VerifiedMandate): Promise<CheckoutSession>;
  complete(session: CheckoutSession, mandate: VerifiedMandate, payment: PaymentCredential): Promise<OrderRef>;
  cancel(session: CheckoutSession): Promise<void>;
}

/** The seam to a payment service provider (delegated payment tokens). None is wired by default. */
export interface PaymentRail {
  credential(mandate: VerifiedMandate): Promise<PaymentCredential | null>;
}

/** No PSP configured: every checkout stops at the payment step for the person. */
export const noPaymentRail: PaymentRail = { credential: async () => null };

export type CheckoutOutcome =
  | { outcome: "completed"; order: OrderRef; amountMinor: number }
  | { outcome: "stopped_at_payment"; reason: "no_adapter" | "no_payment_rail"; continueUrl: string | null }
  | { outcome: "price_changed"; expectedMinor: number; gotMinor: number; currency: string };

export interface MerchantCapabilities {
  acp?: { baseUrl: string };
  ap2?: boolean;
}

export function planCheckout(caps: MerchantCapabilities): { path: "acp" | "handoff"; why: string } {
  if (caps.acp) return { path: "acp", why: "the merchant offers an ACP checkout" };
  // AP2 mandate exchange is built against fakes only (lib/agentweb/commerce/ap2.ts) and needs a
  // merchant agent plus a wallet credential we do not have: it is never chosen automatically.
  return { path: "handoff", why: caps.ap2 ? "the merchant speaks AP2, which needs a wallet credential this install does not have; the person finishes at the merchant" : "the merchant supports neither ACP nor AP2; the person finishes at the merchant" };
}

export async function completeCheckout(adapter: CheckoutAdapter | null, args: { cart: Cart; mandate: unknown; rail: PaymentRail; fallbackUrl?: string | null }): Promise<CheckoutOutcome> {
  if (!isVerified(args.mandate)) throw new MandateRequired();
  const mandate = args.mandate;
  assertNoCardData({ cart: args.cart });
  if (!adapter) return { outcome: "stopped_at_payment", reason: "no_adapter", continueUrl: args.fallbackUrl ?? null };
  const payment = await args.rail.credential(mandate);
  if (!payment) return { outcome: "stopped_at_payment", reason: "no_payment_rail", continueUrl: args.fallbackUrl ?? null };
  assertNoCardData(payment);
  const session = await adapter.createSession(args.cart, mandate);
  // The merchant may have changed the price since the person signed: never pay a different amount.
  if (session.totalMinor !== mandate.contents.amountMinor || session.currency !== mandate.contents.currency) {
    await adapter.cancel(session).catch(() => undefined);
    return { outcome: "price_changed", expectedMinor: mandate.contents.amountMinor, gotMinor: session.totalMinor, currency: session.currency };
  }
  const order = await adapter.complete(session, mandate, payment);
  return { outcome: "completed", order, amountMinor: totalMinor(args.cart) };
}
