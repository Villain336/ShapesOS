// ShapesOS — Phase 12 (mfgpos): point of sale on the Ops layer.
//
//   registers   a till: stock location, tax rate, Stripe Terminal reader
//   sessions    open with an opening float (POS-0001) → sell → count the
//               cash (closing: expected vs counted) → close (gated, Tier 3):
//               ONE balanced journal entry — sales, tax, cash, card
//               clearing, cash over/short. One open session per register.
//   sales       recordPosSale: an OpsOrder (source "pos", fulfilled, paid)
//               with OpsPayment rows (cash / card), priced server-side by the
//               storefront's priceCart (promotions included), stock booked
//               through the ledger (bookSale, the register's location first).
//               Keyed on the till's client order id: the offline queue's
//               replay of a sale that already landed returns that order.
//
// No sale posts to the books on its own; the session close does, once
// (sourceKey pos_session:<id>:close).

import type { Prisma } from "@prisma/client";
import { emitOpsEvent, orderPaidEvent } from "@/lib/webhooks/ops-events";
import { auditOpsEvent, OpsError, OpsNotFoundError, type OpsActor } from "../doctype";
import { OPS_ENTITY_MAP } from "../entities";
import type { FinanceDocInput } from "../finance/pdf";
import { hasFinanceLedger, nextDocumentNumber } from "../finance/numbering";
import { postPosSessionClose } from "../finance/posting";
import { promotionByCode } from "../store/catalog";
import { bookSale, type WebOrderLine } from "../store/orders";
import { checkoutBlocker, itemKey, priceCart, type CatalogItem } from "../store/pricing";
import { orderLabel } from "../store/view";
import { defaultVariantId } from "../stock";
import {
  canMoveSession,
  cashDifferenceCents,
  describeDifference,
  expectedCashCents,
  sessionTotals,
  tender,
  TenderError,
  type PosPaymentInput,
  type SessionTotals,
} from "./rules";

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;

const def = (slug: string) => OPS_ENTITY_MAP[slug]!;
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

// ---------------------------------------------------------------------------
// Registers
// ---------------------------------------------------------------------------

async function checkRegisterRefs(tx: Tx, actor: OpsActor, body: Row) {
  if (typeof body.locationId === "string") {
    const l = await tx.opsLocation.findFirst({ where: { id: body.locationId, workspaceId: actor.workspaceId } });
    if (!l) throw new OpsNotFoundError("locations", body.locationId);
  }
  if (typeof body.taxRateId === "string") {
    const t = await tx.opsTaxRate.findFirst({ where: { id: body.taxRateId, workspaceId: actor.workspaceId } });
    if (!t) throw new OpsNotFoundError("tax-rates", body.taxRateId);
  }
}

export async function createRegisterRow(tx: Tx, actor: OpsActor, body: Row): Promise<Row> {
  await checkRegisterRefs(tx, actor, body);
  return tx.opsPosRegister.create({
    data: {
      workspaceId: actor.workspaceId,
      name: String(body.name).trim(),
      locationId: str(body.locationId),
      taxRateId: str(body.taxRateId),
      terminalReaderId: str(body.terminalReaderId),
    },
  }) as unknown as Row;
}

export async function patchRegisterRow(tx: Tx, actor: OpsActor, id: string, patch: Row): Promise<Row> {
  await checkRegisterRefs(tx, actor, patch);
  return tx.opsPosRegister.update({ where: { id, workspaceId: actor.workspaceId }, data: patch as Prisma.OpsPosRegisterUncheckedUpdateInput }) as unknown as Row;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Open a till session (one open/closing session per register). */
export async function openSessionRow(tx: Tx, actor: OpsActor, body: Row): Promise<Row> {
  const registerId = String(body.registerId);
  const reg = await tx.opsPosRegister.findFirst({ where: { id: registerId, workspaceId: actor.workspaceId } });
  if (!reg) throw new OpsNotFoundError("pos-registers", registerId);
  if (!reg.active) throw new OpsError(422, `Register "${reg.name}" is inactive`);
  // Serialize openers of this register; the partial unique index backs it up.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pos-register:${actor.workspaceId}:${registerId}`}))`;
  const open = await tx.opsPosSession.findFirst({ where: { workspaceId: actor.workspaceId, registerId, status: { not: "closed" } } });
  if (open) throw new OpsError(409, `Register "${reg.name}" already has an open session (${open.number ?? open.id}) — close it first`);
  const number = await nextDocumentNumber(tx, actor.workspaceId, "pos_session");
  return tx.opsPosSession.create({
    data: {
      workspaceId: actor.workspaceId,
      registerId,
      number,
      status: "open",
      openedBy: actor.userId,
      openingCashCents: body.openingCashCents as number,
      note: str(body.note),
    },
  }) as unknown as Row;
}

export async function loadSessionTotals(tx: Tx, workspaceId: string, sessionId: string): Promise<SessionTotals> {
  const orders = await tx.opsOrder.findMany({
    where: { workspaceId, posSessionId: sessionId },
    select: { id: true, status: true, totalCents: true, taxCents: true, discountCents: true },
  });
  const payments = orders.length
    ? await tx.opsPayment.findMany({
        where: { workspaceId, orderId: { in: orders.map((o) => o.id) } },
        select: { provider: true, kind: true, status: true, amountCents: true },
      })
    : [];
  return sessionTotals(orders, payments);
}

function snapshot(t: SessionTotals) {
  return {
    orderCount: t.orderCount,
    netSalesCents: t.netSalesCents,
    discountCents: t.discountCents,
    taxCents: t.taxCents,
    cashSalesCents: t.cashSalesCents,
    cardSalesCents: t.cardSalesCents,
  };
}

/** Hook for PATCH /api/ops/pos-sessions: count (closing), re-open, close (gated). */
export async function patchSession(tx: Tx, actor: OpsActor, id: string, patch: Row, existing: Row): Promise<Row> {
  const to = str(patch.status);
  const from = String(existing.status);
  if (!to) {
    if (patch.countedCashCents !== undefined) throw new OpsError(400, 'Count the cash with status "closing"');
    return tx.opsPosSession.update({ where: { id, workspaceId: actor.workspaceId }, data: { note: (patch.note as string | null | undefined) ?? undefined } }) as unknown as Row;
  }
  if (!canMoveSession(from, to)) throw new OpsError(409, `A till session can't move from ${from} to ${to}`);
  const guard = { id, workspaceId: actor.workspaceId, status: from as "open" };
  const now = new Date();
  if (to === "closing") {
    if (typeof patch.countedCashCents !== "number") throw new OpsError(400, "Enter the counted cash (countedCashCents) to start closing");
    const totals = await loadSessionTotals(tx, actor.workspaceId, id);
    const expected = expectedCashCents(Number(existing.openingCashCents), totals.cashSalesCents);
    const claimed = await tx.opsPosSession.updateMany({
      where: guard,
      data: {
        status: "closing",
        countedCashCents: patch.countedCashCents,
        countedBy: actor.userId,
        countedAt: now,
        expectedCashCents: expected,
        cashDifferenceCents: cashDifferenceCents(patch.countedCashCents, expected),
        ...snapshot(totals),
      },
    });
    if (claimed.count !== 1) throw new OpsError(409, "The session changed concurrently — reload and retry");
  } else if (to === "open") {
    const claimed = await tx.opsPosSession.updateMany({
      where: guard,
      data: { status: "open", countedCashCents: null, countedBy: null, countedAt: null, expectedCashCents: null, cashDifferenceCents: null },
    });
    if (claimed.count !== 1) throw new OpsError(409, "The session changed concurrently — reload and retry");
  } else {
    return closeSession(tx, actor, id);
  }
  return (await tx.opsPosSession.findFirst({ where: { id, workspaceId: actor.workspaceId } })) as unknown as Row;
}

/**
 * Close a counted session: recompute the totals from its orders and
 * payments, claim closing → closed and post ONE balanced entry. Runs only
 * behind an approved OPS_POS_SESSION_CLOSE (the generic PATCH gate).
 */
export async function closeSession(tx: Tx, actor: OpsActor, id: string): Promise<Row> {
  const s = await tx.opsPosSession.findFirst({ where: { id, workspaceId: actor.workspaceId }, include: { register: { select: { taxRateId: true, name: true } } } });
  if (!s) throw new OpsNotFoundError("pos-sessions", id);
  if (s.status === "closed") return s as unknown as Row;
  if (s.status !== "closing" || s.countedCashCents == null) throw new OpsError(409, "Count the cash first (move the session to closing)");
  const totals = await loadSessionTotals(tx, actor.workspaceId, id);
  const expected = expectedCashCents(s.openingCashCents, totals.cashSalesCents);
  const diff = cashDifferenceCents(s.countedCashCents, expected);
  const closedAt = new Date();
  const claimed = await tx.opsPosSession.updateMany({
    where: { id, workspaceId: actor.workspaceId, status: "closing" },
    data: { status: "closed", closedBy: actor.userId, closedAt, expectedCashCents: expected, cashDifferenceCents: diff, ...snapshot(totals) },
  });
  if (claimed.count !== 1) throw new OpsError(409, "The session changed concurrently — reload and retry");
  let journalEntryId: string | null = null;
  if (hasFinanceLedger(tx)) {
    const posted = await postPosSessionClose(
      tx,
      actor,
      { id, number: s.number, closedAt },
      { netSalesCents: totals.netSalesCents, taxCents: totals.taxCents, cashSalesCents: totals.cashSalesCents, cardSalesCents: totals.cardSalesCents, cashDifferenceCents: diff },
      { taxRateId: s.register.taxRateId },
    );
    journalEntryId = posted?.entry.id ?? null;
    if (journalEntryId) await tx.opsPosSession.update({ where: { id }, data: { journalEntryId } });
  }
  await auditOpsEvent(
    tx,
    def("pos-sessions"),
    actor,
    "close",
    id,
    `till session ${s.number ?? id} (${s.register.name}) closed: ${totals.orderCount} sale(s), ${totals.netSalesCents + totals.taxCents}c taken (${totals.cashSalesCents}c cash, ${totals.cardSalesCents}c card); cash ${describeDifference(diff)}${journalEntryId ? `; journal ${journalEntryId}` : ""}`,
  );
  return (await tx.opsPosSession.findFirst({ where: { id, workspaceId: actor.workspaceId } })) as unknown as Row;
}

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

export interface PosSaleLineInput {
  productId: string;
  variantId?: string | null;
  qty: number;
}

/** A payment as the route verified it (card refs re-read from the terminal adapter). */
export type VerifiedPayment = PosPaymentInput & { provider: "cash" | "stripe_terminal" | "stripe_terminal_mock" };

export interface PosSaleInput {
  clientOrderId: string;
  lines: PosSaleLineInput[];
  promoCode?: string | null;
  payments: VerifiedPayment[];
}

export interface PosSaleResult {
  orderId: string;
  label: string;
  replayed: boolean;
  totalCents: number;
  changeCents: number;
  oversold: string[];
}

/** Catalog snapshot for the till (every active product; tracked stock never blocks a physical sale). */
async function tillCatalog(tx: Tx, workspaceId: string, lines: PosSaleLineInput[]): Promise<Map<string, CatalogItem>> {
  const ids = [...new Set(lines.map((l) => l.productId))];
  const products = await tx.opsProduct.findMany({ where: { workspaceId, id: { in: ids } } });
  const variantIds = [...new Set(lines.map((l) => l.variantId).filter((v): v is string => Boolean(v)))];
  const variants = variantIds.length ? await tx.opsProductVariant.findMany({ where: { workspaceId, id: { in: variantIds } } }) : [];
  const out = new Map<string, CatalogItem>();
  for (const l of lines) {
    const p = products.find((x) => x.id === l.productId);
    if (!p) continue;
    const v = l.variantId ? variants.find((x) => x.id === l.variantId && x.productId === p.id) : null;
    if (l.variantId && !v) continue;
    out.set(itemKey(p.id, l.variantId ?? null), {
      productId: p.id,
      variantId: v?.id ?? defaultVariantId(p.id),
      publicVariantId: v?.id ?? null,
      listingId: "",
      listingSlug: "",
      name: v ? `${p.name} — ${v.name}` : p.name,
      sku: v?.sku ?? p.sku,
      productSku: p.sku,
      unitPriceCents: v?.priceCents ?? p.priceCents,
      trackInventory: p.trackInventory,
      available: null,
      sellable: p.active && (v ? v.active : true),
    });
  }
  return out;
}

export async function recordPosSale(tx: Tx, actor: OpsActor, sessionId: string, input: PosSaleInput): Promise<PosSaleResult> {
  // One writer per client order id: a replay racing its original waits, then sees it.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pos-sale:${actor.workspaceId}:${input.clientOrderId}`}))`;
  const prior = await tx.opsOrder.findFirst({ where: { workspaceId: actor.workspaceId, clientOrderId: input.clientOrderId } });
  if (prior) {
    return { orderId: prior.id, label: orderLabel(prior.id), replayed: true, totalCents: prior.totalCents, changeCents: 0, oversold: [] };
  }
  const session = await tx.opsPosSession.findFirst({ where: { id: sessionId, workspaceId: actor.workspaceId }, include: { register: true } });
  if (!session) throw new OpsNotFoundError("pos-sessions", sessionId);
  if (session.status !== "open") throw new OpsError(409, `Session ${session.number ?? sessionId} is ${session.status} — open a session to sell`);

  const cartLines = input.lines.map((l) => ({ productId: l.productId, variantId: l.variantId ?? null, qty: l.qty }));
  const catalog = await tillCatalog(tx, actor.workspaceId, cartLines);
  let taxRateBps = 0;
  if (session.register.taxRateId) {
    const r = await tx.opsTaxRate.findFirst({ where: { id: session.register.taxRateId, workspaceId: actor.workspaceId, active: true }, select: { rateBps: true } });
    taxRateBps = r?.rateBps ?? 0;
  }
  const promoCode = input.promoCode?.trim() || null;
  const priced = priceCart({ lines: cartLines, catalog, promoCode, promotion: await promotionByCode(tx, actor.workspaceId, promoCode), taxRateBps });
  // Stock never blocks a till sale (the goods are on the counter); the rest does.
  const blocking = { ...priced, lines: priced.lines.map((l) => (l.issue?.kind === "insufficient_stock" ? { ...l, issue: null } : l)) };
  const blocker = checkoutBlocker(blocking);
  if (blocker) throw new OpsError(409, blocker.replace("Remove it to continue.", "Remove it from the sale.").replace("Your cart is empty.", "The sale is empty."));

  let tendered;
  try {
    tendered = tender(priced.totalCents, input.payments);
  } catch (err) {
    if (err instanceof TenderError) throw new OpsError(400, err.message);
    throw err;
  }
  // A card payment reference pays for exactly one sale.
  for (const p of input.payments) {
    if (p.method !== "card") continue;
    const used = await tx.opsPayment.findFirst({ where: { workspaceId: actor.workspaceId, provider: p.provider, providerRef: p.providerRef } });
    if (used) throw new OpsError(409, "That card payment is already recorded on another sale");
  }

  const lines: WebOrderLine[] = priced.lines.map((l) => ({
    name: l.item!.name,
    sku: l.item!.sku,
    qty: l.qty,
    priceCents: l.item!.unitPriceCents,
    productId: l.item!.productId,
    variantId: l.item!.variantId,
  }));
  const promoOk = priced.promo?.ok ? priced.promo : null;
  const paidAt = new Date();
  const order = await tx.opsOrder.create({
    data: {
      workspaceId: actor.workspaceId,
      status: "fulfilled",
      source: "pos",
      posSessionId: sessionId,
      clientOrderId: input.clientOrderId,
      lineItems: lines as unknown as Prisma.InputJsonValue,
      subtotalCents: priced.subtotalCents,
      discountCents: priced.discountCents,
      taxCents: priced.taxCents,
      totalCents: priced.totalCents,
      promotionId: promoOk?.promotionId ?? null,
      promotionCode: promoOk?.code ?? null,
      paidAt,
    },
  });
  for (const p of input.payments) {
    await tx.opsPayment.create({
      data: {
        workspaceId: actor.workspaceId,
        orderId: order.id,
        kind: "charge",
        provider: p.provider,
        providerRef: p.method === "card" ? p.providerRef : null,
        amountCents: p.amountCents,
        status: "succeeded",
        note:
          p.method === "cash"
            ? `till cash${p.tenderedCents !== undefined ? ` (handed ${p.tenderedCents}c, change ${p.tenderedCents - p.amountCents}c)` : ""}`
            : p.provider === "stripe_terminal_mock"
              ? "till card — MOCK terminal payment (POS_TERMINAL_MOCK), not real money"
              : "till card (Stripe Terminal)",
      },
    });
  }
  if (promoOk?.promotionId) {
    await tx.opsPromotion.updateMany({ where: { id: promoOk.promotionId, workspaceId: actor.workspaceId }, data: { usedCount: { increment: 1 } } });
  }
  const label = orderLabel(order.id);
  const stock = await bookSale(tx, actor, order.id, lines, null, {
    preferLocationId: session.register.locationId,
    label: `till sale ${label} (${session.number ?? sessionId})`,
    actorName: `pos:${session.number ?? sessionId}`,
  });
  await auditOpsEvent(
    tx,
    def("orders"),
    actor,
    "pos_sale",
    order.id,
    `till sale ${label} on ${session.number ?? sessionId}: ${priced.totalCents}c (${tendered.cashCents}c cash, ${tendered.cardCents}c card${promoOk ? `, code ${promoOk.code} −${priced.discountCents}c` : ""}); ${stock.moves} stock move(s)${stock.oversold.length ? `, OVERSOLD ${stock.oversold.join(", ")}` : ""}`,
  );
  await emitOpsEvent(tx, actor.workspaceId, orderPaidEvent(order as unknown as Row, "pos"));
  return { orderId: order.id, label, replayed: false, totalCents: priced.totalCents, changeCents: tendered.changeCents, oversold: stock.oversold };
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

export interface SessionSummary {
  id: string;
  number: string | null;
  status: string;
  registerId: string;
  registerName: string;
  openedAt: Date;
  openingCashCents: number;
  countedCashCents: number | null;
  expectedCashCents: number;
  cashDifferenceCents: number | null;
  journalEntryId: string | null;
  totals: SessionTotals;
}

export async function sessionSummary(tx: Tx, workspaceId: string, id: string): Promise<SessionSummary> {
  const s = await tx.opsPosSession.findFirst({ where: { id, workspaceId }, include: { register: { select: { name: true } } } });
  if (!s) throw new OpsNotFoundError("pos-sessions", id);
  const totals = await loadSessionTotals(tx, workspaceId, id);
  const expected = expectedCashCents(s.openingCashCents, totals.cashSalesCents);
  return {
    id: s.id,
    number: s.number,
    status: s.status,
    registerId: s.registerId,
    registerName: s.register.name,
    openedAt: s.openedAt,
    openingCashCents: s.openingCashCents,
    countedCashCents: s.countedCashCents,
    expectedCashCents: expected,
    cashDifferenceCents: s.countedCashCents == null ? null : cashDifferenceCents(s.countedCashCents, expected),
    journalEntryId: s.journalEntryId,
    totals,
  };
}

/** Receipt document for a till sale (rendered by lib/ops/finance/pdf.tsx). */
export async function receiptDoc(tx: Tx, workspaceId: string, orderId: string): Promise<FinanceDocInput> {
  const o = await tx.opsOrder.findFirst({ where: { id: orderId, workspaceId, source: "pos" }, include: { payments: true, posSession: { include: { register: { select: { name: true } } } } } });
  if (!o) throw new OpsNotFoundError("orders", orderId);
  const ws = await tx.workspace.findFirst({ where: { id: workspaceId }, select: { name: true } });
  const fin = await tx.opsFinanceSettings.findUnique({ where: { workspaceId } });
  const lines = (o.lineItems as unknown as WebOrderLine[]) ?? [];
  const paid = o.payments.filter((p) => p.status === "succeeded");
  const payNote = paid
    .map((p) => `${p.provider === "cash" ? "Cash" : p.provider === "stripe_terminal_mock" ? "Card (mock terminal)" : "Card"} ${(p.amountCents / 100).toFixed(2)}`)
    .join(" · ");
  return {
    kind: "Receipt",
    number: orderLabel(o.id),
    issuedAt: o.paidAt ?? o.createdAt,
    fromName: fin?.invoiceFromName ?? ws?.name ?? "Receipt",
    toName: o.customerName ?? "Walk-in customer",
    toDetail: o.posSession ? `${o.posSession.register.name} · session ${o.posSession.number ?? o.posSession.id}` : null,
    lines: lines.map((l) => ({ description: l.sku ? `${l.name} (${l.sku})` : l.name, qty: l.qty, priceCents: l.priceCents })),
    subtotalCents: o.subtotalCents,
    discountCents: o.discountCents,
    taxCents: o.taxCents,
    totalCents: o.totalCents,
    notes: [o.promotionCode ? `Code ${o.promotionCode}` : null, payNote ? `Paid: ${payNote}` : null].filter(Boolean).join(" · ") || null,
    footer: fin?.invoiceFooter ?? "Thank you",
    currency: fin?.currency ?? "USD",
  };
}
