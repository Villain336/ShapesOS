// Marketr — Phase 4 T1: LobProvider.
//
// Real provider behind @lob/lob-typescript-sdk. Constructed with the
// decrypted workspace key (test or live). Lob test keys (test_*) render
// postcards/letters in the dashboard WITHOUT physically mailing — that is
// the "test render" path; sendPiece reports renderedOnly accordingly.
//
// Money guard: LobProvider itself never decides live vs test policy —
// lib/mail/service.ts routes test mode to the fake provider and gates live
// sends behind an approved MailApproval + provider row mode "live".
//
// Address verification (verifyAddress) is a PAID add-on on Lob
// (~$0.05/lookup Developer tier, docs/phase4-research.md). The cost is
// surfaced as a line item in estimateCost; service.ts calls verifyAddress
// only from the explicit verifyAddresses() campaign step — never silently.
//
// Lob's API is axios-based; errors carry err.response.status/data. All
// error messages are scrubbed of key material before throwing.

import { createHmac } from "node:crypto";
import {
  Configuration,
  PostcardsApi,
  LettersApi,
  UsVerificationsApi,
} from "@lob/lob-typescript-sdk";
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

const POSTCARD_USE_TYPE = "marketing" as const;

/** Is this a Lob test (non-mailing) key? */
export function isLobTestKey(key: string): boolean {
  return key.trim().startsWith("test_");
}

function lobErrorMessage(err: unknown, op: string): string {
  // axios errors: response.status + response.data. Scrub anything that
  // looks like a key; keep status + provider message only.
  const e = err as {
    response?: { status?: number; data?: { error?: { message?: string } } };
    message?: string;
  };
  const status = e?.response?.status;
  const msg = e?.response?.data?.error?.message ?? e?.message ?? "unknown error";
  const clean = String(msg).slice(0, 300).replace(/test_[A-Za-z0-9]+/g, "test_…").replace(/live_[A-Za-z0-9]+/g, "live_…");
  return `Lob ${op} failed${status ? ` (HTTP ${status})` : ""}: ${clean}`;
}

export interface LobSendOptions {
  /** Creative source for front/back (template ids or HTML). */
  front: string;
  back: string;
  /** Postcard size, e.g. "4x6". Letters ignore this. */
  size?: string;
  /** "postcard" (default) | "letter". */
  kind?: "postcard" | "letter";
  /** Optional from-address for letters. */
  from?: MailAddress;
}

export class LobProvider implements MailProvider {
  readonly name = "lob" as const;
  // `any`: @lob/lob-typescript-sdk ships an ambient declaration locally
  // (see types/lob-sdk.d.ts) because its exports map hides its own types.
  private readonly config: any;
  private readonly testKey: boolean;
  private readonly webhookSecret: string;

  constructor(apiKey: string, opts?: { webhookSecret?: string }) {
    const key = (apiKey ?? "").trim();
    if (!key) throw new ProviderNotConfiguredError("lob", "API key");
    this.config = new Configuration({ username: key });
    this.testKey = isLobTestKey(key);
    this.webhookSecret = (opts?.webhookSecret ?? "").trim();
  }

  async validateConnection(): Promise<ValidateConnectionResult> {
    // Light read-only call: list one postcard. Works with test keys and
    // costs nothing (no verification lookup, no mailing).
    try {
      const api = new PostcardsApi(this.config);
      await api.list(1);
      return { ok: true, detail: this.testKey ? "test key (render-only)" : "live key" };
    } catch (err) {
      throw new Error(lobErrorMessage(err, "validateConnection"));
    }
  }

  async verifyAddress(addr: MailAddress): Promise<VerificationResult> {
    // PAID add-on — callers must budget it (see module header).
    const api = new UsVerificationsApi(this.config);
    try {
      const res = await api.verifySingle({
        recipient: addr.name,
        primary_line: addr.line1,
        secondary_line: addr.line2,
        city: addr.city,
        state: addr.state,
        zip_code: addr.zip,
      } as never);
      const deliverability = (res as { deliverability?: string }).deliverability ?? null;
      const valid = (res as { valid_address?: string }).valid_address === "true";
      if (deliverability === "undeliverable" || !valid) {
        return {
          status: "quarantined",
          deliverability,
          notes: "Lob verification: undeliverable",
        };
      }
      const comps = (res as { components?: Record<string, unknown> }).components ?? {};
      const corrected: MailAddress = {
        name: addr.name,
        line1: String(comps.primary_line ?? addr.line1),
        line2: addr.line2,
        city: String(comps.city ?? addr.city),
        state: String(comps.state ?? addr.state),
        zip: String(
          (comps as Record<string, unknown>).zip_code ?? addr.zip,
        ),
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
        deliverability,
        notes: changed ? "Lob CASS normalization" : "Lob verified deliverable",
      };
    } catch (err) {
      throw new Error(lobErrorMessage(err, "verifyAddress"));
    }
  }

  async estimateCost(spec: EstimateSpec): Promise<CostLineItem[]> {
    const table = DOCUMENTED_COSTS.lob;
    const perPiece = pieceCentsFor("lob", spec.format);
    const lines: CostLineItem[] = [
      {
        label: `Per-piece (${spec.format.replace(/_/g, " ")}) — Lob Developer tier`,
        cents: perPiece * spec.count,
        quantity: spec.count,
        basis: "documented_estimate",
        note: table.sourceNote,
      },
    ];
    if (spec.verifications > 0) {
      lines.push({
        label: "Address verification lookups (Lob paid add-on ~$0.05/ea)",
        cents: table.verificationCents * spec.verifications,
        quantity: spec.verifications,
        basis: "documented_estimate",
        note: "Lob charges verification per lookup on Developer tier; Startup/Growth bundle quotas.",
      });
    }
    return lines;
  }

  async sendPiece(
    piece: SendPieceInput,
    opts: { testMode: boolean; creative?: LobSendOptions },
  ): Promise<SendPieceResult> {
    const creative = opts.creative ?? { front: "<html><body>Marketr mail piece</body></html>", back: "<html><body></body></html>" };
    const to = {
      name: piece.address.name,
      address_line1: piece.address.line1,
      address_line2: piece.address.line2,
      address_city: piece.address.city,
      address_state: piece.address.state,
      address_zip: piece.address.zip,
      address_country: piece.address.country ?? "US",
    };
    const metadata = { marketr_qr_slug: piece.qrSlug };
    const merge = piece.mergeVariables ?? {};
    try {
      let id: string;
      if (creative.kind === "letter") {
        const api = new LettersApi(this.config);
        const letter = await api.create(
          {
            to,
            from: creative.from
              ? {
                  name: creative.from.name,
                  address_line1: creative.from.line1,
                  address_city: creative.from.city,
                  address_state: creative.from.state,
                  address_zip: creative.from.zip,
                  address_country: creative.from.country ?? "US",
                }
              : undefined,
            file: creative.front,
            color: true,
            metadata,
            merge_variables: merge,
          } as never,
          piece.idempotencyKey,
        );
        id = (letter as { id?: string }).id ?? "";
      } else {
        const api = new PostcardsApi(this.config);
        const postcard = await api.create(
          {
            to,
            front: creative.front,
            back: creative.back,
            size: (creative.size ?? "4x6") as never,
            mail_type: "usps_first_class" as never,
            metadata,
            merge_variables: merge,
            use_type: POSTCARD_USE_TYPE as never,
          } as never,
          piece.idempotencyKey,
        );
        id = (postcard as { id?: string }).id ?? "";
      }
      if (!id) throw new Error("Lob create returned no id");
      // renderedOnly when a test key was used OR the caller asked for a
      // test-mode render: test_ keys never physically mail (Lob sandbox).
      const renderedOnly = this.testKey || opts.testMode;
      return { providerPieceId: id, renderedOnly };
    } catch (err) {
      throw new Error(lobErrorMessage(err, "sendPiece"));
    }
  }

  async cancelPiece(providerPieceId: string): Promise<void> {
    // Cancellation windows are a Lob premium feature; attempt the delete
    // and surface the provider's error honestly.
    try {
      if (providerPieceId.startsWith("psc_")) {
        await new PostcardsApi(this.config).cancel(providerPieceId);
      } else if (providerPieceId.startsWith("ltr_")) {
        await new LettersApi(this.config).cancel(providerPieceId);
      } else {
        throw new Error(`Unknown Lob piece id prefix: ${providerPieceId.slice(0, 8)}…`);
      }
    } catch (err) {
      throw new Error(lobErrorMessage(err, "cancelPiece"));
    }
  }

  /**
   * Lob's documented signing scheme (help.lob.com "Using webhooks"):
   *   signature = HMAC-SHA256(secret, "<Lob-Signature-Timestamp>.<rawBody>")
   * as a hex digest, sent in the Lob-Signature header. Timestamp tolerance
   * 10 minutes (Lob's docs recommend 5; headroom for clock drift).
   * NOTE: cross-checked against community integrations citing Lob's docs —
   * not yet verified against a live firing. Failing closed when the secret
   * is unconfigured.
   */
  validateWebhookSignature(opts: {
    rawBody: string;
    signature: string | null;
    timestamp?: string | null;
  }): boolean {
    if (!this.webhookSecret) return false;
    if (!opts.signature || !opts.timestamp) return false;
    const ts = Number(opts.timestamp);
    if (!Number.isFinite(ts)) return false;
    const nowSec = Math.floor(Date.now() / 1000);
    // Accept seconds or milliseconds timestamps.
    const tsSec = ts > 1e12 ? Math.floor(ts / 1000) : ts;
    if (Math.abs(nowSec - tsSec) > 600) return false;
    const expected = createHmac("sha256", this.webhookSecret)
      .update(`${opts.timestamp}.${opts.rawBody}`, "utf8")
      .digest("hex");
    return safeEqual(opts.signature.trim(), expected);
  }

  async parseWebhook(payload: unknown): Promise<MailEvent[]> {
    // Lob event shape: { id, event_type: "postcard.delivered", date_created,
    //   data: { id: "psc_...", ... } }
    const p = payload as {
      id?: string;
      event_type?: string;
      date_created?: string;
      data?: { id?: string };
    } | null;
    if (!p?.id || !p.event_type) return [];
    const type = mapLobEventType(p.event_type);
    if (!type) return []; // unknown event types are recorded, not mapped
    const pieceId = p.data?.id ?? "";
    if (!pieceId) return [];
    return [
      {
        eventId: p.id,
        type,
        providerPieceId: pieceId,
        occurredAt: p.date_created ? new Date(p.date_created) : new Date(),
        raw: payload,
      },
    ];
  }
}

function mapLobEventType(eventType: string): MailEventType | null {
  const t = eventType.trim().toLowerCase();
  if (t.endsWith(".delivered")) return "delivered";
  if (t.endsWith(".returned_to_sender")) return "returned";
  if (t.endsWith(".failed")) return "failed";
  if (t.endsWith(".in_transit")) return "in_transit";
  if (t.endsWith(".in_local_area")) return "in_local_area";
  if (t.endsWith(".processed_for_delivery")) return "processed_for_delivery";
  return null;
}

/** Test hook: sign a raw body the way Lob does (for the battery). */
export function signLobWebhook(rawBody: string, timestamp: string, secret: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
}
