// ShapesOS — Phase 10 (store): web orders paid through the tenant's Stripe.
//
// handleStoreCheckoutEvent is called by FINANCE's signed tenant webhook
// (lib/ops/finance/stripe.ts handleStripeWebhook) AFTER the Stripe-Signature
// verified against that workspace's own webhook secret, for Checkout
// Sessions whose metadata carries an order_id:
//
//   checkout.session.completed (payment_status "paid") /
//   checkout.session.async_payment_succeeded
//       → markWebOrderPaid, in ONE transaction:
//           claim   order draft → confirmed (status-guarded: exactly once)
//           payment OpsPayment charge, provider "stripe", providerRef = the
//                   real payment intent id (session id if none)
//           stock   a "sale" OpsInventoryTxn per tracked line (the ledger;
//                   picks located stock — the store's warehouse first —
//                   then unlocated)
//           promo   OpsPromotion.usedCount + 1 (only via the claim → once)
//           books   Dr Cash / Cr Sales (+ Cr Tax), keyed web_order:<id>:paid
//         Redelivery: the payment lookup under an advisory lock on the
//         provider ref returns { duplicate: true } before any write.
//   checkout.session.expired / async_payment_failed
//       → the draft order is cancelled (status-guarded; a paid order is
//         never touched).
//
// Money that arrives for an order it no longer fits (amount mismatch, order
// not a draft) is NOT applied automatically: an audit row flags it for a
// person, mirroring the invoice path.

import { emitOpsEvent, orderPaidEvent } from "@/lib/webhooks/ops-events";
import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { OPS_ENTITY_MAP } from "../entities";
import { auditOpsEvent, recordInventoryTxn, type OpsActor } from "../doctype";
import { defaultVariantId } from "../stock";
import { postWebOrderSale } from "../finance/posting";
import { orderLabel } from "./view";

type Tx = Prisma.TransactionClient;

export interface StoreWebhookOutcome {
  status: number;
  body: Record<string, unknown>;
}

interface CheckoutSessionLike {
  id: string;
  payment_status?: string;
  amount_total?: number | null;
  payment_intent?: string | { id: string } | null;
  metadata?: Record<string, string> | null;
  customer_details?: { email?: string | null; name?: string | null } | null;
  customer_email?: string | null;
}

export interface WebOrderLine {
  name: string;
  sku?: string;
  qty: number;
  priceCents: number;
  productId?: string;
  variantId?: string;
  listingId?: string;
}

const ORDERS = () => OPS_ENTITY_MAP["orders"]!;

/** Is this verified Stripe event about a storefront order? */
export function isStoreCheckoutEvent(event: { type: string; data: { object: unknown } }): boolean {
  if (!event.type.startsWith("checkout.session.")) return false;
  const md = (event.data.object as CheckoutSessionLike | null)?.metadata;
  return Boolean(md && typeof md.order_id === "string" && md.order_id);
}

export async function handleStoreCheckoutEvent(
  workspaceId: string,
  event: { id: string; type: string; data: { object: unknown } },
): Promise<StoreWebhookOutcome> {
  const session = event.data.object as CheckoutSessionLike;
  const orderId = session.metadata?.order_id;
  if (session.metadata?.workspace_id !== workspaceId || !orderId) {
    return { status: 200, body: { received: true, ignored: "not a storefront checkout for this workspace" } };
  }
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      if (session.payment_status !== "paid" || !session.amount_total) {
        return { status: 200, body: { received: true, ignored: `payment_status ${session.payment_status ?? "unknown"}` } };
      }
      return { status: 200, body: { received: true, ...(await markWebOrderPaid(workspaceId, orderId, session, event.id)) } };
    case "checkout.session.expired":
    case "checkout.session.async_payment_failed":
      return { status: 200, body: { received: true, ...(await cancelUnpaidWebOrder(workspaceId, orderId, session.id, event.type)) } };
    default:
      return { status: 200, body: { received: true, ignored: event.type } };
  }
}

function intentId(pi: CheckoutSessionLike["payment_intent"]): string | null {
  if (!pi) return null;
  return typeof pi === "string" ? pi : pi.id ?? null;
}

export async function markWebOrderPaid(
  workspaceId: string,
  orderId: string,
  session: CheckoutSessionLike,
  eventId: string,
): Promise<Record<string, unknown>> {
  const providerRef = intentId(session.payment_intent) ?? session.id;
  const actor: OpsActor = { workspaceId, userId: "stripe-webhook" };
  const amount = session.amount_total!;
  return withWorkspaceScope(workspaceId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`stripe:${workspaceId}:${providerRef}`}))`;
    const prior = await tx.opsPayment.findFirst({ where: { workspaceId, provider: "stripe", providerRef } });
    if (prior) return { duplicate: true, paymentId: prior.id, orderId };

    const order = await tx.opsOrder.findFirst({ where: { id: orderId, workspaceId } });
    const fits =
      order && order.source === "web" && order.status === "draft" && order.stripeSessionId === session.id && order.totalCents === amount;
    if (!order || !fits) {
      await auditOpsEvent(
        tx,
        ORDERS(),
        actor,
        "stripe_payment_unapplied",
        orderId,
        `Stripe payment ${providerRef} (${amount}c, session ${session.id}) could not be applied automatically (order ${order?.status ?? "missing"}, total ${order?.totalCents ?? 0}c) — reconcile by hand`,
      );
      return { duplicate: false, unapplied: true, orderId };
    }

    const paidAt = new Date();
    const email = session.customer_details?.email ?? session.customer_email ?? null;
    const claimed = await tx.opsOrder.updateMany({
      where: { id: orderId, workspaceId, status: "draft" },
      data: {
        status: "confirmed",
        paidAt,
        customerEmail: email?.slice(0, 320) ?? null,
        customerName: session.customer_details?.name?.slice(0, 200) ?? null,
      },
    });
    if (claimed.count !== 1) return { duplicate: true, orderId };

    const payment = await tx.opsPayment.create({
      data: {
        workspaceId,
        orderId,
        kind: "charge",
        provider: "stripe",
        providerRef,
        amountCents: amount,
        status: "succeeded",
        note: `Stripe Checkout ${session.id} (event ${eventId})`,
      },
    });

    const stock = await bookSale(tx, actor, order.id, (order.lineItems as unknown as WebOrderLine[]) ?? [], order.storeId);

    let promoNote = "";
    if (order.promotionId) {
      await tx.opsPromotion.updateMany({ where: { id: order.promotionId, workspaceId }, data: { usedCount: { increment: 1 } } });
      const promo = await tx.opsPromotion.findFirstOrThrow({
        where: { id: order.promotionId, workspaceId },
        select: { code: true, usedCount: true, usageLimit: true },
      });
      promoNote = `, code ${promo.code} used ${promo.usedCount}×`;
      if (promo.usageLimit != null && promo.usedCount > promo.usageLimit) {
        await auditOpsEvent(tx, OPS_ENTITY_MAP["promotions"]!, actor, "usage_limit_exceeded", order.promotionId, `promotion ${promo.code} honoured on paid order ${orderLabel(order.id)} past its usage limit (${promo.usedCount}/${promo.usageLimit}) — the buyer had already paid`);
      }
    }

    const store = order.storeId ? await tx.opsStore.findFirst({ where: { id: order.storeId, workspaceId }, select: { taxRateId: true } }) : null;
    const posted = await postWebOrderSale(tx, actor, { id: order.id, totalCents: order.totalCents, taxCents: order.taxCents, paidAt }, { taxRateId: store?.taxRateId, label: orderLabel(order.id) });

    await auditOpsEvent(
      tx,
      ORDERS(),
      actor,
      "paid",
      order.id,
      `web order ${orderLabel(order.id)} paid via Stripe (${amount}c, ${providerRef}) → confirmed; ${stock.moves} stock move(s)${stock.oversold.length ? `, OVERSOLD ${stock.oversold.join(", ")}` : ""}${promoNote}`,
    );
    // Phase 11 (conncore): order.paid, in this transaction (once per order).
    await emitOpsEvent(
      tx,
      workspaceId,
      orderPaidEvent({ ...order, status: "confirmed", paidAt, customerEmail: email } as unknown as Record<string, unknown>, "stripe"),
    );
    return { duplicate: false, orderId, paymentId: payment.id, status: "confirmed", stockMoves: stock.moves, oversold: stock.oversold, journalEntryId: posted?.entry.id ?? null };
  });
}

/**
 * Book the sale on the inventory ledger: for each tracked line take stock
 * from locations holding that variant (the store's warehouse first, larger
 * quants first), then the rest as unlocated. Never refuses — the money is
 * already taken — but reports oversold lines (and audits them).
 */
export async function bookSale(
  tx: Tx,
  actor: OpsActor,
  orderId: string,
  lines: WebOrderLine[],
  storeId: string | null,
): Promise<{ moves: number; oversold: string[] }> {
  let moves = 0;
  const oversold: string[] = [];
  const store = storeId ? await tx.opsStore.findFirst({ where: { id: storeId, workspaceId: actor.workspaceId }, select: { warehouseId: true } }) : null;
  for (const line of lines) {
    if (!line.productId || !(line.qty > 0)) continue;
    const product = await tx.opsProduct.findFirst({ where: { id: line.productId, workspaceId: actor.workspaceId }, select: { trackInventory: true, stockQty: true } });
    if (!product?.trackInventory) continue;
    const variantId = line.variantId ?? defaultVariantId(line.productId);
    const isDefault = variantId === defaultVariantId(line.productId);
    const groups = await tx.opsInventoryTxn.groupBy({
      by: ["locationId", "variantId"],
      where: { workspaceId: actor.workspaceId, productId: line.productId },
      _sum: { delta: true },
    });
    const pid = line.productId;
    const vOf = (g: { variantId: string | null }) => g.variantId ?? defaultVariantId(pid);
    // On hand for this variant before the sale (stock older than the ledger
    // belongs to the default variant — same reading as the catalogue).
    const ledgerAll = groups.reduce((s, g) => s + (g._sum.delta ?? 0), 0);
    const onHand =
      groups.filter((g) => vOf(g) === variantId).reduce((s, g) => s + (g._sum.delta ?? 0), 0) +
      (isDefault ? product.stockQty - ledgerAll : 0);
    if (onHand < line.qty) oversold.push(line.sku ?? line.name);
    // The default variant is materialized on its first move (ensureDefaultVariant).
    const bookVariant = isDefault ? null : variantId;
    const locIds = groups.map((g) => g.locationId).filter((x): x is string => Boolean(x));
    const locs = locIds.length
      ? await tx.opsLocation.findMany({ where: { workspaceId: actor.workspaceId, id: { in: locIds }, active: true }, select: { id: true, warehouseId: true } })
      : [];
    const wh = new Map(locs.map((l) => [l.id, l.warehouseId]));
    const quants = groups
      .filter((g) => g.locationId && wh.has(g.locationId) && vOf(g) === variantId)
      .map((g) => ({ locationId: g.locationId!, qty: g._sum.delta ?? 0, preferred: Boolean(store?.warehouseId) && wh.get(g.locationId!) === store!.warehouseId }))
      .filter((q) => q.qty > 0)
      .sort((a, b) => Number(b.preferred) - Number(a.preferred) || b.qty - a.qty);
    let left = line.qty;
    for (const q of quants) {
      if (left <= 0) break;
      const take = Math.min(left, q.qty);
      await recordInventoryTxn(tx, actor, { productId: line.productId, delta: -take, reason: "sale", variantId: bookVariant, locationId: q.locationId, note: `web order ${orderLabel(orderId)}`, actorName: "storefront" });
      left -= take;
      moves += 1;
    }
    if (left > 0) {
      await recordInventoryTxn(tx, actor, { productId: line.productId, delta: -left, reason: "sale", variantId: bookVariant, locationId: null, note: `web order ${orderLabel(orderId)}`, actorName: "storefront" });
      moves += 1;
    }
  }
  if (oversold.length) {
    await auditOpsEvent(tx, OPS_ENTITY_MAP["inventory-txns"]!, actor, "oversold", orderId, `web order ${orderLabel(orderId)} sold more than on hand: ${oversold.join(", ")} — restock or contact the buyer`);
  }
  return { moves, oversold };
}

export async function cancelUnpaidWebOrder(
  workspaceId: string,
  orderId: string,
  sessionId: string,
  reason: string,
): Promise<Record<string, unknown>> {
  const actor: OpsActor = { workspaceId, userId: "stripe-webhook" };
  return withWorkspaceScope(workspaceId, async (tx) => {
    const r = await tx.opsOrder.updateMany({
      where: { id: orderId, workspaceId, source: "web", status: "draft", stripeSessionId: sessionId },
      data: { status: "cancelled" },
    });
    if (r.count === 1) {
      await auditOpsEvent(tx, ORDERS(), actor, "checkout_expired", orderId, `web order ${orderLabel(orderId)} cancelled: ${reason.replace("checkout.session.", "checkout ")} (session ${sessionId})`);
    }
    return { orderId, cancelled: r.count === 1 };
  });
}
