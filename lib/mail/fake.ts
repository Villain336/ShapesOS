// Marketr — Phase 4 T1: FakeMailProvider (dev/test default).
//
// Simulates the whole provider contract deterministically:
// - verifyAddress: deterministic valid / corrected / quarantined based on
//   the address content (see rules below). No network.
// - estimateCost: the documented per-piece table from lib/mail/provider.ts.
// - sendPiece: render-only — records providerPieceId "fake_*" and logs a
//   one-line summary. NOTHING is physically mailed.
// - Webhook simulation (for tests): simulateTrackingSequence() emits the
//   in_transit → delivered sequence, simulateReturn() emits returned, all
//   with fake-signed payloads that validateWebhookSignature accepts.
//
// The webhook signature scheme mirrors lib/messaging/provider.ts:
// HMAC-SHA256(secret, url + JSON(params)) vs X-Fake-Signature, OR
// `Authorization: Bearer <FAKE_MAIL_SECRET>` (constant-time).

import { createHash, createHmac, randomBytes } from "node:crypto";
import { requireSecret } from "@/lib/env/secrets";
import {
  safeEqual,
  type CostLineItem,
  type EstimateSpec,
  type MailAddress,
  type MailEvent,
  type MailProvider,
  type SendPieceInput,
  type SendPieceResult,
  type ValidateConnectionResult,
  type VerificationResult,
  DOCUMENTED_COSTS,
  pieceCentsFor,
  keyHint,
} from "./provider";

export function fakeMailSecret(env: NodeJS.ProcessEnv = process.env): string {
  return requireSecret("FAKE_MAIL_SECRET", "fake-mail-dev-secret", env);
}

export function fakePieceId(seed = ""): string {
  const hex = seed
    ? createHash("sha256").update(seed).digest("hex").slice(0, 24)
    : randomBytes(12).toString("hex");
  return `fake_${hex}`;
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Deterministic verification rules (documented so tests can quote them):
 * - line1/city/state/zip missing or blank → quarantined ("incomplete_address")
 * - zip not matching /^\d{5}(-\d{4})?$/ → quarantined ("invalid_zip")
 * - line1 contains "undeliverable" (case-insensitive) → quarantined ("undeliverable")
 * - line1 contains "ncoa" → corrected: primary line rewritten to the
 *   provider-normalized form, deliverability "ncoa_changed" (flags the
 *   NCOA-changed path the spec calls out)
 * - city/state case fixed → corrected: normalized casing, deliverability
 *   "dpv_confirmed" (CASS-style casing normalization)
 * - otherwise → valid, deliverability "dpv_confirmed"
 */
export function deterministicVerify(addr: MailAddress): VerificationResult {
  if (!addr.line1.trim() || !addr.city.trim() || !addr.state.trim() || !addr.zip.trim()) {
    return { status: "quarantined", deliverability: "incomplete_address", notes: "Missing address component" };
  }
  if (!/^\d{5}(-\d{4})?$/.test(addr.zip.trim())) {
    return { status: "quarantined", deliverability: "invalid_zip", notes: "ZIP fails USPS format" };
  }
  if (norm(addr.line1).includes("undeliverable")) {
    return { status: "quarantined", deliverability: "undeliverable", notes: "Provider marked undeliverable" };
  }
  if (norm(addr.line1).includes("ncoa")) {
    const corrected: MailAddress = {
      ...addr,
      line1: "123 Forwarding Blvd",
      city: addr.city.trim(),
      state: addr.state.trim().toUpperCase(),
      zip: addr.zip.trim(),
    };
    return {
      status: "corrected",
      correctedAddress: corrected,
      deliverability: "ncoa_changed",
      notes: "NCOA: recipient moved — corrected to forwarding address",
    };
  }
  const normalized: MailAddress = {
    ...addr,
    line1: addr.line1.trim(),
    city: titleCase(addr.city.trim()),
    state: addr.state.trim().toUpperCase(),
    zip: addr.zip.trim(),
  };
  const changed =
    normalized.city !== addr.city ||
    normalized.state !== addr.state ||
    normalized.line1 !== addr.line1;
  if (changed) {
    return {
      status: "corrected",
      correctedAddress: normalized,
      deliverability: "dpv_confirmed",
      notes: "CASS casing normalization",
    };
  }
  return { status: "valid", deliverability: "dpv_confirmed" };
}

function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

export class FakeMailProvider implements MailProvider {
  readonly name = "fake" as const;
  private static counter = 0;

  static resetCounter(): void {
    FakeMailProvider.counter = 0;
  }

  async validateConnection(): Promise<ValidateConnectionResult> {
    // The fake provider is always "configured" — it's the dev default.
    return { ok: true, detail: "fake provider (no credentials needed)" };
  }

  async verifyAddress(addr: MailAddress): Promise<VerificationResult> {
    return deterministicVerify(addr);
  }

  async estimateCost(spec: EstimateSpec): Promise<CostLineItem[]> {
    const table = DOCUMENTED_COSTS.lob; // fake mirrors the Lob-documented tier
    const perPiece = pieceCentsFor("lob", spec.format);
    const lines: CostLineItem[] = [
      {
        label: `Per-piece (${spec.format.replace(/_/g, " ")}) — fake mirrors documented Lob Developer tier`,
        cents: perPiece * spec.count,
        quantity: spec.count,
        basis: "documented_estimate",
        note: table.sourceNote,
      },
    ];
    if (spec.verifications > 0) {
      lines.push({
        label: "Address verification lookups (fake: free, Lob would charge)",
        cents: 0,
        quantity: spec.verifications,
        basis: "documented_estimate",
        note: "Fake provider never charges verification; surfaced for estimate parity.",
      });
    }
    return lines;
  }

  async sendPiece(piece: SendPieceInput, _opts: { testMode: boolean }): Promise<SendPieceResult> {
    FakeMailProvider.counter += 1;
    const id = fakePieceId(`${Date.now()}:${FakeMailProvider.counter}:${piece.qrSlug}`);
    // eslint-disable-next-line no-console
    console.log(
      `[mail:fake:send] to=${piece.address.name} ${piece.address.city}, ${piece.address.state} ` +
        `slug=${piece.qrSlug} id=${id} (render-only, nothing mailed)`,
    );
    return { providerPieceId: id, renderedOnly: true };
  }

  async cancelPiece(_providerPieceId: string): Promise<void> {
    // Fake pieces are never really scheduled; cancel is a no-op.
  }

  validateWebhookSignature(opts: {
    rawBody: string;
    signature: string | null;
    env?: NodeJS.ProcessEnv;
  }): boolean {
    if (!opts.signature) return false;
    const secret = fakeMailSecret(opts.env ?? process.env);
    // Path 1: Authorization: Bearer <FAKE_MAIL_SECRET>.
    const bearer = `Bearer ${secret}`;
    if (safeEqual(opts.signature, bearer)) return true;
    // Path 2: X-Fake-Signature HMAC (mirrors lib/messaging/provider.ts).
    const expected = createHmac("sha256", secret).update(opts.rawBody, "utf8").digest("hex");
    return safeEqual(opts.signature, expected);
  }

  async parseWebhook(payload: unknown): Promise<MailEvent[]> {
    // The fake webhook payloads produced by the simulation helpers below
    // are already normalized MailEvent arrays. parseWebhook accepts either
    // shape (object with events[] or a single event). Each event gets its
    // `raw` attached (defaulting to the event itself) so the ingest ledger
    // always has a payload to store.
    const withRaw = (e: MailEvent): MailEvent => ({
      ...e,
      raw: (e as { raw?: unknown }).raw ?? e,
    });
    if (Array.isArray(payload)) return (payload as MailEvent[]).map(withRaw);
    const p = payload as { events?: MailEvent[] } | null;
    if (p?.events && Array.isArray(p.events)) return p.events.map(withRaw);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Webhook simulation helpers (tests + dev).
// ---------------------------------------------------------------------------

export interface SimulatedEvent {
  eventId: string;
  type: MailEvent["type"];
  providerPieceId: string;
  occurredAt: string;
}

/** in_transit → delivered, 3 days apart. Deterministic per piece. */
export function simulateTrackingSequence(
  providerPieceId: string,
  seed = "seq",
): SimulatedEvent[] {
  const base = createHash("sha256").update(`track:${seed}:${providerPieceId}`).digest("hex").slice(0, 12);
  const t0 = Date.parse("2026-09-20T12:00:00Z");
  return [
    {
      eventId: `fake_evt_${base}_transit`,
      type: "in_transit",
      providerPieceId,
      occurredAt: new Date(t0).toISOString(),
    },
    {
      eventId: `fake_evt_${base}_delivered`,
      type: "delivered",
      providerPieceId,
      occurredAt: new Date(t0 + 3 * 86_400_000).toISOString(),
    },
  ];
}

/** returned_to_sender single event. */
export function simulateReturn(providerPieceId: string, seed = "ret"): SimulatedEvent[] {
  const base = createHash("sha256").update(`ret:${seed}:${providerPieceId}`).digest("hex").slice(0, 12);
  return [
    {
      eventId: `fake_evt_${base}_returned`,
      type: "returned",
      providerPieceId,
      occurredAt: new Date(Date.parse("2026-09-22T12:00:00Z")).toISOString(),
    },
  ];
}

/** Sign a fake webhook body the same way the route expects it. */
export function signFakeMailWebhook(rawBody: string, secret = "fake-mail-dev-secret"): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}
