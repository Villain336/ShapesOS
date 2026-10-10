// ShapesOS — Phase 21A round 2 (WS=agentweb): the cart mandate (PURE).
//
// The owner rule is that money and irreversible actions are never auto-approved
// (Tier 3). For web commerce that becomes this object: the person's authorisation of ONE
// cart, signed by the click on the Tier 3 card and by nothing else.
//   - Only the channel "ui_click" can sign. A voice or spoken yes, a chat confirmation, an
//     API key, an agent, an automation rule, a webhook or MCP call cannot. (The base has no
//     cursor-policy module to reuse, so the gate is tested directly, here and at the route.)
//   - It binds the cart hash, the amount, the currency, the merchant, the run, the workspace
//     and an expiry. A mandate for another cart, or past its expiry, never verifies.
//   - There is no unsigned mode: without a signing secret nothing can be signed. The key is
//     derived from the app secret for this purpose only (not the receipt key).
//   - verifyMandate returns a branded VerifiedMandate; checkout adapters accept nothing else.
// The signature is the SERVER's attestation of an authenticated person's click (HMAC), not a
// wallet-held credential: AP2's device-bound user authorisation is not built (UNVERIFIED-LIVE).

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cartHash, totalMinor, type Cart, type CartItem } from "./cart";

export type SigningChannel = "ui_click";
const ROLE_RANK: Record<string, number> = { viewer: 0, commenter: 0, editor: 1, admin: 2, owner: 3 };

export interface MandateContents {
  v: 1;
  id: string;
  workspaceId: string;
  runId: string | null;
  merchant: { name: string; origin: string };
  items: CartItem[];
  amountMinor: number;
  currency: string;
  cartHash: string;
  expiresAt: string;
  nonce: string;
}

export interface SignedMandate {
  contents: MandateContents;
  signedBy: string;
  signedAt: string;
  via: SigningChannel;
  alg: "hmac-sha256";
  signature: string;
}

export type RefusalCode = "channel" | "role" | "person" | "no_secret" | "expired";
export class MandateRefused extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "MandateRefused";
  }
}

type Env = Record<string, string | undefined>;

/** The mandate signing key: derived from the app secret for this purpose only; null when none is set. */
export function mandateSecret(env: Env = process.env): string | null {
  const raw = [env.AUTH_SECRET, env.NEXTAUTH_SECRET, env.MARKETR_CREDENTIALS_KEY].map((s) => s?.trim()).find((s) => s && s.length >= 16);
  return raw ? createHmac("sha256", raw).update("shapes:agentweb-mandate:v1").digest("hex") : null;
}

export function mandateContents(input: { id: string; workspaceId: string; cart: Cart; expiresAt: Date; nonce?: string }): MandateContents {
  return {
    v: 1,
    id: input.id,
    workspaceId: input.workspaceId,
    runId: input.cart.runId ?? null,
    merchant: input.cart.merchant,
    items: input.cart.items,
    amountMinor: totalMinor(input.cart),
    currency: input.cart.currency,
    cartHash: cartHash(input.cart),
    expiresAt: input.expiresAt.toISOString(),
    nonce: input.nonce ?? randomBytes(12).toString("hex"),
  };
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}
const mac = (secret: string, m: Omit<SignedMandate, "signature">) => createHmac("sha256", secret).update(canonical({ contents: m.contents, signedBy: m.signedBy, signedAt: m.signedAt, via: m.via, alg: m.alg })).digest("hex");

export function signMandate(contents: MandateContents, approval: { userId: string; channel: SigningChannel; role: string }, secret: string | null, now: Date): SignedMandate {
  if (approval.channel !== "ui_click") throw new MandateRefused("channel", "A cart mandate is signed only by the person clicking its approval card. Voice, chat confirmations, API keys, agents and automations cannot sign one.");
  if (!approval.userId) throw new MandateRefused("person", "A mandate needs the person who signs it.");
  if ((ROLE_RANK[approval.role] ?? 0) < ROLE_RANK.editor!) throw new MandateRefused("role", "Only an editor or above can approve a cart.");
  if (!secret) throw new MandateRefused("no_secret", "No signing secret is configured, so a mandate cannot be signed. There is no unsigned mode.");
  if (now.getTime() > Date.parse(contents.expiresAt)) throw new MandateRefused("expired", "This cart request has expired.");
  const base: Omit<SignedMandate, "signature"> = { contents, signedBy: approval.userId, signedAt: now.toISOString(), via: "ui_click", alg: "hmac-sha256" };
  return { ...base, signature: mac(secret, base) };
}

declare const verifiedBrand: unique symbol;
export type VerifiedMandate = SignedMandate & { readonly [verifiedBrand]: true };
const verified = new WeakSet<object>();
/** True only for an object verifyMandate returned (an object literal cannot get in). */
export function isVerified(m: unknown): m is VerifiedMandate {
  return typeof m === "object" && m !== null && verified.has(m);
}

export type VerifyFailure = "no_secret" | "bad_signature" | "expired" | "cart_mismatch" | "amount_mismatch" | "wrong_workspace";
export type VerifyMandateResult = { ok: true; mandate: VerifiedMandate } | { ok: false; reason: VerifyFailure };

export function verifyMandate(m: SignedMandate, opts: { secret: string | null; now: Date; cart: Cart; workspaceId: string }): VerifyMandateResult {
  if (!opts.secret) return { ok: false, reason: "no_secret" };
  const expect = Buffer.from(mac(opts.secret, m), "hex");
  const got = Buffer.from(String(m.signature), "hex");
  if (m.alg !== "hmac-sha256" || m.via !== "ui_click" || got.length !== expect.length || !timingSafeEqual(got, expect)) return { ok: false, reason: "bad_signature" };
  if (m.contents.workspaceId !== opts.workspaceId) return { ok: false, reason: "wrong_workspace" };
  if (opts.now.getTime() > Date.parse(m.contents.expiresAt)) return { ok: false, reason: "expired" };
  // The signed numbers must agree with each other, and with the cart being bought.
  if (m.contents.amountMinor !== totalMinor(m.contents)) return { ok: false, reason: "amount_mismatch" };
  if (m.contents.cartHash !== cartHash({ merchant: m.contents.merchant, items: m.contents.items, currency: m.contents.currency }) || m.contents.cartHash !== cartHash(opts.cart)) return { ok: false, reason: "cart_mismatch" };
  const mandate = Object.freeze({ ...m }) as VerifiedMandate;
  verified.add(mandate);
  return { ok: true, mandate };
}
