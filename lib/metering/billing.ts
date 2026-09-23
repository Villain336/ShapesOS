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
 * Audit-logged via FileChangeLog (action "save" — the enum has no billing
 * action and this track owns no migration; the summary text is explicit).
 */
export async function setAutoOverage(args: OverageToggle): Promise<{ workspaceId: string; autoOverage: boolean }> {
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
  applied?: { workspaceId: string; credits: number; alreadyApplied: boolean };
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
   * parsing, business logic, or DB write (B1). Only
   * checkout.session.completed with payment_status=paid and a paid amount
   * matching a known pack applies credits (B4); the workspace credited is
   * taken ONLY from signed session metadata (B3); replays are idempotent
   * via the exactly-once guard (B2).
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
    if (event.type !== "checkout.session.completed") return { ok: true, ignored: true };
    const session = event.data.object as Stripe.Checkout.Session;
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
   * Overage invoicing is a hosted follow-up (see THREAT-MODEL-BILLING.md B9).
   * Fail closed until it exists — the hard cap stays enforced.
   */
  async billOverage(workspaceId: string, credits: number, periodStart: Date): Promise<{ providerRef: string }> {
    this.requireConfigured();
    throw new Error(
      `Stripe auto-overage invoicing is not yet wired (workspace ${workspaceId}, ${credits} credits ` +
        `from ${periodStart.toISOString()}). Overage is opt-in only; the hard cap stays enforced until this path exists.`,
    );
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
