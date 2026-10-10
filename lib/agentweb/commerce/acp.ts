// ShapesOS — Phase 21A round 2 (WS=agentweb): the ACP checkout adapter.
//
// Agentic Commerce Protocol (OpenAI + Stripe; Apache-2.0; date-versioned, latest read:
// 2026-04-17, "beta"): github.com/agentic-commerce-protocol, spec/2026-04-17/openapi/
// openapi.agentic_checkout.yaml. The calls used:
//   POST /checkout_sessions                      create (201), line_items + currency
//   POST /checkout_sessions/{id}/complete        finalise with payment_data, returns the session + order
//   POST /checkout_sessions/{id}/cancel          cancel
// Headers: Authorization (Bearer), API-Version, Idempotency-Key (all POSTs), Content-Type.
// Response: id, status (… ready_for_payment, completed, canceled …), currency, totals[], and on
// complete an order {id, checkout_session_id, permalink_url}.
//
// IMPORTANT: written against the published OpenAPI text and exercised ONLY against a labelled
// fake merchant (lib/agentweb/commerce/fakes.ts). The spec's examples and schemas disagree in
// places (items vs line_items, payment_data fields), so field-level details are
// UNVERIFIED-LIVE until a real ACP merchant is tried. Merchant calls are authenticated by the
// bearer token the merchant gave us, not by Web Bot Auth (ACP has its own optional Signature
// header, which must not be confused with the RFC 9421 one).

import { createHash } from "node:crypto";
import { safeFetch } from "@/lib/connectors/safe-fetch";
import type { ResolveFn } from "@/lib/safe-url";
import { AGENT_USER_AGENT } from "../identity/agent-fetch";
import { assertNoCardData, type Cart } from "./cart";
import type { CheckoutAdapter, CheckoutSession, OrderRef, PaymentCredential } from "./checkout";
import { isVerified, type VerifiedMandate } from "./mandate";
import { MandateRequired } from "./checkout";

export const ACP_API_VERSION = "2026-04-17";

export interface AcpConfig {
  baseUrl: string;
  bearerToken: string;
  fetchFn?: typeof fetch;
  resolve?: ResolveFn;
}

interface AcpTotal {
  type?: string;
  amount?: number;
}
interface AcpSession {
  id?: string;
  status?: string;
  currency?: string;
  totals?: AcpTotal[];
  continue_url?: string;
  order?: { id?: string; checkout_session_id?: string; permalink_url?: string };
  messages?: Array<{ type?: string; text?: string }>;
}

export class AcpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AcpError";
  }
}

export class AcpAdapter implements CheckoutAdapter {
  readonly id = "acp" as const;
  constructor(private readonly cfg: AcpConfig) {}

  private async call(method: "POST", path: string, body: unknown, idempotencyKey: string): Promise<AcpSession> {
    assertNoCardData(body);
    const res = await safeFetch(
      `${this.cfg.baseUrl.replace(/\/+$/, "")}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${this.cfg.bearerToken}`,
          "api-version": ACP_API_VERSION,
          "idempotency-key": idempotencyKey,
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": AGENT_USER_AGENT,
        },
        body: JSON.stringify(body),
      },
      { fetchFn: this.cfg.fetchFn, resolve: this.cfg.resolve, maxRedirects: 0 },
    );
    const text = (await res.text()).slice(0, 200_000);
    let json: AcpSession = {};
    try {
      json = JSON.parse(text) as AcpSession;
    } catch {
      /* not JSON */
    }
    if (!res.ok) throw new AcpError(`The merchant's checkout refused the request (${res.status}).`, res.status);
    return json;
  }

  private session(s: AcpSession): CheckoutSession {
    const total = s.totals?.find((t) => t.type === "total")?.amount;
    if (!s.id || typeof total !== "number" || !s.currency) throw new AcpError("The merchant's checkout answer was missing an id, total or currency.");
    return { id: s.id, currency: s.currency.toUpperCase(), totalMinor: total, continueUrl: s.continue_url ?? null, status: s.status ?? "" };
  }

  async createSession(cart: Cart, mandate: VerifiedMandate): Promise<CheckoutSession> {
    if (!isVerified(mandate)) throw new MandateRequired();
    const key = createHash("sha256").update(`create:${mandate.contents.id}:${mandate.contents.nonce}`).digest("hex").slice(0, 32);
    const s = await this.call(
      "POST",
      "/checkout_sessions",
      { currency: cart.currency.toLowerCase(), line_items: cart.items.map((i, n) => ({ id: i.sku ?? `line_${n + 1}`, name: i.name, quantity: i.qty, unit_amount: i.unitMinor })) },
      key,
    );
    return this.session(s);
  }

  async complete(session: CheckoutSession, mandate: VerifiedMandate, payment: PaymentCredential): Promise<OrderRef> {
    // Defence in depth: the orchestrator checks too, but an adapter never completes without a verified mandate.
    if (!isVerified(mandate)) throw new MandateRequired();
    if (session.totalMinor !== mandate.contents.amountMinor || session.currency !== mandate.contents.currency) throw new AcpError("The checkout total no longer matches what the person approved.");
    const key = createHash("sha256").update(`complete:${mandate.contents.id}:${mandate.contents.nonce}`).digest("hex").slice(0, 32);
    const s = await this.call(
      "POST",
      `/checkout_sessions/${encodeURIComponent(session.id)}/complete`,
      { payment_data: { handler_id: payment.handlerId, instrument: { type: payment.tokenType, credential: { type: payment.tokenType, token: payment.token } } } },
      key,
    );
    if (s.status !== "completed" || !s.order?.id) throw new AcpError(`The merchant did not complete the checkout (status ${s.status ?? "unknown"}).`);
    return { id: s.order.id, checkoutSessionId: s.order.checkout_session_id ?? session.id, permalinkUrl: s.order.permalink_url ?? null };
  }

  async cancel(session: CheckoutSession): Promise<void> {
    await this.call("POST", `/checkout_sessions/${encodeURIComponent(session.id)}/cancel`, {}, createHash("sha256").update(`cancel:${session.id}`).digest("hex").slice(0, 32));
  }
}
