// ShapesOS — Phase 21A round 2 (WS=agentweb): cart objects (PURE).
//
// A cart is what the person is asked to approve with one click, so it is validated hard
// (sane integers, a web merchant, an ISO-looking currency), reduced to a canonical form and
// hashed: the cart mandate binds to that hash, so approving one cart can never authorise
// another. Amounts are integers in minor units, never floats.
//
// Card details never belong here: assertNoCardData refuses any value that looks like a
// payment card number or a card-ish field, without echoing it. It runs on cart input and on
// everything handed to a checkout adapter; card entry stays between the person and the
// merchant's own payment page.

import { createHash } from "node:crypto";

export class CartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CartError";
  }
}
export class CardDataError extends Error {
  constructor(where: string) {
    super(`Payment card data is not accepted here (${where}). Card details are entered only on the merchant's payment page, by the person.`);
    this.name = "CardDataError";
  }
}

export interface CartItem {
  sku?: string;
  name: string;
  qty: number;
  unitMinor: number;
}
export interface Cart {
  merchant: { name: string; origin: string };
  items: CartItem[];
  /** ISO 4217 style, upper case. */
  currency: string;
  runId?: string | null;
}

const MAX_ITEMS = 50;
const MAX_QTY = 99;
const MAX_UNIT_MINOR = 100_000_000;
const MAX_TOTAL_MINOR = 1_000_000_000;

const clean = (s: unknown, max: number): string =>
  String(s ?? "")
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁠﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

export function normalizeCart(input: unknown): Cart {
  const o = (input ?? {}) as Record<string, unknown>;
  const m = (o.merchant ?? {}) as Record<string, unknown>;
  let origin: string;
  try {
    const u = new URL(String(m.origin ?? ""));
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme");
    origin = u.origin;
  } catch {
    throw new CartError("The merchant must be a web address (https://…).");
  }
  const name = clean(m.name, 120);
  if (!name) throw new CartError("The merchant needs a name.");
  const currency = String(o.currency ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new CartError("The currency must be a three-letter code such as GBP.");
  const rawItems = Array.isArray(o.items) ? o.items : [];
  if (rawItems.length < 1) throw new CartError("The cart has no items.");
  if (rawItems.length > MAX_ITEMS) throw new CartError(`A cart can hold at most ${MAX_ITEMS} lines.`);
  const items: CartItem[] = rawItems.map((raw, i) => {
    const it = (raw ?? {}) as Record<string, unknown>;
    const itemName = clean(it.name, 120);
    if (!itemName) throw new CartError(`Item ${i + 1} needs a name.`);
    if (!isInt(it.qty) || it.qty < 1 || it.qty > MAX_QTY) throw new CartError(`Item ${i + 1}: the quantity must be a whole number from 1 to ${MAX_QTY}.`);
    if (!isInt(it.unitMinor) || it.unitMinor < 0 || it.unitMinor > MAX_UNIT_MINOR) throw new CartError(`Item ${i + 1}: the price must be a whole number of minor units (pence, cents).`);
    const sku = it.sku === undefined ? "" : clean(it.sku, 64);
    return { ...(sku ? { sku } : {}), name: itemName, qty: it.qty, unitMinor: it.unitMinor };
  });
  const cart: Cart = { merchant: { name, origin }, items, currency, ...(typeof o.runId === "string" ? { runId: o.runId } : {}) };
  if (totalMinor(cart) > MAX_TOTAL_MINOR) throw new CartError("The total is too large to approve here.");
  assertNoCardData(cart);
  return cart;
}

export function totalMinor(cart: Pick<Cart, "items">): number {
  return cart.items.reduce((s, i) => s + i.qty * i.unitMinor, 0);
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** sha256 over the canonical form of what the person approves (merchant, items, currency; not the run). */
export function cartHash(cart: Cart): string {
  return createHash("sha256").update(canonical({ merchant: cart.merchant, items: cart.items, currency: cart.currency })).digest("hex");
}

// ---------------------------------------------------------------------------
// Card data guard
// ---------------------------------------------------------------------------

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const CARD_FIELD = /^(cc[-_ ]?(number|num|csc|cvc|exp)|card[-_ ]?(number|num|cvc|cvv|expiry|exp)|cvv2?|cvc2?|csc|pan|security[-_ ]?code)$/i;

function hasCardNumber(s: string): boolean {
  for (const m of s.matchAll(/(?:\d[ -]?){13,19}/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

export function assertNoCardData(value: unknown, path = "value"): void {
  if (typeof value === "string") {
    if (hasCardNumber(value)) throw new CardDataError(path);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoCardData(v, `${path}[${i}]`));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (CARD_FIELD.test(k) && v !== undefined && v !== null && v !== "") throw new CardDataError(`${path}.${k}`);
      assertNoCardData(v, `${path}.${k}`);
    }
  }
}
