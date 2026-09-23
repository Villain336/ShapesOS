// Marketr — billing sink interface (Phase C, W4).
//
// The UsageEvent ledger is the source of truth. Stripe (or any payment
// provider) is a downstream sink used ONLY for hosted top-up purchases —
// it never decides what was spent. Self-hosted Marketr never touches this
// module: metering records locally and caps enforce locally with zero
// Stripe dependency (spec §10, the open-source "free path").

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
  /**
   * Purchase a top-up pack for a workspace. The sink charges the payment
   * method and returns the credits to add; the caller (service.ts) applies
   * them to CreditBalance inside the locked transaction.
   */
  purchaseTopUp(workspaceId: string, packCredits: number): Promise<TopUpResult>;
  /**
   * Record auto-overage billing for a period (opt-in only). Returns the
   * provider reference for the invoice line item.
   */
  billOverage(workspaceId: string, credits: number, periodStart: Date): Promise<{ providerRef: string }>;
}

/**
 * Hosted-only Stripe sink. NOT wired — constructing it without a configured
 * Stripe secret throws, so self-hosted deployments can never accidentally
 * call out to Stripe. The hosted track that wires Stripe owns webhook
 * verification and receipt handling (out of scope here).
 */
export class StripeBillingSink implements BillingSink {
  readonly name = "stripe";
  private readonly secretKey: string | null;

  constructor(secretKey?: string | null) {
    this.secretKey = secretKey ?? process.env.STRIPE_SECRET_KEY ?? null;
  }

  private requireConfigured(): string {
    if (!this.secretKey) {
      throw new Error(
        "Stripe billing is not configured (hosted-only). " +
          "Set STRIPE_SECRET_KEY on the hosted deployment to enable top-up purchases.",
      );
    }
    return this.secretKey;
  }

  async purchaseTopUp(workspaceId: string, packCredits: number): Promise<TopUpResult> {
    this.requireConfigured();
    // Hosted wiring point: create the Stripe charge / payment intent here,
    // then return the credits. Until then, fail loudly — never silently
    // grant credits.
    throw new Error(
      `Stripe top-up purchase not yet wired (workspace ${workspaceId}, ${packCredits} credits). ` +
        "This is a hosted-only path; the ledger remains the source of truth.",
    );
  }

  async billOverage(workspaceId: string, credits: number, periodStart: Date): Promise<{ providerRef: string }> {
    this.requireConfigured();
    throw new Error(
      `Stripe auto-overage billing not yet wired (workspace ${workspaceId}, ${credits} credits). ` +
        "Overage is opt-in only; the hard cap stays enforced until this path exists.",
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
