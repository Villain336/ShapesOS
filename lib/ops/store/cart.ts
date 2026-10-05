// ShapesOS — Phase 10 (store): the storefront cart, kept in a SIGNED cookie.
//
// No account is needed to shop, so the cart lives client-side: a compact
// JSON payload, base64url-encoded and HMAC-SHA256-signed with a key derived
// from the deployment's auth secret (AUTH_SECRET, falling back to
// NEXTAUTH_SECRET — the same secret family the data-room viewer cookie
// uses). The signature only proves the cart was written by this server for
// THIS store; it never carries prices. Prices, stock and promotions are
// re-read from the database on every view and again at checkout
// (lib/ops/store/pricing.ts) — a tampered or stale cart can at worst name
// products the buyer could have added anyway.
//
// PURE: no I/O. The route layer reads/writes the cookie.

import { createHmac, timingSafeEqual } from "node:crypto";

export const CART_MAX_LINES = 50;
export const CART_MAX_QTY = 99;
export const CART_MAX_AGE_S = 30 * 24 * 60 * 60;
const CART_VERSION = 1;

export interface CartLine {
  productId: string;
  /** Null = the product's default variant. */
  variantId: string | null;
  qty: number;
}

export interface Cart {
  storeId: string;
  lines: CartLine[];
  /** Promotion code the buyer entered (validated server-side on every read). */
  promoCode: string | null;
}

export class CartConfigError extends Error {
  constructor() {
    super("The store cart needs AUTH_SECRET (or NEXTAUTH_SECRET) to be set on the server.");
    this.name = "CartConfigError";
  }
}

export function cartSecret(env: Record<string, string | undefined> = process.env): string | null {
  const s = env.AUTH_SECRET?.trim() || env.NEXTAUTH_SECRET?.trim();
  return s || null;
}

/** One cookie per store (a cart from store A is never read by store B). */
export function cartCookieName(storeId: string): string {
  return `shapes_cart_${storeId.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

export function emptyCart(storeId: string): Cart {
  return { storeId, lines: [], promoCode: null };
}

function key(secret: string): Buffer {
  return createHmac("sha256", secret).update("shapes:store-cart:v1").digest();
}

function mac(secret: string, payload: string): string {
  return createHmac("sha256", key(secret)).update(`cart.v${CART_VERSION}.${payload}`).digest("base64url");
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PROMO_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function normalizePromoCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const c = raw.trim().toUpperCase();
  return PROMO_RE.test(c) ? c : null;
}

/** Validate an untrusted cart shape; null when anything is off. */
function parseCart(v: unknown, storeId: string): Cart | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.v !== CART_VERSION || o.s !== storeId || !Array.isArray(o.l)) return null;
  if (o.l.length > CART_MAX_LINES) return null;
  const lines: CartLine[] = [];
  for (const raw of o.l) {
    if (!Array.isArray(raw) || raw.length !== 3) return null;
    const [p, variant, q] = raw as unknown[];
    if (typeof p !== "string" || !ID_RE.test(p)) return null;
    if (variant !== null && (typeof variant !== "string" || !ID_RE.test(variant))) return null;
    if (!Number.isInteger(q) || (q as number) < 1 || (q as number) > CART_MAX_QTY) return null;
    lines.push({ productId: p, variantId: variant as string | null, qty: q as number });
  }
  const promo = o.c === null || o.c === undefined ? null : normalizePromoCode(o.c);
  if (o.c != null && promo === null) return null;
  return { storeId, lines: mergeLines(lines), promoCode: promo };
}

/** Serialize + sign. Throws CartConfigError without a server secret. */
export function signCart(cart: Cart, env: Record<string, string | undefined> = process.env): string {
  const secret = cartSecret(env);
  if (!secret) throw new CartConfigError();
  const body = {
    v: CART_VERSION,
    s: cart.storeId,
    l: cart.lines.slice(0, CART_MAX_LINES).map((l) => [l.productId, l.variantId, l.qty]),
    c: cart.promoCode,
  };
  const payload = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  return `${payload}.${mac(secret, payload)}`;
}

/**
 * Verify + parse a cookie value for this store. Any failure (no secret, bad
 * signature, another store's cart, malformed body) yields an EMPTY cart —
 * a broken cookie is never an error page, and never trusted.
 */
export function readCart(
  value: string | null | undefined,
  storeId: string,
  env: Record<string, string | undefined> = process.env,
): Cart {
  const secret = cartSecret(env);
  if (!value || !secret || value.length > 8192) return emptyCart(storeId);
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return emptyCart(storeId);
  const payload = value.slice(0, dot);
  const sig = Buffer.from(value.slice(dot + 1), "base64url");
  const want = Buffer.from(mac(secret, payload), "base64url");
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) return emptyCart(storeId);
  try {
    return parseCart(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), storeId) ?? emptyCart(storeId);
  } catch {
    return emptyCart(storeId);
  }
}

const lineKey = (l: Pick<CartLine, "productId" | "variantId">) => `${l.productId}|${l.variantId ?? ""}`;

function mergeLines(lines: CartLine[]): CartLine[] {
  const out = new Map<string, CartLine>();
  for (const l of lines) {
    const k = lineKey(l);
    const cur = out.get(k);
    out.set(k, cur ? { ...cur, qty: Math.min(CART_MAX_QTY, cur.qty + l.qty) } : { ...l });
  }
  return [...out.values()];
}

export class CartError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "CartError";
  }
}

function checkIds(productId: unknown, variantId: unknown): { productId: string; variantId: string | null } {
  if (typeof productId !== "string" || !ID_RE.test(productId)) throw new CartError("Unknown product");
  if (variantId != null && (typeof variantId !== "string" || !ID_RE.test(variantId))) throw new CartError("Unknown option");
  return { productId, variantId: (variantId as string | null | undefined) ?? null };
}

function checkQty(qty: unknown, allowZero: boolean): number {
  const n = typeof qty === "number" ? qty : typeof qty === "string" ? Number(qty) : NaN;
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1) || n > CART_MAX_QTY) {
    throw new CartError(`Quantity must be a whole number from ${allowZero ? 0 : 1} to ${CART_MAX_QTY}`);
  }
  return n;
}

/** Add qty of a product/variant (merges with an existing line, capped). */
export function addToCart(cart: Cart, productId: unknown, variantId: unknown, qty: unknown): Cart {
  const ids = checkIds(productId, variantId);
  const n = checkQty(qty ?? 1, false);
  const exists = cart.lines.some((l) => lineKey(l) === lineKey(ids));
  if (!exists && cart.lines.length >= CART_MAX_LINES) throw new CartError(`A cart holds at most ${CART_MAX_LINES} different items`);
  return { ...cart, lines: mergeLines([...cart.lines, { ...ids, qty: n }]) };
}

/** Set a line's quantity; 0 removes it. */
export function setCartQty(cart: Cart, productId: unknown, variantId: unknown, qty: unknown): Cart {
  const ids = checkIds(productId, variantId);
  const n = checkQty(qty, true);
  const k = lineKey(ids);
  if (n === 0) return { ...cart, lines: cart.lines.filter((l) => lineKey(l) !== k) };
  if (!cart.lines.some((l) => lineKey(l) === k)) return addToCart(cart, ids.productId, ids.variantId, n);
  return { ...cart, lines: cart.lines.map((l) => (lineKey(l) === k ? { ...l, qty: n } : l)) };
}

export function setCartPromo(cart: Cart, code: unknown): Cart {
  if (code === null || code === undefined || code === "") return { ...cart, promoCode: null };
  const c = normalizePromoCode(code);
  if (!c) throw new CartError("That code doesn't look right");
  return { ...cart, promoCode: c };
}

export function cartItemCount(cart: Cart): number {
  return cart.lines.reduce((s, l) => s + l.qty, 0);
}

/** Cookie attributes: HttpOnly, SameSite=Lax, Secure on https deployments. */
export function cartCookieOptions(env: Record<string, string | undefined> = process.env) {
  const url = (env.APP_URL ?? env.NEXTAUTH_URL ?? "").trim().toLowerCase();
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.NODE_ENV === "production" && !url.startsWith("http://"),
    path: "/",
    maxAge: CART_MAX_AGE_S,
  };
}
