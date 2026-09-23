// Marketr — Stripe billing sink (Phase C gap-fill, track G2).
//
// The UsageEvent ledger is the source of truth. Stripe is a downstream
// money pipe used ONLY for hosted top-up purchases — it never decides
// what was spent. Self-hosted Marketr never touches this module: with no
// STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET every method fails closed
// with a plain-language "billing not configured" error (never
// half-initialized).
//
// Money-flow invariant: credits are granted ONLY through the sibling-owned
// applyTopUp after a signature-verified checkout.session.completed whose
// paid amount matches a known pack. See THREAT-MODEL-BILLING.md.

import Stripe from "stripe";
import { Prisma, type BillingOverageInvoice } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { applyTopUp, setSpendCap } from "./service";
import { TOPUP_PACKS, OVERAGE_CREDITS_PER_CENT } from "./credits";

// ── Errors ───────────────────────────────────────────────────────────────────

/** Thrown when Stripe keys are absent. Plain language, no key material. */
export class BillingNotConfiguredError extends Error {
  constructor() {
    super(
      "Stripe billing is not configured on this deployment (hosted-only). " +
        "Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET on the hosted " +
        "deployment to enable top-up purchases. Usage is still metered locally.",
    );
    this.name = "BillingNotConfiguredError";
  }
}

// ── Top-up packs (spec Appendix A; cross-checked against credits.ts) ────────

export interface TopUpPack {
  id: string;
  priceCents: number;
  credits: number;
  label: string;
}

export const TOP_UP_PACKS: TopUpPack[] = [
  { id: "topup-5000", priceCents: 5000, credits: 5000, label: "$50 → 5,000 credits" },
  { id: "topup-22000", priceCents: 20000, credits: 22000, label: "$200 → 22,000 credits (10% bonus)" },
];

// Fail closed on pack-table drift between credits.ts and this module: the
// webhook credits packs by paid amount, so the two tables must agree.
for (const pack of TOP_UP_PACKS) {
  const canonical = (TOPUP_PACKS as readonly { priceCents: number; credits: number }[])
    .find((p) => p.priceCents === pack.priceCents);
  if (!canonical || canonical.credits !== pack.credits) {
    throw new Error(
      `billing pack table drift: ${pack.id} does not match credits.ts TOPUP_PACKS`,
    );
  }
}

export function packById(packId: string): TopUpPack {
  const pack = TOP_UP_PACKS.find((p) => p.id === packId);
  if (!pack) throw new Error(`unknown top-up pack: ${packId}`);
  return pack;
}

/** Display rate for auto-overage: $0.012/credit. */
export const OVERAGE_RATE_DISPLAY = `$${(1 / OVERAGE_CREDITS_PER_CENT / 100).toFixed(3)}/credit`;

// ── Sibling contract bridge ─────────────────────────────────────────────────
// The sibling track (G1) owns lib/metering/service.ts. What landed:
//   setSpendCap(workspaceId, { autoOverage?: boolean }) — the explicit
//     opt-in flag this module flips; default false (hard cap is default).
//   meter() honors cap.autoOverage (or legacy !blockAtCap) for over-cap
//     charges, recording normal UsageEvents — see THREAT-MODEL-BILLING.md B9.
// What has NOT landed: an idempotent object-form applyTopUp (still
// positional). The exactly-once guard table in this module remains the
// dedup for webhook replays until that exists.

export interface TopUpApplication {
  workspaceId: string;
  credits: number;
  idempotencyKey: string;
  /** e.g. "stripe:checkout-session:cs_test_…" */
  source: string;
}

async function applyTopUpContract(args: TopUpApplication): Promise<void> {
  if (!Number.isInteger(args.credits) || args.credits <= 0) {
    throw new Error("top-up credits must be a positive integer");
  }
  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + 1); // 12-month rollover
  // Exactly-once for args.idempotencyKey is enforced by the guard table in
  // this module (insert-first); a future idempotent applyTopUp supersedes it.
  await applyTopUp(args.workspaceId, { creditsAdded: args.credits, expiresAt });
}

export interface OverageToggle {
  workspaceId: string;
  enabled: boolean;
  actorId?: string | null;
}

/**
 * Auto-overage opt-in toggle (admin-only; the route enforces the role).
 * Flips the sibling-owned explicit autoOverage flag (default false).
 * Enabling ALWAYS requires a card on file (OverageCardRequiredError) —
 * no card, no uncapped spend, no exception for unconfigured/self-hosted
 * state (without Stripe there is no card path, so the hard cap stays on
 * and overage cannot accrue unbilled). Audit-logged via FileChangeLog.
 */
export async function setAutoOverage(args: OverageToggle): Promise<{ workspaceId: string; autoOverage: boolean }> {
  if (args.enabled && !(await hasPaymentMethod(args.workspaceId))) {
    throw new OverageCardRequiredError();
  }
  const cap = await setSpendCap(args.workspaceId, { autoOverage: args.enabled });
  await prisma.fileChangeLog.create({
    data: {
      workspaceId: args.workspaceId,
      actor: "user",
      action: "save",
      filePath: "billing/auto-overage",
      summary:
        `Billing: auto-overage ${args.enabled ? "opted in" : "opted out"}` +
        (args.actorId ? ` by ${args.actorId}` : "") +
        ` (${OVERAGE_RATE_DISPLAY} over cap; hard cap is the default)`,
    },
  });
  return { workspaceId: args.workspaceId, autoOverage: cap.autoOverage };
}

// ── Exactly-once guard (INTERIM) ────────────────────────────────────────────
// billing_topup_idempotency: PK on the idempotency key. Insert-first (not
// check-then-insert) so concurrent double-deliveries of the same webhook
// cannot double-apply. Created lazily via DDL — this track owns no Prisma
// migration. INTERIM: the sibling's idempotent applyTopUp is authoritative
// when it lands; this table then doubles as purchase history for the UI.

const IDEMPOTENCY_DDL = `
CREATE TABLE IF NOT EXISTS billing_topup_idempotency (
  idempotency_key  TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  credits          INTEGER NOT NULL,
  amount_cents     INTEGER NOT NULL,
  stripe_session_id TEXT NOT NULL,
  source           TEXT NOT NULL,
  applied_at       TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

let idempotencyReady = false;
async function ensureIdempotencyTable(): Promise<void> {
  if (idempotencyReady) return;
  await prisma.$executeRawUnsafe(IDEMPOTENCY_DDL);
  idempotencyReady = true;
}

function isUniqueViolation(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const rec = e as { code?: string; meta?: { code?: string; message?: string } };
  if (rec.code !== "P2010") return false;
  // Postgres unique_violation; fall back to message sniffing.
  return (
    rec.meta?.code === "23505" ||
    /unique|duplicate|already exists/i.test(rec.meta?.message ?? "")
  );
}

/** Prisma Client unique-constraint violation (P2002) — for insert-first races. */
function isPrismaUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

export interface TopUpPurchase {
  sessionId: string;
  credits: number;
  amountCents: number;
  appliedAt: Date;
  source: string;
}

/** Purchase history for the billing UI (most recent first). */
export async function getTopUpHistory(workspaceId: string): Promise<TopUpPurchase[]> {
  await ensureIdempotencyTable();
  const rows = await prisma.$queryRaw<
    Array<{ stripe_session_id: string; credits: number; amount_cents: number; applied_at: Date; source: string }>
  >`SELECT stripe_session_id, credits, amount_cents, applied_at, source
     FROM billing_topup_idempotency WHERE workspace_id = ${workspaceId}
     ORDER BY applied_at DESC LIMIT 100`;
  return rows.map((r) => ({
    sessionId: r.stripe_session_id,
    credits: r.credits,
    amountCents: r.amount_cents,
    appliedAt: r.applied_at,
    source: r.source,
  }));
}

/** Billing status for the UI: never exposes keys or secrets. */
export async function getBillingStatus(workspaceId: string): Promise<{
  configured: boolean;
  autoOverage: boolean;
  overageRate: string;
  packs: TopUpPack[];
}> {
  const configured = Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
  const cap = await prisma.spendCap.findUnique({ where: { workspaceId } });
  return {
    configured,
    autoOverage: cap?.autoOverage ?? false,
    overageRate: OVERAGE_RATE_DISPLAY,
    packs: TOP_UP_PACKS,
  };
}

// ── Stripe sink ─────────────────────────────────────────────────────────────

export interface TopUpResult {
  workspaceId: string;
  creditsAdded: number;
  /** When these purchased credits expire (12-month rollover). */
  expiresAt: Date;
  /** Provider-side reference (charge/payment-intent id). Null for manual. */
  providerRef: string | null;
}

export interface BillingSink {
  readonly name: string;
  purchaseTopUp(workspaceId: string, packCredits: number): Promise<TopUpResult>;
  billOverage(workspaceId: string, credits: number, periodStart: Date): Promise<{ providerRef: string }>;
}

export interface CheckoutRequest {
  workspaceId: string;
  packId: string;
  successUrl: string;
  cancelUrl: string;
}

export interface WebhookResult {
  ok: boolean;
  reason?: string;
  ignored?: boolean;
  applied?: {
    workspaceId: string;
    credits: number;
    alreadyApplied: boolean;
    /** topup | setup_completed | invoice_paid | invoice_failed */
    kind?: string;
    /** BillingOverageInvoice id, for invoice events. */
    invoiceId?: string;
  };
}

export interface BillingClientConfig {
  secretKey?: string | null;
  webhookSecret?: string | null;
  /** Injected Stripe client (tests). Otherwise constructed from secretKey. */
  client?: Stripe | null;
}

/**
 * Hosted-only Stripe sink. Constructing/using it without configured keys
 * throws BillingNotConfiguredError — self-hosted deployments can never
 * accidentally call out to Stripe.
 */
/** A row stuck "invoicing" longer than this is a crashed worker — safe to reclaim. */
const STALE_INVOICE_MS = 15 * 60 * 1000;
/** How long a replay waits for a mid-flight invoice to settle. */
const INVOICE_SETTLE_WAIT_MS = 10_000;

function alreadyInvoicedResult(
  row: Pick<BillingOverageInvoice, "overageCredits" | "amountCents" | "stripeInvoiceId" | "id">,
): OverageInvoiceResult {
  return {
    status: "already_invoiced",
    alreadyApplied: true,
    overageCredits: row.overageCredits,
    amountCents: row.amountCents,
    stripeInvoiceId: row.stripeInvoiceId,
    invoiceDbId: row.id,
  };
}

export class StripeBillingSink implements BillingSink {
  readonly name = "stripe";
  private readonly secretKey: string | null;
  private readonly webhookSecret: string | null;
  private readonly injectedClient: Stripe | null;

  constructor(config: BillingClientConfig = {}) {
    this.secretKey = config.secretKey ?? process.env.STRIPE_SECRET_KEY ?? null;
    this.webhookSecret = config.webhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET ?? null;
    this.injectedClient = config.client ?? null;
  }

  /** Fail closed when unconfigured — called first in every public method. */
  private requireConfigured(): { secretKey: string; webhookSecret: string } {
    if (!this.secretKey || !this.webhookSecret) throw new BillingNotConfiguredError();
    return { secretKey: this.secretKey, webhookSecret: this.webhookSecret };
  }

  private client(): Stripe {
    const { secretKey } = this.requireConfigured();
    return this.injectedClient ?? new Stripe(secretKey);
  }

  /**
   * Create a Stripe Checkout Session for a top-up pack. The workspaceId is
   * bound server-side into session metadata from the authenticated admin's
   * workspace (the route enforces this) — the client only picks the pack.
   */
  async createTopUpCheckout(req: CheckoutRequest): Promise<{ url: string; sessionId: string }> {
    this.requireConfigured();
    const pack = packById(req.packId);
    const workspaceId = (req.workspaceId ?? "").trim();
    if (!workspaceId) throw new Error("workspaceId is required");
    for (const [label, url] of [["successUrl", req.successUrl], ["cancelUrl", req.cancelUrl]] as const) {
      if (!/^https?:\/\//.test(url ?? "")) throw new Error(`${label} must be an http(s) URL`);
    }
    const session = await this.client().checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: pack.priceCents,
            product_data: { name: `Marketr credit top-up — ${pack.credits.toLocaleString()} credits` },
          },
          quantity: 1,
        },
      ],
      metadata: {
        workspaceId,
        packId: pack.id,
        packCredits: String(pack.credits),
        packPriceCents: String(pack.priceCents),
      },
      success_url: req.successUrl,
      cancel_url: req.cancelUrl,
    });
    if (!session.url) throw new Error("Stripe did not return a checkout URL");
    return { url: session.url, sessionId: session.id };
  }

  /**
   * Handle an inbound Stripe webhook. Signature is verified BEFORE any JSON
   * parsing, business logic, or DB write (B1). Event routing:
   *   - checkout.session.completed (mode=payment): top-up purchase (B2–B4).
   *   - checkout.session.completed (mode=setup): card-on-file for overage
   *     invoices (B11) — attaches the payment method as the customer's
   *     default, idempotent per session.
   *   - invoice.paid: marks the overage invoice row paid (B13).
   *   - invoice.payment_failed: marks the row failed, audit-logs, and the
   *     UI surfaces it (B13). Dunning is a documented follow-up.
   *   - anything else: ignored (never 500 — Stripe would retry forever).
   */
  async handleWebhook(rawBody: string, signature: string | null): Promise<WebhookResult> {
    const { webhookSecret } = this.requireConfigured();
    if (!signature) return { ok: false, reason: "missing_signature" };
    let event: Stripe.Event;
    try {
      event = this.client().webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch {
      // Deliberately no detail: never echo key material or payload fragments.
      return { ok: false, reason: "invalid_signature" };
    }
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode === "setup" || session.metadata?.kind === "overage-payment-method") {
          return this.handleSetupCompleted(session);
        }
        return this.handleTopUpCompleted(session);
      }
      case "invoice.paid":
        return this.handleInvoicePaid(event.data.object as Stripe.Invoice, true);
      case "invoice.payment_failed":
        return this.handleInvoicePaid(event.data.object as Stripe.Invoice, false);
      default:
        return { ok: true, ignored: true };
    }
  }

  /**
   * Top-up purchase path (unchanged semantics from the G2 track: B2–B4).
   * Only checkout.session.completed with payment_status=paid and a paid
   * amount matching a known pack applies credits (B4); the workspace
   * credited is taken ONLY from signed session metadata (B3); replays are
   * idempotent via the exactly-once guard (B2).
   */
  private async handleTopUpCompleted(session: Stripe.Checkout.Session): Promise<WebhookResult> {
    if (session.payment_status !== "paid") return { ok: true, ignored: true, reason: "unpaid" };

    const workspaceId = (session.metadata?.workspaceId ?? "").trim();
    if (!workspaceId) return { ok: false, reason: "missing_workspace" };

    const currency = (session.currency ?? "").toLowerCase();
    if (currency !== "usd") return { ok: false, reason: "bad_currency" };
    const pack = TOP_UP_PACKS.find((p) => p.priceCents === (session.amount_total ?? -1));
    if (!pack) return { ok: false, reason: "unknown_amount" };
    if (Number(session.metadata?.packCredits) !== pack.credits) {
      return { ok: false, reason: "credit_mismatch" };
    }

    const idempotencyKey = `stripe:checkout-session:${session.id}`;
    return this.applyTopUpOnce({
      workspaceId,
      credits: pack.credits,
      idempotencyKey,
      source: `stripe:checkout-session:${session.id}`,
      amountCents: pack.priceCents,
      sessionId: session.id,
    });
  }

  /**
   * Card-on-file path (B11). A setup-mode Checkout Session completed:
   * attach the collected payment method as the Stripe customer's default
   * for invoices, and record hasPaymentMethod. Exactly-once per session
   * (insert-first into billing_setup_idempotency). The session's customer
   * must match the workspace's bound customer (B10) — a setup session for
   * another workspace's customer can never arm this workspace.
   */
  private async handleSetupCompleted(session: Stripe.Checkout.Session): Promise<WebhookResult> {
    const workspaceId = (session.metadata?.workspaceId ?? "").trim();
    if (!workspaceId) return { ok: false, reason: "missing_workspace" };
    const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
    if (!customerId) return { ok: false, reason: "missing_customer" };

    const bw = await getOrCreateBillingWorkspace(workspaceId);
    if (bw.stripeCustomerId && bw.stripeCustomerId !== customerId) {
      return { ok: false, reason: "customer_mismatch" };
    }

    const idempotencyKey = `stripe:setup-session:${session.id}`;
    try {
      await prisma.billingSetupIdempotency.create({
        data: { idempotencyKey, workspaceId, stripeSessionId: session.id },
      });
    } catch (e) {
      if (isPrismaUniqueViolation(e)) {
        const applied = await hasPaymentMethod(workspaceId);
        return {
          ok: true,
          applied: { workspaceId, credits: 0, alreadyApplied: true, kind: "setup_completed" },
          ...(applied ? {} : { reason: "setup_replay_before_attach" }),
        };
      }
      throw e;
    }

    if (!bw.stripeCustomerId) {
      await prisma.billingWorkspace.update({
        where: { workspaceId },
        data: { stripeCustomerId: customerId },
      });
    }

    const setupIntentId =
      typeof session.setup_intent === "string" ? session.setup_intent : session.setup_intent?.id;
    if (!setupIntentId) {
      await prisma.billingSetupIdempotency.delete({ where: { idempotencyKey } }).catch(() => null);
      return { ok: false, reason: "missing_setup_intent" };
    }
    const setupIntent = await this.client().setupIntents.retrieve(setupIntentId);
    const paymentMethodId =
      typeof setupIntent.payment_method === "string"
        ? setupIntent.payment_method
        : setupIntent.payment_method?.id;
    if (!paymentMethodId) {
      await prisma.billingSetupIdempotency.delete({ where: { idempotencyKey } }).catch(() => null);
      return { ok: false, reason: "missing_payment_method" };
    }

    await this.client().customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
    await prisma.billingWorkspace.update({
      where: { workspaceId },
      data: { hasPaymentMethod: true },
    });
    await auditBilling(workspaceId, "Billing: card added on file for overage invoices");
    return {
      ok: true,
      applied: { workspaceId, credits: 0, alreadyApplied: false, kind: "setup_completed" },
    };
  }

  /**
   * Settle an overage invoice row from invoice.paid / invoice.payment_failed
   * (B13). The invoice's Stripe customer must match the workspace's bound
   * customer (B10); an invoice Marketr never issued is ignored, not failed.
   * Webhook ordering: a paid/failed event for an unknown invoice id is
   * ignored (it may belong to a Dashboard-created invoice) — the cron row
   * is authoritative for what Marketr billed.
   */
  private async handleInvoicePaid(invoice: Stripe.Invoice, paid: boolean): Promise<WebhookResult> {
    const stripeInvoiceId = invoice.id;
    const row = await prisma.billingOverageInvoice.findFirst({ where: { stripeInvoiceId } });
    if (!row) return { ok: true, ignored: true, reason: "unknown_invoice" };
    const bw = await prisma.billingWorkspace.findUnique({ where: { workspaceId: row.workspaceId } });
    const invoiceCustomer = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
    if (!bw?.stripeCustomerId || bw.stripeCustomerId !== invoiceCustomer) {
      return { ok: true, ignored: true, reason: "customer_mismatch" };
    }
    const status = paid ? "paid" : "failed";
    if (row.status !== status) {
      await prisma.billingOverageInvoice.update({ where: { id: row.id }, data: { status } });
    }
    await auditBilling(
      row.workspaceId,
      paid
        ? `Billing: overage invoice ${row.period} paid (${row.overageCredits.toLocaleString()} credits)`
        : `Billing: overage invoice ${row.period} payment FAILED — card on file was declined; ` +
          `retry from the Stripe Dashboard or add a new card in Settings → Usage`,
    );
    return {
      ok: true,
      applied: {
        workspaceId: row.workspaceId,
        credits: row.overageCredits,
        alreadyApplied: row.status === status,
        kind: paid ? "invoice_paid" : "invoice_failed",
        invoiceId: row.id,
      },
    };
  }

  /**
   * Exactly-once top-up application. Guard row is inserted FIRST; a PK
   * conflict means this session was already applied — return the prior
   * result without touching the ledger. A conflict whose stored
   * workspaceId differs from the webhook's is rejected loudly (B3).
   */
  private async applyTopUpOnce(args: {
    workspaceId: string;
    credits: number;
    idempotencyKey: string;
    source: string;
    amountCents: number;
    sessionId: string;
  }): Promise<WebhookResult> {
    await ensureIdempotencyTable();
    try {
      await prisma.$executeRaw`
        INSERT INTO billing_topup_idempotency
          (idempotency_key, workspace_id, credits, amount_cents, stripe_session_id, source)
        VALUES (${args.idempotencyKey}, ${args.workspaceId}, ${args.credits},
                ${args.amountCents}, ${args.sessionId}, ${args.source})`;
    } catch (e) {
      if (isUniqueViolation(e)) {
        const rows = await prisma.$queryRaw<Array<{ workspace_id: string; credits: number }>>`
          SELECT workspace_id, credits FROM billing_topup_idempotency
          WHERE idempotency_key = ${args.idempotencyKey} LIMIT 1`;
        const prior = rows[0];
        if (!prior) return { ok: false, reason: "idempotency_read_failed" };
        if (prior.workspace_id !== args.workspaceId) {
          return { ok: false, reason: "workspace_mismatch" };
        }
        return { ok: true, applied: { workspaceId: args.workspaceId, credits: prior.credits, alreadyApplied: true } };
      }
      throw e;
    }
    await applyTopUpContract({
      workspaceId: args.workspaceId,
      credits: args.credits,
      idempotencyKey: args.idempotencyKey,
      source: args.source,
    });
    return { ok: true, applied: { workspaceId: args.workspaceId, credits: args.credits, alreadyApplied: false } };
  }

  /**
   * Direct purchase is not supported: Stripe Checkout completes payment
   * asynchronously and credits are applied by the webhook. Use
   * createTopUpCheckout. Fails closed instead of inventing a charge flow.
   */
  async purchaseTopUp(workspaceId: string, packCredits: number): Promise<TopUpResult> {
    this.requireConfigured();
    throw new Error(
      `Direct Stripe purchase is not supported (workspace ${workspaceId}, ${packCredits} credits). ` +
        "Create a Checkout Session with createTopUpCheckout; credits are applied by the verified webhook.",
    );
  }

  /**
   * Create a setup-mode Checkout Session that collects a card for future
   * overage invoices (B11). Binds/creates the workspace's Stripe Customer
   * server-side (B10); the workspace credited is the authenticated admin's
   * workspace from the route — never client-supplied. Card data never
   * touches Marketr (Stripe Checkout only).
   */
  async createPaymentMethodCheckout(
    req: PaymentMethodCheckoutRequest,
  ): Promise<{ url: string; sessionId: string; customerId: string }> {
    this.requireConfigured();
    const workspaceId = (req.workspaceId ?? "").trim();
    if (!workspaceId) throw new Error("workspaceId is required");
    for (const [label, url] of [["successUrl", req.successUrl], ["cancelUrl", req.cancelUrl]] as const) {
      if (!/^https?:\/\//.test(url ?? "")) throw new Error(`${label} must be an http(s) URL`);
    }
    const bw = await getOrCreateBillingWorkspace(workspaceId);
    let customerId = bw.stripeCustomerId;
    if (!customerId) {
      const customer = await this.client().customers.create({
        metadata: { workspaceId },
        description: `Marketr workspace ${workspaceId}`,
      });
      customerId = customer.id;
      await prisma.billingWorkspace.update({
        where: { workspaceId },
        data: { stripeCustomerId: customerId },
      });
    }
    const session = await this.client().checkout.sessions.create({
      mode: "setup",
      customer: customerId,
      metadata: { workspaceId, kind: "overage-payment-method" },
      success_url: req.successUrl,
      cancel_url: req.cancelUrl,
    });
    if (!session.url) throw new Error("Stripe did not return a checkout URL");
    return { url: session.url, sessionId: session.id, customerId };
  }

  /**
   * Invoice one workspace's accrued overage (B12). Sums unbilled
   * UsageEvent.overage_credits before `cutoff` (the ledger is the only
   * amount input), skips zero and sub-$5.00 months WITHOUT advancing the
   * watermark (small amounts carry forward, B15), then creates one Stripe
   * invoice item + finalized invoice. Replay-safe: the invoice row is
   * inserted first with idempotency key
   * `overageinvoice:<workspaceId>:<YYYY-MM>`; a re-run returns the prior
   * result. Stripe calls carry matching idempotency keys so a crash between
   * Stripe and the DB update retries cleanly. On Stripe failure the pending
   * row is removed and the error rethrown (the cron surfaces it per
   * workspace; the next run retries).
   *
   * `cutoff` is normally the start of the current UTC month — only
   * completed months are invoiced, never a partial in-progress month.
   */

  /**
   * Decide what a prior invoice row means for this call. A terminal row
   * (finalized/paid/failed) is a replay. A mid-flight "invoicing" row is
   * given a bounded wait to settle (concurrent cron runs); if it is still
   * mid-flight afterwards it belongs to an actively-working peer (replay),
   * unless it is stale — then the worker crashed and the row is reclaimed.
   * Reclaiming is safe: the Stripe calls below use fixed idempotency keys.
   */
  private async resolveOverageRow(
    idempotencyKey: string,
  ): Promise<
    | { action: "proceed" }
    | { action: "replay"; row: BillingOverageInvoice }
    | { action: "reclaim"; row: BillingOverageInvoice }
  > {
    const row = await prisma.billingOverageInvoice.findUnique({ where: { idempotencyKey } });
    if (!row) return { action: "proceed" };
    if (row.status !== "invoicing") return { action: "replay", row };
    const settled = await this.awaitInvoiceTerminal(idempotencyKey);
    if (settled.status !== "invoicing") return { action: "replay", row: settled };
    if (Date.now() - settled.createdAt.getTime() < STALE_INVOICE_MS) {
      return { action: "replay", row: settled };
    }
    return { action: "reclaim", row: settled };
  }

  /** Bounded wait for a mid-flight invoice row to reach a terminal status. */
  private async awaitInvoiceTerminal(idempotencyKey: string): Promise<BillingOverageInvoice> {
    const start = Date.now();
    let row = await prisma.billingOverageInvoice.findUnique({ where: { idempotencyKey } });
    while (row && row.status === "invoicing" && Date.now() - start < INVOICE_SETTLE_WAIT_MS) {
      await new Promise((r) => setTimeout(r, 250));
      row = await prisma.billingOverageInvoice.findUnique({ where: { idempotencyKey } });
    }
    if (!row) throw new Error("overage invoice row vanished while settling");
    return row;
  }

  async invoiceOverage(workspaceId: string, cutoff: Date): Promise<OverageInvoiceResult> {
    this.requireConfigured();
    const wsId = (workspaceId ?? "").trim();
    if (!wsId) throw new Error("workspaceId is required");
    // Period = the COMPLETED billing month the cutoff closes. The cutoff is
    // the first instant AFTER the billed month (e.g. Oct 1 for September's
    // overage), so subtract 1ms to land inside the billed month.
    const label = new Date(cutoff.getTime() - 1).toISOString().slice(0, 7); // YYYY-MM
    const idempotencyKey = `overageinvoice:${wsId}:${label}`;

    // Replay / concurrency first: a prior row decides, with no side effects.
    const pre = await this.resolveOverageRow(idempotencyKey);
    if (pre.action === "replay") {
      return alreadyInvoicedResult(pre.row);
    }

    // Card gate: fail closed without a verified card. The setup route is the
    // ONLY customer-creation path — invoicing never silently creates one.
    const bw = await getOrCreateBillingWorkspace(wsId);
    if (!bw.hasPaymentMethod || !bw.stripeCustomerId) {
      return {
        status: "no_payment_method",
        alreadyApplied: false,
        overageCredits: 0,
        amountCents: 0,
        stripeInvoiceId: null,
        invoiceDbId: null,
      };
    }

    const { credits } = await unbilledOverageCredits(wsId, { before: cutoff });
    if (credits <= 0) {
      // A concurrent peer may have invoiced this period after our initial
      // check (its watermark advance zeroed our unbilled sum). Report the
      // replay truthfully instead of a bare no_overage.
      const raced = await this.resolveOverageRow(idempotencyKey);
      if (raced.action === "replay") return alreadyInvoicedResult(raced.row);
      return {
        status: "no_overage",
        alreadyApplied: false,
        overageCredits: 0,
        amountCents: 0,
        stripeInvoiceId: null,
        invoiceDbId: null,
      };
    }
    const amountCents = overageCentsFor(credits);
    if (amountCents < MIN_OVERAGE_INVOICE_CENTS) {
      // Below the $5 minimum: skip WITHOUT advancing the watermark — the
      // overage carries forward and is billed once the minimum is reached.
      return {
        status: "below_minimum",
        alreadyApplied: false,
        overageCredits: credits,
        amountCents,
        stripeInvoiceId: null,
        invoiceDbId: null,
      };
    }

    // Claim the invoice row. Either we insert it first, or we reclaim a stale
    // "invoicing" row left by a crashed worker (Stripe calls below use fixed
    // idempotency keys, so re-driving them is safe).
    let row: BillingOverageInvoice;
    if (pre.action === "reclaim") {
      row = pre.row;
      await prisma.billingOverageInvoice.update({
        where: { id: row.id },
        data: { overageCredits: credits, amountCents },
      });
      row = { ...row, overageCredits: credits, amountCents };
    } else {
      try {
        row = await prisma.billingOverageInvoice.create({
          data: {
            workspaceId: wsId,
            period: label,
            overageCredits: credits,
            amountCents,
            status: "invoicing",
            idempotencyKey,
          },
        });
      } catch (e) {
        // Lost the insert race (concurrent cron runs): the winner's row
        // decides — replay it, or reclaim it if the winner crashed.
        if (!isPrismaUniqueViolation(e)) throw e;
        const post = await this.resolveOverageRow(idempotencyKey);
        if (post.action === "replay") return alreadyInvoicedResult(post.row);
        if (post.action === "reclaim") {
          row = post.row;
          await prisma.billingOverageInvoice.update({
            where: { id: row.id },
            data: { overageCredits: credits, amountCents },
          });
          row = { ...row, overageCredits: credits, amountCents };
        } else {
          // The winner's row vanished (a failed peer deleted it) — retry the
          // insert once; a second loss means the peer is driving it.
          try {
            row = await prisma.billingOverageInvoice.create({
              data: {
                workspaceId: wsId,
                period: label,
                overageCredits: credits,
                amountCents,
                status: "invoicing",
                idempotencyKey,
              },
            });
          } catch (e2) {
            if (!isPrismaUniqueViolation(e2)) throw e2;
            const retry = await this.resolveOverageRow(idempotencyKey);
            if (retry.action !== "replay") throw e2;
            return alreadyInvoicedResult(retry.row);
          }
        }
      }
    }

    try {
      // Card gate above guarantees a bound customer — never create one here.
      const customerId = bw.stripeCustomerId as string;
      const description =
        `Marketr overage — ${credits.toLocaleString()} credits @ $0.012/credit ` +
        `(usage past cap, through ${label})`;
      await this.client().invoiceItems.create(
        { customer: customerId, amount: amountCents, currency: "usd", description },
        { idempotencyKey: `overage-item:${idempotencyKey}` },
      );
      const draft = await this.client().invoices.create(
        {
          customer: customerId,
          collection_method: "charge_automatically",
          auto_advance: true,
          description,
        },
        { idempotencyKey: `overage-invoice:${idempotencyKey}` },
      );
      const finalized = await this.client().invoices.finalizeInvoice(
        draft.id,
        {},
        { idempotencyKey: `overage-finalize:${idempotencyKey}` },
      );
      await prisma.billingOverageInvoice.update({
        where: { id: row.id },
        data: {
          stripeInvoiceId: finalized.id,
          hostedInvoiceUrl: finalized.hosted_invoice_url ?? null,
          invoicePdfUrl: finalized.invoice_pdf ?? null,
          status: "finalized",
        },
      });
      await prisma.billingWorkspace.update({
        where: { workspaceId: wsId },
        data: { lastOverageInvoicedThrough: cutoff },
      });
      await auditBilling(
        wsId,
        `Billing: overage invoice ${label} finalized — ` +
          `${credits.toLocaleString()} credits, $${(amountCents / 100).toFixed(2)}`,
      );
      return {
        status: "invoiced",
        alreadyApplied: false,
        overageCredits: credits,
        amountCents,
        stripeInvoiceId: finalized.id,
        invoiceDbId: row.id,
      };
    } catch (e) {
      // Stripe failed mid-flight: remove the pending row so the next cron
      // run retries cleanly (Stripe-side idempotency keys prevent dupes).
      await prisma.billingOverageInvoice.delete({ where: { id: row.id } }).catch(() => null);
      throw e;
    }
  }

  /**
   * Overage invoicing — now wired (was a fail-closed stub, B9).
   *
   * Bills this workspace's accrued overage for the month containing
   * `periodStart`, once that month has ended. Only completed months are
   * ever invoiced; if the month is still in progress the result is
   * `nothing_due`. Amounts always come from the UsageEvent ledger —
   * `credits` is accepted for interface compatibility and is NOT trusted
   * (the ledger is the source of truth; Stripe never decides what is owed).
   */
  async billOverage(
    workspaceId: string,
    credits: number,
    periodStart: Date,
  ): Promise<{ providerRef: string } & OverageInvoiceResult> {
    this.requireConfigured();
    void credits; // advisory only — the ledger decides the amount
    const start = monthStartUTC(periodStart instanceof Date ? periodStart : new Date(periodStart));
    const cutoff = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    if (cutoff > new Date()) {
      return {
        providerRef: "",
        status: "nothing_due",
        alreadyApplied: false,
        overageCredits: 0,
        amountCents: 0,
        stripeInvoiceId: null,
        invoiceDbId: null,
      };
    }
    const res = await this.invoiceOverage(workspaceId, cutoff);
    return { ...res, providerRef: res.stripeInvoiceId ?? "" };
  }
}

/**
 * Manual top-up (self-host / support-assisted): adds purchased credits with
 * a 12-month expiry without any payment provider. Used by self-hosted
 * operators and by support tooling, never by end-user checkout.
 */
export function manualTopUp(workspaceId: string, credits: number, now = new Date()): TopUpResult {
  if (!Number.isInteger(credits) || credits <= 0) {
    throw new Error("top-up credits must be a positive integer");
  }
  const expiresAt = new Date(now);
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);
  return { workspaceId, creditsAdded: credits, expiresAt, providerRef: null };
}

// ── Overage invoicing (hosted Stripe track) ──────────────────────────────────
// When auto-overage is opted in and usage exceeds the paid pool
// (included + purchased), meter() marks the overage portion of each charge
// factually on the UsageEvent (overage_credits, see service.ts). This section
// turns accrued overage into money:
//
//   1. Card on file: an admin creates a setup-mode Checkout Session
//      (createPaymentMethodCheckout); the signed webhook attaches the payment
//      method as the customer's default for invoices (handleSetupCompleted).
//   2. Enabling auto-overage while billing is configured requires a card on
//      file (OverageCardRequiredError) — no card, no uncapped spend.
//   3. Monthly cron POST /api/cron/overage-invoicing calls invoiceOverage()
//      per workspace: sums unbilled overage before the current UTC month,
//      skips zero and sub-$5.00 months (the watermark does not advance, so
//      small amounts carry forward), creates Stripe invoice items +
//      finalized invoice, replay-safe per workspace per month (B12).
//   4. invoice.paid / invoice.payment_failed webhooks settle the invoice
//      rows; failure is surfaced in the UI and audit-logged (B13).
//
// Money invariant: invoice amounts ALWAYS come from the UsageEvent ledger
// (sum of overage_credits). Stripe never decides what is owed.

/** $0.012/credit expressed as cents per credit (1 credit = 1.2¢). */
export const OVERAGE_CENTS_PER_CREDIT = 1.2;
/** Minimum invoice: months billing under $5.00 are skipped and carried forward. */
export const MIN_OVERAGE_INVOICE_CENTS = 500;

function monthStartUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** True when both Stripe secrets are present (hosted billing is live). */
export function isBillingConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
}

/** Plain-language denial when auto-overage is enabled without a card on file. */
export class OverageCardRequiredError extends Error {
  constructor() {
    super(
      "Add a card on file before turning on auto-overage. Overage is billed " +
        "monthly at $0.012/credit (minimum $5.00 per invoice) — without a card " +
        "there is nothing to bill, so the hard cap stays on. Add a card in " +
        "Settings → Usage → Overage billing.",
    );
    this.name = "OverageCardRequiredError";
  }
}

export interface BillingWorkspaceState {
  workspaceId: string;
  stripeCustomerId: string | null;
  hasPaymentMethod: boolean;
  lastOverageInvoicedThrough: Date | null;
}

async function getOrCreateBillingWorkspace(workspaceId: string): Promise<BillingWorkspaceState> {
  const row = await prisma.billingWorkspace.upsert({
    where: { workspaceId },
    update: {},
    create: { workspaceId },
  });
  return {
    workspaceId: row.workspaceId,
    stripeCustomerId: row.stripeCustomerId,
    hasPaymentMethod: row.hasPaymentMethod,
    lastOverageInvoicedThrough: row.lastOverageInvoicedThrough,
  };
}

/** Whether this workspace has a card on file for overage invoices. */
export async function hasPaymentMethod(workspaceId: string): Promise<boolean> {
  const row = await prisma.billingWorkspace.findUnique({ where: { workspaceId } });
  return row?.hasPaymentMethod ?? false;
}

function auditBilling(workspaceId: string, summary: string): Promise<unknown> {
  return prisma.fileChangeLog
    .create({
      data: {
        workspaceId,
        actor: "system",
        action: "save",
        filePath: "billing/overage-invoicing",
        summary,
      },
    })
    .catch(() => null); // audit is best-effort; never break the money path
}

export interface PaymentMethodCheckoutRequest {
  workspaceId: string;
  successUrl: string;
  cancelUrl: string;
}

export type OverageInvoiceStatus =
  | "invoiced"
  | "already_invoiced"
  | "no_overage"
  | "below_minimum"
  | "nothing_due"
  | "no_payment_method";

export interface OverageInvoiceResult {
  status: OverageInvoiceStatus;
  /** True when this call found a prior invoice row (replay). */
  alreadyApplied: boolean;
  overageCredits: number;
  amountCents: number;
  stripeInvoiceId: string | null;
  invoiceDbId: string | null;
}

export interface OverageInvoiceRecord {
  id: string;
  period: string;
  overageCredits: number;
  amountCents: number;
  status: string;
  stripeInvoiceId: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
  createdAt: Date;
}

export interface OverageState {
  configured: boolean;
  hasPaymentMethod: boolean;
  customerBound: boolean;
  accruedCredits: number;
  accruedCents: number;
  minInvoiceCents: number;
  overageRate: string;
  invoices: OverageInvoiceRecord[];
}

/**
 * Unbilled overage credits: sum of UsageEvent.overage_credits after the
 * invoice watermark (optionally only before `before`). The ledger is the
 * only input — Stripe never decides the amount.
 */
async function unbilledOverageCredits(
  workspaceId: string,
  opts: { before?: Date } = {},
): Promise<{ credits: number; watermark: Date | null }> {
  const bw = await prisma.billingWorkspace.findUnique({ where: { workspaceId } });
  const watermark = bw?.lastOverageInvoicedThrough ?? null;
  const beforeClause = opts.before
    ? Prisma.sql`AND occurred_at < ${opts.before}`
    : Prisma.sql``;
  const rows = await prisma.$queryRaw<Array<{ total: bigint | null }>>`
    SELECT SUM(overage_credits) AS total FROM usage_events
    WHERE workspace_id = ${workspaceId}
      AND overage_credits > 0
      AND (${watermark}::timestamptz IS NULL OR occurred_at > ${watermark}::timestamptz)
      ${beforeClause}`;
  return { credits: Number(rows[0]?.total ?? 0), watermark };
}

export function overageCentsFor(credits: number): number {
  return Math.round(credits * OVERAGE_CENTS_PER_CREDIT);
}

/**
 * Overage state for Settings → Usage and GET /api/billing/status.
 * Never exposes keys, secrets, or card data — only whether a card is on
 * file, the accrued unbilled amount, and the invoice list.
 */
export async function getOverageState(workspaceId: string): Promise<OverageState> {
  const [bw, invoices, unbilled] = await Promise.all([
    prisma.billingWorkspace.findUnique({ where: { workspaceId } }),
    prisma.billingOverageInvoice.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: 24,
    }),
    unbilledOverageCredits(workspaceId),
  ]);
  return {
    configured: isBillingConfigured(),
    hasPaymentMethod: bw?.hasPaymentMethod ?? false,
    customerBound: Boolean(bw?.stripeCustomerId),
    accruedCredits: unbilled.credits,
    accruedCents: overageCentsFor(unbilled.credits),
    minInvoiceCents: MIN_OVERAGE_INVOICE_CENTS,
    overageRate: OVERAGE_RATE_DISPLAY,
    invoices: invoices.map((r) => ({
      id: r.id,
      period: r.period,
      overageCredits: r.overageCredits,
      amountCents: r.amountCents,
      status: r.status,
      stripeInvoiceId: r.stripeInvoiceId,
      hostedInvoiceUrl: r.hostedInvoiceUrl,
      invoicePdfUrl: r.invoicePdfUrl,
      createdAt: r.createdAt,
    })),
  };
}
