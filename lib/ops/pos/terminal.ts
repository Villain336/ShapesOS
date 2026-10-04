// ShapesOS — Phase 12 (mfgpos): card payments at the till via Stripe
// Terminal, over the Stripe REST API (no Terminal SDK dependency).
//
//   live  the workspace's OWN Stripe secret key (Finance settings — never the
//         platform billing key) and the register's reader id (tmr_…):
//           POST /v1/payment_intents            card_present, automatic capture
//           POST /v1/terminal/readers/{id}/process_payment_intent
//           GET  /v1/payment_intents/{id}       poll until succeeded
//           POST /v1/payment_intents/{id}/capture   when the account requires it
//   mock  ONLY when POS_TERMINAL_MOCK=1 on the server: a labelled simulator
//         (provider "stripe_terminal_mock", ids mock_pi_<amount>_<rand>) that
//         approves every payment, for demos and tests without a reader. Its
//         payments are recorded as mock payments, never as real card money.
//
// The sale route re-reads every card payment through getPayment() before
// recording it (status succeeded, amount equal), so a client can't claim a
// card payment that didn't happen.
//
// UNVERIFIED-LIVE: exercised against a fake fetch and the mock in tests; no
// physical reader or live Stripe account was used.

import { randomBytes } from "node:crypto";

export type TerminalStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_action"
  | "processing"
  | "requires_capture"
  | "canceled"
  | "succeeded";

export interface TerminalPayment {
  id: string;
  status: TerminalStatus;
  amountCents: number;
  currency: string;
}

export interface TerminalAdapter {
  readonly mode: "live" | "mock";
  /** OpsPayment.provider for payments taken through this adapter. */
  readonly provider: "stripe_terminal" | "stripe_terminal_mock";
  startPayment(input: { amountCents: number; currency: string; readerId: string | null; idempotencyKey: string; metadata: Record<string, string> }): Promise<TerminalPayment>;
  getPayment(id: string): Promise<TerminalPayment>;
}

export class TerminalError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "TerminalError";
    this.status = status;
  }
}

export function terminalMockEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.POS_TERMINAL_MOCK === "1";
}

// ---------------------------------------------------------------------------
// Live: Stripe REST
// ---------------------------------------------------------------------------

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const API = "https://api.stripe.com/v1";

function form(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

function toPayment(raw: unknown): TerminalPayment {
  const r = raw as { id?: string; status?: string; amount?: number; currency?: string };
  if (!r?.id || !r.status) throw new TerminalError(502, "Stripe returned an unexpected payment");
  return { id: r.id, status: r.status as TerminalStatus, amountCents: Number(r.amount ?? 0), currency: String(r.currency ?? "usd") };
}

export function stripeTerminalRest(secretKey: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): TerminalAdapter {
  const call = async (method: string, path: string, params?: Record<string, string | number>, idem?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${secretKey}` };
    if (params) headers["content-type"] = "application/x-www-form-urlencoded";
    if (idem) headers["idempotency-key"] = idem;
    const res = await fetchImpl(`${API}${path}`, { method, headers, body: params ? form(params) : undefined });
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!res.ok) throw new TerminalError(res.status === 402 ? 402 : 502, body.error?.message ?? `Stripe error ${res.status}`);
    return body;
  };
  return {
    mode: "live",
    provider: "stripe_terminal",
    async startPayment({ amountCents, currency, readerId, idempotencyKey, metadata }) {
      if (!readerId) throw new TerminalError(409, "This register has no card reader. Add its Stripe Terminal reader id (tmr_…) in the register settings.");
      const params: Record<string, string | number> = {
        amount: amountCents,
        currency: currency.toLowerCase(),
        "payment_method_types[]": "card_present",
        capture_method: "automatic",
      };
      for (const [k, v] of Object.entries(metadata)) params[`metadata[${k}]`] = v;
      const intent = toPayment(await call("POST", "/payment_intents", params, `pos-pi-${idempotencyKey}`));
      await call("POST", `/terminal/readers/${encodeURIComponent(readerId)}/process_payment_intent`, { payment_intent: intent.id }, `pos-reader-${idempotencyKey}`);
      return intent;
    },
    async getPayment(id) {
      if (!/^pi_[A-Za-z0-9]+$/.test(id)) throw new TerminalError(400, "That isn't a card payment reference");
      let p = toPayment(await call("GET", `/payment_intents/${id}`));
      if (p.status === "requires_capture") p = toPayment(await call("POST", `/payment_intents/${id}/capture`, {}, `pos-capture-${id}`));
      return p;
    },
  };
}

// ---------------------------------------------------------------------------
// Mock (POS_TERMINAL_MOCK=1 only) — clearly labelled, never real money
// ---------------------------------------------------------------------------

export const MOCK_PREFIX = "mock_pi_";

export function mockTerminal(): TerminalAdapter {
  return {
    mode: "mock",
    provider: "stripe_terminal_mock",
    async startPayment({ amountCents, currency }) {
      return { id: `${MOCK_PREFIX}${amountCents}_${randomBytes(8).toString("hex")}`, status: "succeeded", amountCents, currency: currency.toLowerCase() };
    },
    async getPayment(id) {
      const m = /^mock_pi_(\d+)_[0-9a-f]{16}$/.exec(id);
      if (!m) throw new TerminalError(400, "That isn't a mock card payment reference");
      return { id, status: "succeeded", amountCents: Number(m[1]), currency: "usd" };
    },
  };
}

/** The adapter for a workspace: the mock when enabled, else live with the tenant key (null = card unavailable). */
export function terminalAdapter(secretKey: string | null, env: Record<string, string | undefined> = process.env, fetchImpl?: FetchLike): TerminalAdapter | null {
  if (terminalMockEnabled(env)) return mockTerminal();
  return secretKey ? stripeTerminalRest(secretKey, fetchImpl) : null;
}
