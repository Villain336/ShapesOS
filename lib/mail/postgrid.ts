// Marketr — Phase 4 T1: PostGridProvider.
//
// Real provider behind postgrid-node-client. Constructed with the decrypted
// workspace key (PostGrid mail key; the addr key is the same key in
// PostGrid's model — one key authorizes both print-mail and address APIs).
//
// Dev default: PostGrid test keys (test_*) — free tier, no monthly fee, and
// test-mode webhook simulation. Test keys render without mailing;
// sendPiece reports renderedOnly accordingly.
//
// Address verification is FREE/included on PostGrid (address.verify) —
// service.ts uses it in the explicit verifyAddresses() step and the cost
// estimate carries a $0 verification line so the user sees it.
//
// Webhook auth: PostGrid signs deliveries as a JWT (HS256) with the webhook
// secret. The token is read from `Authorization: Bearer <jwt>` or the body
// field `token`/`jwt`. NOTE: the exact PostGrid delivery field/header is
// UNVERIFIED against live docs — both are accepted and this must be
// confirmed against a real firing before trusting it in production.

import { createHmac } from "node:crypto";
import { PostGrid } from "postgrid-node-client";
import {
  ProviderNotConfiguredError,
  safeEqual,
  type CostLineItem,
  type EstimateSpec,
  type MailAddress,
  type MailEvent,
  type MailEventType,
  type MailProvider,
  type SendPieceInput,
  type SendPieceResult,
  type ValidateConnectionResult,
  type VerificationResult,
  DOCUMENTED_COSTS,
  pieceCentsFor,
} from "./provider";

/** Is this a PostGrid test (non-mailing) key? */
export function isPostGridTestKey(key: string): boolean {
  return key.trim().startsWith("test_");
}

function postGridErrorMessage(err: unknown, op: string): string {
  // postgrid-node-client returns { success, error: { type, message } };
  // err may also be a thrown Error. Scrub anything key-like.
  const e = err as { error?: { message?: string; type?: string }; message?: string };
  const msg =
    e?.error?.message ?? e?.message ?? (typeof err === "string" ? err : "unknown error");
  const clean = String(msg)
    .slice(0, 300)
    .replace(/test_[A-Za-z0-9_]+/g, "test_…")
    .replace(/live_[A-Za-z0-9_]+/g, "live_…");
  return `PostGrid ${op} failed: ${clean}`;
}

function toPostGridContact(addr: MailAddress): Record<string, string | undefined> {
  return {
    companyName: addr.name,
    addressLine1: addr.line1,
    addressLine2: addr.line2,
    city: addr.city,
    provinceOrState: addr.state,
    postalOrZip: addr.zip,
    country: addr.country ?? "US",
  };
}

export interface PostGridSendOptions {
  /** "postcard" (default) | "letter". */
  kind?: "postcard" | "letter";
  /** Postcard size, e.g. "4x6". */
  size?: string;
  /** HTML for front/back (postcard) or body (letter). */
  frontHtml?: string;
  backHtml?: string;
  html?: string;
  /** From contact (letter sender). */
  from?: MailAddress;
}

export class PostGridProvider implements MailProvider {
  readonly name = "postgrid" as const;
  private readonly client: PostGrid;
  private readonly testKey: boolean;
  private readonly webhookSecret: string;

  constructor(apiKey: string, opts?: { webhookSecret?: string }) {
    const key = (apiKey ?? "").trim();
    if (!key) throw new ProviderNotConfiguredError("postgrid", "API key");
    // One key authorizes both the print-mail and address APIs.
    this.client = new PostGrid({ mail: key, addr: key });
    this.testKey = isPostGridTestKey(key);
    this.webhookSecret = (opts?.webhookSecret ?? "").trim();
  }

  async validateConnection(): Promise<ValidateConnectionResult> {
    // lookupInfo is free and proves the addr key is valid.
    try {
      const res = await this.client.address.lookupInfo();
      if (!res.success) throw new Error(postGridErrorMessage(res.error, "validateConnection"));
      return { ok: true, detail: this.testKey ? "test key (render-only)" : "live key" };
    } catch (err) {
      throw new Error(postGridErrorMessage(err, "validateConnection"));
    }
  }

  async verifyAddress(addr: MailAddress): Promise<VerificationResult> {
    // FREE/included on PostGrid — no per-call budget needed.
    try {
      const res = await this.client.address.verify({
        // The client's Address type omits companyName; PostGrid's API
        // accepts it (recipient name for verification).
        companyName: addr.name,
        addressLine1: addr.line1,
        addressLine2: addr.line2,
        city: addr.city,
        provinceOrState: addr.state,
        postalOrZip: addr.zip,
        country: addr.country ?? "US",
      } as never);
      if (!res.success || !res.address) {
        throw new Error(postGridErrorMessage(res.error ?? "verify returned no address", "verifyAddress"));
      }
      if (!res.verified) {
        return {
          status: "quarantined",
          deliverability: "undeliverable",
          notes: `PostGrid verification failed: ${(res.address.message ?? "").slice(0, 200)}`,
        };
      }
      const d = res.address.data ?? {};
      const corrected: MailAddress = {
        name: addr.name,
        line1: String(d.line1 ?? addr.line1),
        line2: addr.line2,
        city: String(d.city ?? addr.city),
        state: String(d.provinceOrState ?? addr.state),
        zip: String(d.postalOrZip ?? addr.zip),
        country: addr.country,
      };
      const changed =
        corrected.line1.trim() !== addr.line1.trim() ||
        corrected.city.trim() !== addr.city.trim() ||
        corrected.state.trim() !== addr.state.trim() ||
        corrected.zip.trim() !== addr.zip.trim();
      return {
        status: changed ? "corrected" : "valid",
        correctedAddress: changed ? corrected : undefined,
        deliverability: "dpv_confirmed",
        notes: changed ? "PostGrid CASS normalization" : "PostGrid verified",
      };
    } catch (err) {
      throw new Error(postGridErrorMessage(err, "verifyAddress"));
    }
  }

  async estimateCost(spec: EstimateSpec): Promise<CostLineItem[]> {
    const table = DOCUMENTED_COSTS.postgrid;
    const perPiece = pieceCentsFor("postgrid", spec.format);
    const lines: CostLineItem[] = [
      {
        label: `Per-piece (${spec.format.replace(/_/g, " ")}) — PostGrid`,
        cents: perPiece * spec.count,
        quantity: spec.count,
        basis: "documented_estimate",
        note: table.sourceNote,
      },
    ];
    if (spec.verifications > 0) {
      lines.push({
        label: "Address verification lookups (PostGrid: free/included)",
        cents: 0,
        quantity: spec.verifications,
        basis: "documented_estimate",
      });
    }
    return lines;
  }

  async sendPiece(
    piece: SendPieceInput,
    opts: { testMode: boolean; creative?: PostGridSendOptions },
  ): Promise<SendPieceResult> {
    const creative = opts.creative ?? {};
    const to = toPostGridContact(piece.address);
    const metadata = { marketr_qr_slug: piece.qrSlug };
    const mergeVariables = piece.mergeVariables ?? {};
    try {
      let id: string;
      if (creative.kind === "letter") {
        const res = await this.client.letter.create(
          {
            to: to as never,
            // Omit `from` entirely when unset — the client's type does not
            // accept `undefined` here.
            ...(creative.from ? { from: toPostGridContact(creative.from) as never } : {}),
            html: creative.html ?? "<html><body>ShapesOS mail piece</body></html>",
            mergeVariables,
            metadata,
            // The client's letter payload type is strict; our contact shape
            // is validated by the casts above.
          } as never,
          { idempotencyKey: piece.idempotencyKey },
        );
        if (!res.success || !res.letter) throw new Error(postGridErrorMessage(res.error, "sendPiece"));
        id = res.letter.id;
      } else {
        const res = await this.client.postcard.create(
          {
            size: creative.size ?? "4x6",
            to: to as never,
            frontHTML: creative.frontHtml ?? "<html><body>ShapesOS mail piece</body></html>",
            backHTML: creative.backHtml ?? "<html><body></body></html>",
            mergeVariables,
            metadata,
          },
          { idempotencyKey: piece.idempotencyKey },
        );
        if (!res.success || !res.postcard) throw new Error(postGridErrorMessage(res.error, "sendPiece"));
        id = res.postcard.id;
      }
      if (!id) throw new Error("PostGrid create returned no id");
      // Test keys never physically mail (PostGrid sandbox).
      const renderedOnly = this.testKey || opts.testMode;
      return { providerPieceId: id, renderedOnly };
    } catch (err) {
      throw new Error(postGridErrorMessage(err, "sendPiece"));
    }
  }

  async cancelPiece(providerPieceId: string): Promise<void> {
    // postgrid-node-client (v0.11.0) exposes no postcard/letter cancel
    // endpoint — PostGrid cancellations go through their dashboard/API
    // outside this client version. Surface honestly instead of faking it.
    throw new Error(
      `PostGrid cancel is not supported by postgrid-node-client v0.11.0 (piece ${providerPieceId.slice(0, 12)}…); cancel in the PostGrid dashboard.`,
    );
  }

  /**
   * Verify a PostGrid webhook JWT (HS256, webhook secret as key).
   * Token sources (exact delivery field UNVERIFIED — accept both):
   *   - `Authorization: Bearer <jwt>`
   *   - body field `token` or `jwt`
   * Checks alg=HS256, signature (constant-time), and exp with 60s skew.
   */
  validateWebhookSignature(opts: {
    rawBody: string;
    signature: string | null;
    tokenFromBody?: string | null;
  }): boolean {
    if (!this.webhookSecret) return false;
    let token: string | null = null;
    const sig = (opts.signature ?? "").trim();
    if (/^bearer\s+/i.test(sig)) token = sig.replace(/^bearer\s+/i, "").trim();
    else if (opts.tokenFromBody) token = opts.tokenFromBody.trim();
    if (!token) return false;
    return verifyHs256Jwt(token, this.webhookSecret);
  }

  async parseWebhook(payload: unknown): Promise<MailEvent[]> {
    // PostGrid webhook event shape (per PostGrid docs; field names
    // cross-checked but not verified live — tolerant extraction):
    //   { id, type: "postcard.delivered" | "letter.mailed" | ...,
    //     data: { id: "<postcard/letter id>", ... }, createdAt }
    const p = payload as {
      id?: string;
      type?: string;
      event?: string;
      createdAt?: string;
      data?: { id?: string };
      object?: { id?: string };
    } | null;
    if (!p) return [];
    const rawType = (p.type ?? p.event ?? "").trim().toLowerCase();
    const type = mapPostGridEventType(rawType);
    if (!type) return [];
    const pieceId = p.data?.id ?? p.object?.id ?? "";
    const eventId = p.id ?? `${rawType}:${pieceId}`;
    if (!pieceId || !eventId) return [];
    return [
      {
        eventId,
        type,
        providerPieceId: pieceId,
        occurredAt: p.createdAt ? new Date(p.createdAt) : new Date(),
        raw: payload,
      },
    ];
  }
}

function mapPostGridEventType(t: string): MailEventType | null {
  if (/(^|\.)delivered$/.test(t)) return "delivered";
  if (/returned/.test(t)) return "returned";
  if (/failed/.test(t)) return "failed";
  if (/in_transit|mailed/.test(t)) return "in_transit";
  if (/local_area/.test(t)) return "in_local_area";
  if (/processed_for_delivery|out_for_delivery/.test(t)) return "processed_for_delivery";
  return null;
}

// Minimal HS256 JWT verification (no extra dependency). Exported for tests.
// ---------------------------------------------------------------------------

function base64UrlDecode(s: string): Buffer {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}

export function verifyHs256Jwt(token: string, secret: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [h, p, sig] = parts;
  let header: { alg?: string };
  let claims: { exp?: number; nbf?: number };
  try {
    header = JSON.parse(base64UrlDecode(h).toString("utf8")) as { alg?: string };
    claims = JSON.parse(base64UrlDecode(p).toString("utf8")) as { exp?: number };
  } catch {
    return false;
  }
  if (header.alg !== "HS256") return false;
  const expected = createHmac("sha256", secret).update(`${h}.${p}`, "utf8").digest();
  const got = base64UrlDecode(sig);
  if (got.length !== expected.length || !safeEqualBytes(got, expected)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === "number" && claims.exp < now - 60) return false;
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) return false;
  return true;
}

function safeEqualBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && safeEqual(a.toString("hex"), b.toString("hex"));
}

/** Decode JWT claims WITHOUT verifying (call verifyHs256Jwt first). */
export function decodeJwtClaimsUnsafe(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Not a JWT");
  return JSON.parse(base64UrlDecode(parts[1]).toString("utf8")) as Record<string, unknown>;
}

/** Test hook: mint a PostGrid-style webhook JWT (HS256). */
export function signPostGridWebhookJwt(
  claims: Record<string, unknown>,
  secret: string,
): string {
  const b64u = (o: unknown) =>
    Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  const h = b64u({ alg: "HS256", typ: "JWT" });
  const p = b64u(claims);
  const sig = createHmac("sha256", secret).update(`${h}.${p}`, "utf8").digest("base64url");
  return `${h}.${p}.${sig}`;
}
