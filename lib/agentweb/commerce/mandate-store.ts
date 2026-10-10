// ShapesOS — Phase 21A round 2 (WS=agentweb): mandates at rest (agentweb_mandates, FORCE RLS).
//
// Lifecycle: pending (an agent asked) -> signed (a person clicked the Tier 3 card) -> used
// (a checkout consumed it, exactly once); or rejected; or expired by the clock. Every
// transition goes through here; signing and consuming are conditional updates on the current
// status, so two clicks or two checkouts cannot both win.

import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { authorityAudit } from "@/lib/authority/db";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { assertNoCardData, normalizeCart, totalMinor, type Cart } from "./cart";
import { mandateContents, mandateSecret, MandateRefused, signMandate, verifyMandate, type SignedMandate, type SigningChannel, type VerifiedMandate, type VerifyFailure } from "./mandate";

type Tx = Prisma.TransactionClient;

export const MAX_PENDING_MANDATES = 10;
export const DEFAULT_MANDATE_TTL_MS = 30 * 60_000;
export const MAX_MANDATE_TTL_MS = 24 * 3_600_000;

export class MandateStoreError extends Error {
  constructor(
    readonly code: "too_many_pending" | "not_found" | "not_pending" | "not_signed" | "already_used" | VerifyFailure,
    message: string,
  ) {
    super(message);
    this.name = "MandateStoreError";
  }
}

export type MandateStatus = "pending" | "signed" | "rejected" | "used" | "expired";

export interface MandateView {
  id: string;
  runId: string | null;
  requestedBy: string;
  merchantName: string;
  merchantOrigin: string;
  items: Cart["items"];
  amountMinor: number;
  currency: string;
  cartHash: string;
  expiresAt: string;
  status: MandateStatus;
  signedBy: string | null;
  signedAt: string | null;
  usedAt: string | null;
  checkoutRef: string | null;
  createdAt: string;
}

type Row = {
  id: string;
  runId: string | null;
  requestedBy: string;
  merchantName: string;
  merchantOrigin: string;
  cart: unknown;
  cartHash: string;
  amountMinor: number;
  currency: string;
  expiresAt: Date;
  status: string;
  signedBy: string | null;
  signedAt: Date | null;
  via: string | null;
  alg: string | null;
  signature: string | null;
  usedAt: Date | null;
  checkoutRef: string | null;
  createdAt: Date;
};

const statusOf = (r: Row, now: Date): MandateStatus => ((r.status === "pending" || r.status === "signed") && r.expiresAt.getTime() < now.getTime() ? "expired" : (r.status as MandateStatus));
const cartOf = (r: Row): Cart => normalizeCart({ ...(r.cart as object), runId: r.runId ?? undefined });
const nonceOf = (r: Row): string => String((r.cart as { nonce?: unknown }).nonce ?? "");

const view = (r: Row, now: Date): MandateView => {
  const c = cartOf(r);
  return {
    id: r.id,
    runId: r.runId,
    requestedBy: r.requestedBy,
    merchantName: r.merchantName,
    merchantOrigin: r.merchantOrigin,
    items: c.items,
    amountMinor: r.amountMinor,
    currency: r.currency,
    cartHash: r.cartHash,
    expiresAt: r.expiresAt.toISOString(),
    status: statusOf(r, now),
    signedBy: r.signedBy,
    signedAt: r.signedAt?.toISOString() ?? null,
    usedAt: r.usedAt?.toISOString() ?? null,
    checkoutRef: r.checkoutRef,
    createdAt: r.createdAt.toISOString(),
  };
};

const audit = (workspaceId: string, actor: string, action: string, id: string, detail: Record<string, unknown>) => authorityAudit.logAsync({ workspaceId, actor, action, entityType: "agentweb_mandate", entityId: id, detail });

/** An agent (or a person) asks for a cart to be approved. Nothing is paid or ordered by this. */
export async function createMandate(workspaceId: string, input: { runId?: string | null; requestedBy: string; cart: unknown; ttlMs?: number }, now: Date = new Date()): Promise<MandateView> {
  const cart = normalizeCart(input.cart);
  assertNoCardData(input.cart);
  const ttl = Math.min(Math.max(input.ttlMs ?? DEFAULT_MANDATE_TTL_MS, 60_000), MAX_MANDATE_TTL_MS);
  const id = `man_${randomBytes(10).toString("hex")}`;
  const expiresAt = new Date(now.getTime() + ttl);
  const contents = mandateContents({ id, workspaceId, cart: { ...cart, runId: input.runId ?? cart.runId ?? null }, expiresAt });
  const row = await withWorkspaceScope(workspaceId, async (tx) => {
    const pending = await (tx as Tx).agentwebMandate.count({ where: { workspaceId, status: "pending", expiresAt: { gt: now } } });
    if (pending >= MAX_PENDING_MANDATES) throw new MandateStoreError("too_many_pending", `There are already ${MAX_PENDING_MANDATES} carts waiting for approval. Approve or reject some first.`);
    return (tx as Tx).agentwebMandate.create({
      data: {
        id,
        workspaceId,
        runId: input.runId ?? null,
        requestedBy: input.requestedBy,
        merchantName: cart.merchant.name,
        merchantOrigin: cart.merchant.origin,
        cart: { merchant: cart.merchant, items: cart.items, currency: cart.currency, nonce: contents.nonce } as unknown as Prisma.InputJsonValue,
        cartHash: contents.cartHash,
        amountMinor: totalMinor(cart),
        currency: cart.currency,
        expiresAt,
      },
    });
  });
  await audit(workspaceId, input.requestedBy, "agentweb.mandate.requested", id, { merchant: cart.merchant.origin, amountMinor: totalMinor(cart), currency: cart.currency, cartHash: contents.cartHash, runId: input.runId ?? null, expiresAt: expiresAt.toISOString() });
  return view(row as Row, now);
}

async function load(tx: Tx, workspaceId: string, id: string): Promise<Row> {
  const r = await tx.agentwebMandate.findFirst({ where: { id, workspaceId } });
  if (!r) throw new MandateStoreError("not_found", "That cart request was not found.");
  return r as Row;
}

export async function getMandate(workspaceId: string, id: string, now: Date = new Date()): Promise<MandateView | null> {
  const r = await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebMandate.findFirst({ where: { id, workspaceId } }));
  return r ? view(r as Row, now) : null;
}

export async function listMandates(workspaceId: string, opts: { status?: MandateStatus; runId?: string; limit?: number } = {}, now: Date = new Date()): Promise<MandateView[]> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    (tx as Tx).agentwebMandate.findMany({ where: { workspaceId, ...(opts.runId ? { runId: opts.runId } : {}) }, orderBy: { createdAt: "desc" }, take: Math.min(opts.limit ?? 50, 200) }),
  );
  const views = rows.map((r) => view(r as Row, now));
  return opts.status ? views.filter((v) => v.status === opts.status) : views;
}

/** The click on the Tier 3 card. Throws MandateRefused for any other channel, a viewer, an expired request or no secret. */
export async function signMandateById(workspaceId: string, id: string, approval: { userId: string; role: string; channel: SigningChannel }, now: Date = new Date(), secret: string | null = mandateSecret()): Promise<MandateView> {
  const row = await withWorkspaceScope(workspaceId, async (tx) => {
    const r = await load(tx as Tx, workspaceId, id);
    if (statusOf(r, now) !== "pending") throw new MandateStoreError("not_pending", "This cart request is no longer waiting for approval.");
    const signed = signMandate(mandateContents({ id, workspaceId, cart: cartOf(r), expiresAt: r.expiresAt, nonce: nonceOf(r) }), approval, secret, now);
    const done = await (tx as Tx).agentwebMandate.updateMany({
      where: { id, workspaceId, status: "pending" },
      data: { status: "signed", signedBy: signed.signedBy, signedAt: new Date(signed.signedAt), via: signed.via, alg: signed.alg, signature: signed.signature },
    });
    if (done.count !== 1) throw new MandateStoreError("not_pending", "This cart request was already decided.");
    return load(tx as Tx, workspaceId, id);
  });
  await audit(workspaceId, `user:${approval.userId}`, "agentweb.mandate.signed", id, { merchant: row.merchantOrigin, amountMinor: row.amountMinor, currency: row.currency, cartHash: row.cartHash, via: "ui_click", runId: row.runId });
  return view(row, now);
}

export async function rejectMandateById(workspaceId: string, id: string, userId: string, now: Date = new Date()): Promise<MandateView> {
  const row = await withWorkspaceScope(workspaceId, async (tx) => {
    const r = await load(tx as Tx, workspaceId, id);
    const done = await (tx as Tx).agentwebMandate.updateMany({ where: { id, workspaceId, status: { in: ["pending", "signed"] } }, data: { status: "rejected" } });
    if (done.count !== 1) throw new MandateStoreError("not_pending", `This cart request is already ${statusOf(r, now)}.`);
    return load(tx as Tx, workspaceId, id);
  });
  await audit(workspaceId, `user:${userId}`, "agentweb.mandate.rejected", id, { merchant: row.merchantOrigin, amountMinor: row.amountMinor, runId: row.runId });
  return view(row, now);
}

/**
 * Verify the signed mandate against the cart being bought and mark it used, once. Returns the
 * VerifiedMandate checkout needs. Any failure (not signed, wrong cart, expired, used) throws.
 */
export async function consumeMandate(workspaceId: string, id: string, cart: Cart, now: Date = new Date(), secret: string | null = mandateSecret()): Promise<VerifiedMandate> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const r = await load(tx as Tx, workspaceId, id);
    if (r.status === "used") throw new MandateStoreError("already_used", "This cart approval was already used.");
    if (r.status !== "signed" || !r.signedBy || !r.signedAt || !r.signature) throw new MandateStoreError("not_signed", "The person has not signed this cart yet.");
    const signed: SignedMandate = {
      contents: mandateContents({ id, workspaceId, cart: cartOf(r), expiresAt: r.expiresAt, nonce: nonceOf(r) }),
      signedBy: r.signedBy,
      signedAt: r.signedAt.toISOString(),
      via: "ui_click",
      alg: "hmac-sha256",
      signature: r.signature,
    };
    const v = verifyMandate(signed, { secret, now, cart, workspaceId });
    if (!v.ok) throw new MandateStoreError(v.reason, `This cart approval does not hold (${v.reason.replace(/_/g, " ")}).`);
    const done = await (tx as Tx).agentwebMandate.updateMany({ where: { id, workspaceId, status: "signed", usedAt: null }, data: { status: "used", usedAt: now } });
    if (done.count !== 1) throw new MandateStoreError("already_used", "This cart approval was already used.");
    return v.mandate;
  });
}

export async function markCheckoutRef(workspaceId: string, id: string, ref: string): Promise<void> {
  await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebMandate.updateMany({ where: { id, workspaceId }, data: { checkoutRef: ref.slice(0, 200) } }));
}

export { MandateRefused };
