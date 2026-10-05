// ShapesOS — Phase 12 (people): QR tickets.
//
// Every attendee has a random ticketCode (stored, unique). The QR ticket is
// a SIGNED token over (workspace, event, attendee, ticketCode):
//   "t1." + base64url(JSON) + "." + HMAC-SHA256
// keyed by a key derived from the deployment's auth secret (AUTH_SECRET,
// falling back to NEXTAUTH_SECRET — the same family as the storefront cart,
// lib/ops/store/cart.ts) under its own label. The signature lets the
// check-in endpoint reject forged or mangled codes before touching the
// database; the database lookup (attendee id + ticketCode, constant-time
// compared) is what makes a ticket valid — a cancelled attendee's token
// stops working even though its signature still verifies.
//
// The QR image encodes the ticket page URL (/events/ticket/<token>) and is
// drawn with the Creative Studio QR engine (lib/studio/qr-designer: real
// matrix, EC level H, classic square modules, black on white).

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cartSecret } from "../store/cart";
import { designGlyph, generateQrMatrix, renderStyledQr, type QrStyleSpec, type RenderedQr } from "@/lib/studio/qr-designer";

export const TICKET_TOKEN_PREFIX = "t1";
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface TicketClaims {
  workspaceId: string;
  eventId: string;
  attendeeId: string;
  ticketCode: string;
}

export class TicketConfigError extends Error {
  constructor() {
    super("QR tickets need AUTH_SECRET (or NEXTAUTH_SECRET) to be set on the server.");
    this.name = "TicketConfigError";
  }
}

/** A fresh random ticket code (128 bits). */
export function newTicketCode(): string {
  return randomBytes(16).toString("base64url");
}

function key(secret: string): Buffer {
  return createHmac("sha256", secret).update("shapes:event-ticket:v1").digest();
}

function mac(secret: string, payload: string): string {
  return createHmac("sha256", key(secret)).update(`${TICKET_TOKEN_PREFIX}.${payload}`).digest("base64url");
}

export function signTicket(c: TicketClaims, env: Record<string, string | undefined> = process.env): string {
  const secret = cartSecret(env);
  if (!secret) throw new TicketConfigError();
  for (const v of [c.workspaceId, c.eventId, c.attendeeId, c.ticketCode]) {
    if (!ID_RE.test(v)) throw new Error("ticket claims must be url-safe ids");
  }
  const payload = Buffer.from(JSON.stringify({ w: c.workspaceId, e: c.eventId, a: c.attendeeId, c: c.ticketCode })).toString("base64url");
  return `${TICKET_TOKEN_PREFIX}.${payload}.${mac(secret, payload)}`;
}

/** Verify a token's signature and shape. Null when forged, mangled or unsigned. */
export function verifyTicket(token: unknown, env: Record<string, string | undefined> = process.env): TicketClaims | null {
  if (typeof token !== "string" || token.length > 600) return null;
  const secret = cartSecret(env);
  if (!secret) return null;
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== TICKET_TOKEN_PREFIX) return null;
  const [, payload, sig] = parts as [string, string, string];
  const want = Buffer.from(mac(secret, payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const o = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const claims = { workspaceId: o.w, eventId: o.e, attendeeId: o.a, ticketCode: o.c };
    for (const v of Object.values(claims)) if (typeof v !== "string" || !ID_RE.test(v)) return null;
    return claims as TicketClaims;
  } catch {
    return null;
  }
}

/** Pull a ticket token out of whatever a scanner typed: the token, or a ticket URL. */
export function extractTicketToken(scanned: unknown): string | null {
  if (typeof scanned !== "string") return null;
  const s = scanned.trim();
  const m = /(t1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(s);
  return m ? m[1]! : null;
}

/** Constant-time ticket-code compare. */
export function sameTicketCode(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function ticketUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/events/ticket/${token}`;
}

const TICKET_QR_SPEC: QrStyleSpec = {
  moduleGlyph: "square",
  glyphLabel: "classic",
  shapeMask: "square",
  foreground: "#000000",
  background: "#FFFFFF",
  finderStyle: "solid",
  logoImagePng: null,
  frameCta: null,
  errorCorrection: "H",
  quietZoneModules: 4,
  fillFraction: 1,
};

/** The ticket QR (PNG + SVG) for a ticket URL. */
export function renderTicketQr(url: string, modulePx = 8): RenderedQr {
  return renderStyledQr(generateQrMatrix(url), TICKET_QR_SPEC, designGlyph("square"), { modulePx });
}

// ---------------------------------------------------------------------------
// Registration view tokens: the link a registrant lands on after signing up
// (and Stripe's success_url) — "r1." + base64url(JSON) + "." + HMAC. It
// only lets the holder SEE that registration's status and its tickets.
// ---------------------------------------------------------------------------

export interface RegistrationViewClaims {
  workspaceId: string;
  registrationId: string;
}

function viewMac(secret: string, payload: string): string {
  return createHmac("sha256", key(secret)).update(`r1.${payload}`).digest("base64url");
}

export function signRegistrationView(c: RegistrationViewClaims, env: Record<string, string | undefined> = process.env): string {
  const secret = cartSecret(env);
  if (!secret) throw new TicketConfigError();
  if (!ID_RE.test(c.workspaceId) || !ID_RE.test(c.registrationId)) throw new Error("claims must be url-safe ids");
  const payload = Buffer.from(JSON.stringify({ w: c.workspaceId, r: c.registrationId })).toString("base64url");
  return `r1.${payload}.${viewMac(secret, payload)}`;
}

export function verifyRegistrationView(token: unknown, env: Record<string, string | undefined> = process.env): RegistrationViewClaims | null {
  if (typeof token !== "string" || token.length > 400) return null;
  const secret = cartSecret(env);
  if (!secret) return null;
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== "r1") return null;
  const [, payload, sig] = parts as [string, string, string];
  const want = Buffer.from(viewMac(secret, payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const o = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof o.w !== "string" || typeof o.r !== "string" || !ID_RE.test(o.w) || !ID_RE.test(o.r)) return null;
    return { workspaceId: o.w, registrationId: o.r };
  } catch {
    return null;
  }
}
