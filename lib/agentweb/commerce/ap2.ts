// ShapesOS — Phase 21A round 2 (WS=agentweb): AP2 mandate shapes (Agent Payments Protocol).
//
// AP2 (Google; donated to / standardised in the FIDO Alliance's Agentic Authentication and
// Payments working groups; Apache-2.0) models a purchase as chained mandates. Shapes read from
// the public SDK (google-agentic-commerce/AP2 code/sdk/python/ap2/models/mandate.py):
//   CartContents  {id, user_cart_confirmation_required, payment_request (W3C PaymentRequest),
//                  cart_expiry, merchant_name}   the MERCHANT signs it into
//   CartMandate   {contents, merchant_authorization: base64url JWT with iss/sub/aud/iat/exp/jti
//                  and a hash of the canonical CartContents}
//   PaymentMandate{payment_mandate_contents{payment_mandate_id, payment_details_id,
//                  payment_details_total, payment_response, merchant_agent, timestamp},
//                  user_authorization: a verifiable presentation (SD-JWT-VC) over hashes of the
//                  cart mandate and payment mandate with a key-binding JWT}
//   IntentMandate {user_cart_confirmation_required, natural_language_description, merchants,
//                  skus, requires_refundability, intent_expiry}   the human-NOT-present flow
//
// What this module does: map OUR human-signed cart mandate to AP2 shapes, check a merchant's
// signed cart against what the person approved, and build the PaymentMandate. What it does
// NOT do, honestly:
//   - the user_authorization is the SERVER's EdDSA attestation of the person's click, not a
//     wallet-held SD-JWT-VC with a device-bound key. A real AP2 merchant would not accept it:
//     UNVERIFIED-LIVE, and building a credential provider is out of scope;
//   - HUMAN-NOT-PRESENT INTENT MANDATES ARE NOT IMPLEMENTED. They let an agent buy later,
//     inside pre-set limits, without the person at the moment of purchase. That contradicts
//     the owner's rule that Tier 3 (money) is never auto-approved, so createIntentMandate
//     below always refuses. Changing it is the owner's decision, not an engineering one.

import { createHash, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { isVerified, MandateRefused, type VerifiedMandate } from "./mandate";
import { MandateRequired } from "./checkout";
import type { KeyPair } from "../identity/httpsig";

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK"]);
const THREE_DECIMAL = new Set(["BHD", "KWD", "OMR", "JOD", "TND"]);

export function minorToDecimal(minor: number, currency: string): string {
  const c = currency.toUpperCase();
  const places = ZERO_DECIMAL.has(c) ? 0 : THREE_DECIMAL.has(c) ? 3 : 2;
  const s = String(Math.abs(minor)).padStart(places + 1, "0");
  return `${minor < 0 ? "-" : ""}${places ? `${s.slice(0, -places)}.${s.slice(-places)}` : s}`;
}

export interface Ap2Amount {
  currency: string;
  value: string;
}
export interface Ap2CartContents {
  id: string;
  /** Always true here: a person confirms every cart. */
  user_cart_confirmation_required: true;
  payment_request: {
    method_data: Array<{ supported_methods: string }>;
    details: { id: string; display_items: Array<{ label: string; amount: Ap2Amount }>; total: { label: string; amount: Ap2Amount } };
  };
  cart_expiry: string;
  merchant_name: string;
}
export interface Ap2CartMandate {
  contents: Ap2CartContents;
  merchant_authorization: string | null;
}
export interface Ap2PaymentMandate {
  payment_mandate_contents: {
    payment_mandate_id: string;
    payment_details_id: string;
    payment_details_total: { label: string; amount: Ap2Amount };
    merchant_agent: string;
    timestamp: string;
  };
  /** Server attestation of the person's click. NOT a wallet-held SD-JWT-VC (see the header). */
  user_authorization: string;
}

/** The AP2 cart shape for the cart the person approved. */
export function toAp2CartContents(mandate: VerifiedMandate): Ap2CartContents {
  if (!isVerified(mandate)) throw new MandateRequired();
  const c = mandate.contents;
  return {
    id: c.id,
    user_cart_confirmation_required: true,
    payment_request: {
      method_data: [{ supported_methods: "card" }],
      details: {
        id: c.id,
        display_items: c.items.map((i) => ({ label: `${i.name} × ${i.qty}`, amount: { currency: c.currency, value: minorToDecimal(i.qty * i.unitMinor, c.currency) } })),
        total: { label: "Total", amount: { currency: c.currency, value: minorToDecimal(c.amountMinor, c.currency) } },
      },
    },
    cart_expiry: c.expiresAt,
    merchant_name: c.merchant.name,
  };
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export const ap2Hash = (v: unknown): string => createHash("sha256").update(canonical(v)).digest("base64url");

// ---- compact EdDSA JWS (the JWT shape AP2 uses for merchant_authorization) ----
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
export function signJwt(claims: Record<string, unknown>, key: KeyPair, typ = "JWT"): string {
  const head = `${b64({ alg: "EdDSA", typ, kid: key.kid })}.${b64(claims)}`;
  return `${head}.${edSign(null, Buffer.from(head), key.privateKey).toString("base64url")}`;
}
export function verifyJwt(jwt: string, x: string): Record<string, unknown> | null {
  const [h, p, s] = jwt.split(".");
  if (!h || !p || !s) return null;
  try {
    const ok = edVerify(null, Buffer.from(`${h}.${p}`), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" }), Buffer.from(s, "base64url"));
    return ok ? (JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type MerchantCartCheck = { ok: true } | { ok: false; reason: "unsigned" | "bad_merchant_signature" | "hash_mismatch" | "expired_token" | "not_what_was_approved" };

/** Is the merchant's signed cart the one the person approved? */
export function checkMerchantCart(mandate: VerifiedMandate, cart: Ap2CartMandate, merchantX: string, nowSec: number): MerchantCartCheck {
  if (!isVerified(mandate)) throw new MandateRequired();
  if (!cart.merchant_authorization) return { ok: false, reason: "unsigned" };
  const claims = verifyJwt(cart.merchant_authorization, merchantX);
  if (!claims) return { ok: false, reason: "bad_merchant_signature" };
  if (typeof claims.exp === "number" && claims.exp <= nowSec) return { ok: false, reason: "expired_token" };
  if (claims.cart_hash !== ap2Hash(cart.contents)) return { ok: false, reason: "hash_mismatch" };
  const mine = toAp2CartContents(mandate);
  const c = cart.contents;
  const sameTotal = c.payment_request.details.total.amount.value === mine.payment_request.details.total.amount.value && c.payment_request.details.total.amount.currency === mine.payment_request.details.total.amount.currency;
  if (!sameTotal || c.merchant_name !== mine.merchant_name || c.user_cart_confirmation_required !== true) return { ok: false, reason: "not_what_was_approved" };
  return { ok: true };
}

/** The PaymentMandate for a cart the merchant signed and the person approved. */
export function buildPaymentMandate(mandate: VerifiedMandate, cart: Ap2CartMandate, opts: { merchantAgent: string; signingKey: KeyPair; now: Date; nonce: string }): Ap2PaymentMandate {
  if (!isVerified(mandate)) throw new MandateRequired();
  const contents = {
    payment_mandate_id: `pm_${mandate.contents.id}`,
    payment_details_id: cart.contents.payment_request.details.id,
    payment_details_total: cart.contents.payment_request.details.total,
    merchant_agent: opts.merchantAgent,
    timestamp: opts.now.toISOString(),
  };
  const user_authorization = signJwt(
    {
      aud: opts.merchantAgent,
      nonce: opts.nonce,
      iat: Math.floor(opts.now.getTime() / 1000),
      sub: mandate.signedBy,
      transaction_data: [ap2Hash(cart), ap2Hash(contents)],
      attestation: "server-attested ui_click; not a device-bound wallet credential",
    },
    opts.signingKey,
    "shapes-ap2-user-authorization",
  );
  return { payment_mandate_contents: contents, user_authorization };
}

// ---------------------------------------------------------------------------
// HUMAN-NOT-PRESENT: refused, always.
// ---------------------------------------------------------------------------

export const HUMAN_NOT_PRESENT_SUPPORTED = false as const;

export class HumanNotPresentRefused extends MandateRefused {
  constructor() {
    super("channel", "Human-not-present (intent) mandates are not supported: money is never approved automatically. Every cart needs the person's click.");
    this.name = "HumanNotPresentRefused";
  }
}

/**
 * AP2's IntentMandate with user_cart_confirmation_required=false would let an agent buy later
 * without the person. Deliberately not implemented; this ALWAYS throws, whatever it is given.
 * (Owner rule: Tier 3 is never auto-approved. Changing that is the owner's decision.)
 */
export function createIntentMandate(_request?: unknown): never {
  void _request;
  throw new HumanNotPresentRefused();
}
