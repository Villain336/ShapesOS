// ShapesOS — Phase 21A round 2 (WS=agentweb): what happens after the person's click.
//
// signMandateById recorded the person's signature. This decides what that buys: if the
// merchant has a checkout we can drive AND a payment rail exists, the mandate is consumed
// (once) and the checkout completed with it. Otherwise nothing is consumed and the outcome is
// "stopped at payment": the agent filled the cart, the person finishes at the merchant. In
// every case the outcome goes into the audit chain and onto the run's timeline.

import { authorityAudit } from "@/lib/authority/db";
import { normalizeCart } from "./cart";
import { completeCheckout, noPaymentRail, type CheckoutOutcome } from "./checkout";
import { consumeMandate, getMandate, markCheckoutRef, MandateStoreError } from "./mandate-store";
import { resolveMerchant } from "./merchants";

export type FinishOutcome = CheckoutOutcome | { outcome: "failed"; error: string };

export async function finishAfterSignature(workspaceId: string, mandateId: string, userId: string, now: Date = new Date()): Promise<FinishOutcome> {
  const m = await getMandate(workspaceId, mandateId, now);
  if (!m || m.status !== "signed") return { outcome: "failed", error: "The cart is not signed." };
  const cart = normalizeCart({ merchant: { name: m.merchantName, origin: m.merchantOrigin }, items: m.items, currency: m.currency });
  const merchant = await resolveMerchant(workspaceId, m.merchantOrigin);
  let result: FinishOutcome;
  try {
    if (!merchant) {
      // Nothing to drive: do not use the mandate up. The person finishes at the merchant.
      result = { outcome: "stopped_at_payment", reason: "no_adapter", continueUrl: m.merchantOrigin };
    } else {
      const verified = await consumeMandate(workspaceId, mandateId, cart, now);
      result = await completeCheckout(merchant.adapter, { cart, mandate: verified, rail: merchant.rail ?? noPaymentRail, fallbackUrl: m.merchantOrigin });
      if (result.outcome === "completed") await markCheckoutRef(workspaceId, mandateId, result.order.id);
    }
  } catch (err) {
    result = { outcome: "failed", error: err instanceof MandateStoreError ? err.message : "The checkout could not be completed." };
  }
  await authorityAudit
    .logAsync({ workspaceId, actor: `user:${userId}`, action: "agentweb.checkout", entityType: "agentweb_mandate", entityId: mandateId, detail: { outcome: result.outcome, merchant: m.merchantOrigin, amountMinor: m.amountMinor, currency: m.currency, runId: m.runId } })
    .catch(() => undefined);
  if (m.runId) {
    const { appendAgentRunEvent } = await import("@/lib/agents/runs/service");
    await appendAgentRunEvent(workspaceId, m.runId, { type: "note", summary: `Cart approved by the person: ${result.outcome.replace(/_/g, " ")}`, payload: { mandateId, outcome: result.outcome, merchant: m.merchantOrigin } }).catch(() => undefined);
  }
  return result;
}
