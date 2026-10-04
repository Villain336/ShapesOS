// ShapesOS — Phase 10 (finance): Stripe payments for TENANTS' invoices.
//
// Uses the workspace's OWN Stripe secret key, stored with the existing
// secrets() envelope (lib/secrets) in ops_finance_settings — never the
// platform's billing key (STRIPE_SECRET_KEY, lib/metering/billing.ts), which
// this module never reads. Without a stored key the UI says "connect Stripe".
//
//   createInvoiceCheckout  a Checkout Session for the invoice's balance due
//                          (metadata: workspace_id, invoice_id); the URL is
//                          saved on the invoice and shown in the PDF/email.
//   handleStripeWebhook    POST /api/ops/stripe/webhook/<workspaceId>: the
//                          Stripe-Signature is verified with THAT workspace's
//                          webhook secret (stripe.webhooks.constructEvent)
//                          before anything is parsed; checkout.session.completed
//                          applies the payment (idempotent per payment intent).
//
// UNVERIFIED-LIVE: exercised against a stub Stripe client in tests; no live
// Stripe account was used.

import Stripe from "stripe";
import type { Prisma } from "@prisma/client";
import { secrets } from "@/lib/secrets";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { OpsError, type OpsActor } from "../doctype";
import { applyInvoicePayment } from "./invoicing";
import { balanceDueCents } from "./money";

type Tx = Prisma.TransactionClient;

/** Minimal Stripe surface we use — injectable for tests. */
export interface StripeLike {
  checkout: { sessions: { create(params: Record<string, unknown>): Promise<{ id: string; url: string | null }> } };
  webhooks: { constructEvent(payload: string, header: string, secret: string): { id: string; type: string; data: { object: unknown } } };
}

export type StripeFactory = (secretKey: string) => StripeLike;

export const realStripe: StripeFactory = (key) => new Stripe(key) as unknown as StripeLike;

export function stripeKeyHint(key: string): string {
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

export function validStripeSecret(key: string): boolean {
  return /^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/.test(key);
}

export function validWebhookSecret(key: string): boolean {
  return /^whsec_[A-Za-z0-9+/=]{8,}$/.test(key);
}

export interface FinanceSettingsView {
  stripeConnected: boolean;
  stripeSecretHint: string | null;
  stripeWebhookConfigured: boolean;
  invoiceFromName: string | null;
  invoiceFooter: string | null;
  currency: string;
}

export async function getFinanceSettingsView(tx: Tx, workspaceId: string): Promise<FinanceSettingsView> {
  const s = await tx.opsFinanceSettings.findUnique({ where: { workspaceId } });
  return {
    stripeConnected: Boolean(s?.stripeSecretEnc),
    stripeSecretHint: s?.stripeSecretHint ?? null,
    stripeWebhookConfigured: Boolean(s?.stripeWebhookSecretEnc),
    invoiceFromName: s?.invoiceFromName ?? null,
    invoiceFooter: s?.invoiceFooter ?? null,
    currency: s?.currency ?? "USD",
  };
}

export interface FinanceSettingsInput {
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  disconnectStripe?: boolean;
  invoiceFromName?: string | null;
  invoiceFooter?: string | null;
  currency?: string;
}

export async function saveFinanceSettings(tx: Tx, actor: OpsActor, input: FinanceSettingsInput): Promise<FinanceSettingsView> {
  const data: Prisma.OpsFinanceSettingsUncheckedUpdateInput = { updatedBy: actor.userId };
  if (input.disconnectStripe) {
    data.stripeSecretEnc = null;
    data.stripeSecretHint = null;
    data.stripeWebhookSecretEnc = null;
  }
  if (input.stripeSecretKey !== undefined) {
    const k = input.stripeSecretKey.trim();
    if (!validStripeSecret(k)) throw new OpsError(400, "That doesn't look like a Stripe secret key (sk_live_… / sk_test_… / rk_…)");
    data.stripeSecretEnc = secrets().encrypt(k);
    data.stripeSecretHint = stripeKeyHint(k);
  }
  if (input.stripeWebhookSecret !== undefined) {
    const w = input.stripeWebhookSecret.trim();
    if (!validWebhookSecret(w)) throw new OpsError(400, "That doesn't look like a Stripe webhook signing secret (whsec_…)");
    data.stripeWebhookSecretEnc = secrets().encrypt(w);
  }
  if (input.invoiceFromName !== undefined) data.invoiceFromName = input.invoiceFromName?.trim().slice(0, 200) || null;
  if (input.invoiceFooter !== undefined) data.invoiceFooter = input.invoiceFooter?.trim().slice(0, 1000) || null;
  if (input.currency !== undefined) {
    if (!/^[A-Z]{3}$/.test(input.currency)) throw new OpsError(400, "Currency must be a 3-letter ISO code");
    data.currency = input.currency;
  }
  await tx.opsFinanceSettings.upsert({
    where: { workspaceId: actor.workspaceId },
    create: { ...(data as Prisma.OpsFinanceSettingsUncheckedCreateInput), workspaceId: actor.workspaceId },
    update: data,
  });
  await tx.opsAuditEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      entity: "finance-settings",
      entityId: actor.workspaceId,
      action: "update",
      actor: actor.userId,
      summary: `finance settings updated${input.stripeSecretKey ? " (Stripe key set)" : ""}${input.stripeWebhookSecret ? " (webhook secret set)" : ""}${input.disconnectStripe ? " (Stripe disconnected)" : ""}`,
    },
  });
  return getFinanceSettingsView(tx, actor.workspaceId);
}

async function tenantKeys(tx: Tx, workspaceId: string): Promise<{ secretKey: string | null; webhookSecret: string | null; currency: string }> {
  const s = await tx.opsFinanceSettings.findUnique({ where: { workspaceId } });
  return {
    secretKey: s?.stripeSecretEnc ? secrets().decrypt(s.stripeSecretEnc) : null,
    webhookSecret: s?.stripeWebhookSecretEnc ? secrets().decrypt(s.stripeWebhookSecretEnc) : null,
    currency: s?.currency ?? "USD",
  };
}

export class StripeNotConnectedError extends OpsError {
  constructor() {
    super(409, "Connect Stripe first: add your Stripe secret key in Finance settings.");
    this.name = "StripeNotConnectedError";
  }
}

/** Create a Checkout Session for an open invoice's balance and save its URL. */
export async function createInvoiceCheckout(
  actor: OpsActor,
  invoiceId: string,
  opts: { baseUrl: string; stripe?: StripeFactory },
): Promise<{ url: string; sessionId: string }> {
  const { keys, inv } = await withWorkspaceScope(actor.workspaceId, async (tx) => ({
    keys: await tenantKeys(tx, actor.workspaceId),
    inv: await tx.opsInvoice.findFirst({ where: { id: invoiceId, workspaceId: actor.workspaceId } }),
  }));
  if (!inv) throw new OpsError(404, `invoices "${invoiceId}" not found in workspace`);
  if (!keys.secretKey) throw new StripeNotConnectedError();
  if (inv.kind !== "invoice" || (inv.status !== "sent" && inv.status !== "overdue")) {
    throw new OpsError(422, "Payment links are for sent or overdue invoices");
  }
  const balance = balanceDueCents(inv);
  if (balance <= 0) throw new OpsError(422, "Nothing is due on this invoice");
  const stripe = (opts.stripe ?? realStripe)(keys.secretKey);
  const label = inv.number ?? invoiceId;
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: { currency: keys.currency.toLowerCase(), unit_amount: balance, product_data: { name: `Invoice ${label}` } },
      },
    ],
    metadata: { workspace_id: actor.workspaceId, invoice_id: invoiceId },
    payment_intent_data: { metadata: { workspace_id: actor.workspaceId, invoice_id: invoiceId } },
    success_url: `${opts.baseUrl}/?paid=${encodeURIComponent(label)}`,
    cancel_url: `${opts.baseUrl}/`,
  });
  if (!session.url) throw new OpsError(502, "Stripe didn't return a checkout URL");
  await withWorkspaceScope(actor.workspaceId, async (tx) => {
    await tx.opsInvoice.updateMany({
      where: { id: invoiceId, workspaceId: actor.workspaceId },
      data: { paymentLinkUrl: session.url, stripeSessionId: session.id },
    });
    await tx.opsAuditEvent.create({
      data: {
        workspaceId: actor.workspaceId,
        entity: "invoices",
        entityId: invoiceId,
        action: "payment_link",
        actor: actor.userId,
        summary: `Stripe Checkout link created for ${label} (session ${session.id}, ${balance}c)`,
      },
    });
  });
  return { url: session.url, sessionId: session.id };
}

export interface WebhookOutcome {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Verify and apply a tenant Stripe webhook. Signature first (fail-closed:
 * no secret → 503, bad signature → 400); then only
 * checkout.session.completed with payment_status "paid" and our metadata is
 * acted on. Idempotent: one payment per payment intent (row lock on an
 * advisory key + lookup), and the journal posting is keyed by payment id.
 */
export async function handleStripeWebhook(
  workspaceId: string,
  rawBody: string,
  signature: string | null,
  opts: { stripe?: StripeFactory } = {},
): Promise<WebhookOutcome> {
  const keys = await withWorkspaceScope(workspaceId, (tx) => tenantKeys(tx, workspaceId));
  if (!keys.webhookSecret || !keys.secretKey) return { status: 503, body: { error: "Stripe webhooks are not configured for this workspace" } };
  if (!signature) return { status: 400, body: { error: "Missing Stripe-Signature" } };
  let event: { id: string; type: string; data: { object: unknown } };
  try {
    event = (opts.stripe ?? realStripe)(keys.secretKey).webhooks.constructEvent(rawBody, signature, keys.webhookSecret);
  } catch {
    return { status: 400, body: { error: "Invalid signature" } };
  }
  if (event.type !== "checkout.session.completed") return { status: 200, body: { received: true, ignored: event.type } };
  const session = event.data.object as {
    id: string;
    payment_status?: string;
    amount_total?: number | null;
    payment_intent?: string | null;
    metadata?: Record<string, string> | null;
  };
  const invoiceId = session.metadata?.invoice_id;
  if (session.metadata?.workspace_id !== workspaceId || !invoiceId) {
    return { status: 200, body: { received: true, ignored: "not an invoice checkout for this workspace" } };
  }
  if (session.payment_status !== "paid" || !session.amount_total) {
    return { status: 200, body: { received: true, ignored: `payment_status ${session.payment_status ?? "unknown"}` } };
  }
  const providerRef = session.payment_intent ?? session.id;
  const actor: OpsActor = { workspaceId, userId: "stripe-webhook" };
  const result = await withWorkspaceScope(workspaceId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`stripe:${workspaceId}:${providerRef}`}))`;
    const prior = await tx.opsPayment.findFirst({ where: { workspaceId, provider: "stripe", providerRef } });
    if (prior) return { duplicate: true, paymentId: prior.id };
    const inv = await tx.opsInvoice.findFirst({ where: { id: invoiceId, workspaceId } });
    const balance = inv ? balanceDueCents(inv) : 0;
    if (!inv || (inv.status !== "sent" && inv.status !== "overdue") || session.amount_total! > balance) {
      // Money arrived that no longer fits the invoice (already paid / voided
      // / balance changed): record nothing automatically, flag it for a person.
      await tx.opsAuditEvent.create({
        data: {
          workspaceId,
          entity: "invoices",
          entityId: invoiceId,
          action: "stripe_payment_unapplied",
          actor: actor.userId,
          summary: `Stripe payment ${providerRef} (${session.amount_total}c) could not be applied automatically (invoice ${inv?.status ?? "missing"}, balance ${balance}c) — reconcile by hand`,
        },
      });
      return { duplicate: false, unapplied: true };
    }
    const r = await applyInvoicePayment(tx, actor, {
      invoiceId,
      amountCents: session.amount_total!,
      provider: "stripe",
      providerRef,
      note: `Stripe Checkout ${session.id} (event ${event.id})`,
    });
    return { duplicate: false, paymentId: r.payment.id, status: r.invoice.status };
  });
  return { status: 200, body: { received: true, ...result } };
}
