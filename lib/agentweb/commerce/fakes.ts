// ShapesOS — Phase 21A round 2 (WS=agentweb): labelled FAKES for commerce (MOCK).
//
// There is no live ACP or AP2 merchant to test against. These stand in for one so the adapters,
// the mandate gate and the checkout orchestration can be exercised end to end. Nothing here
// talks to a network, and nothing here is evidence that a real merchant works: that stays
// UNVERIFIED-LIVE. Every fake says "mock" in its name.

import { generateKeyPair, type KeyPair } from "../identity/httpsig";
import { ap2Hash, signJwt, type Ap2CartContents, type Ap2CartMandate } from "./ap2";
import type { PaymentCredential, PaymentRail } from "./checkout";
import type { VerifiedMandate } from "./mandate";

export interface MockAcpMerchant {
  /** Use as the adapter's fetchFn. */
  fetchFn: typeof fetch;
  calls: Array<{ method: string; path: string; headers: Record<string, string>; body: unknown }>;
  completeCount: () => number;
  /** Make the next created session cost this much (a price that moved since the person signed). */
  setPriceDrift: (extraMinor: number) => void;
}

export function mockAcpMerchant(opts: { token?: string } = {}): MockAcpMerchant {
  const token = opts.token ?? "mock-merchant-token";
  const calls: MockAcpMerchant["calls"] = [];
  const sessions = new Map<string, { currency: string; total: number; status: string }>();
  let drift = 0;
  let n = 0;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, headers, body });
    if (headers.authorization !== `Bearer ${token}`) return json(401, { error: "unauthorized" });
    if (!headers["api-version"] || !headers["idempotency-key"]) return json(400, { error: "missing API-Version or Idempotency-Key" });
    if (url.pathname.endsWith("/checkout_sessions")) {
      const items = (body?.line_items ?? []) as Array<{ quantity: number; unit_amount: number }>;
      const total = items.reduce((s, i) => s + i.quantity * i.unit_amount, 0) + drift;
      const id = `cs_mock_${++n}`;
      sessions.set(id, { currency: String(body.currency).toUpperCase(), total, status: "ready_for_payment" });
      return json(201, { id, status: "ready_for_payment", currency: body.currency, totals: [{ type: "total", amount: total }], continue_url: `https://merchant.mock.test/checkout/${id}`, line_items: items, messages: [], links: [], capabilities: {}, fulfillment_options: [] });
    }
    const m = /\/checkout_sessions\/([^/]+)\/(complete|cancel)$/.exec(url.pathname);
    const s = m ? sessions.get(m[1]!) : undefined;
    if (!m || !s) return json(404, { error: "not found" });
    if (m[2] === "cancel") {
      s.status = "canceled";
      return json(200, { id: m[1], status: "canceled", currency: s.currency, totals: [{ type: "total", amount: s.total }] });
    }
    if (!body?.payment_data?.instrument?.credential?.token) return json(400, { error: "payment_data required" });
    s.status = "completed";
    return json(200, { id: m[1], status: "completed", currency: s.currency, totals: [{ type: "total", amount: s.total }], order: { id: `ord_mock_${m[1]}`, checkout_session_id: m[1], permalink_url: `https://merchant.mock.test/orders/${m[1]}` } });
  };
  return { fetchFn, calls, completeCount: () => calls.filter((c) => c.path.endsWith("/complete")).length, setPriceDrift: (x) => (drift = x) };
}

/** A payment rail that hands out an opaque delegated token (never a card number). MOCK. */
export const mockPaymentRail: PaymentRail & { issued: number } = {
  issued: 0,
  async credential(_m: VerifiedMandate): Promise<PaymentCredential> {
    void _m;
    mockPaymentRail.issued += 1;
    return { handlerId: "mock_spt_handler", token: `spt_mock_${mockPaymentRail.issued}`, tokenType: "shared_payment_token" };
  },
};

export interface MockAp2Merchant {
  key: KeyPair;
  /** A merchant-signed cart for the given contents (what a merchant agent returns). */
  signCart(contents: Ap2CartContents, opts?: { now?: number; ttlSec?: number }): Ap2CartMandate;
}

export function mockAp2Merchant(): MockAp2Merchant {
  const key = generateKeyPair();
  return {
    key,
    signCart(contents, opts = {}) {
      const iat = opts.now ?? Math.floor(Date.now() / 1000);
      return { contents, merchant_authorization: signJwt({ iss: "mock-merchant", sub: "mock-merchant-agent", aud: "shopping-agent", iat, exp: iat + (opts.ttlSec ?? 300), jti: `jti_${contents.id}`, cart_hash: ap2Hash(contents) }, key) };
    },
  };
}
