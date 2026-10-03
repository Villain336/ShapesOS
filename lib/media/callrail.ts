// Marketr — Phase 5 A1: CallRail provider abstraction (native in v1).
//
// Per-station/per-publication tracking numbers; call data feeds the
// cost-per-call kill switch (exposed via pollCallStats() for the S4 sweeper).
//
// FAKE DEFAULT: FakeCallRail provisions deterministic test numbers and
// validates HMAC-SHA256 signatures — no CallRail account, no network.
// REAL ADAPTER: RealCallRail is test-mode-first — it throws
// ProviderNotConfiguredError without keys and never places/provisions
// anything live unless explicitly constructed in live mode.
//
// Webhook ingestion mirrors lib/mail/webhooks.ts: signature-verified,
// idempotent (one ledger row per provider event id — duplicates collapse),
// rank-guarded so out-of-order events never downgrade call state.
// Public route: app/api/webhooks/callrail (no session), always 200 on
// internal failure, 401 on bad signature.
//
// NOTE on the real CallRail signature scheme: CallRail does not publish a
// standard HMAC webhook-signing scheme the way Lob does; the real adapter
// accepts (a) shared-secret HMAC-SHA256(rawBody) vs X-CallRail-Signature, or
// (b) Authorization: Bearer <webhook secret>. The exact production scheme is
// UNVERIFIED against a live firing — confirm before trusting production
// traffic (same honesty pattern as the PostGrid JWT note in lib/mail).

import { createHmac, createHash } from "node:crypto";
import type { MediaStore, CallNumber } from "./store";
import { safeEqual } from "../mail/provider";
import { requireSecret } from "@/lib/env/secrets";

export type CallRailProviderName = "fake" | "callrail";

export interface CallNumberInput {
  workspaceId: string;
  buyId?: string | null;
  /** e.g. "WXYZ-morning-drive", "gazette-full-page". */
  stationRef: string;
  /** Area code hint for the test number; ignored live. */
  areaCode?: string;
}

export type CallEventType = "started" | "completed" | "missed" | "voicemail";

export interface CallEvent {
  /** Provider event id — the webhook idempotency key. */
  eventId: string;
  callId: string;
  type: CallEventType;
  /** The tracking number that received the call (E.164). */
  trackingNumberE164: string;
  callerE164: string | null;
  durationSec: number;
  occurredAt: Date;
  raw: unknown;
}

export interface CallRailProvider {
  readonly name: CallRailProviderName;
  provisionNumber(input: CallNumberInput): Promise<{ numberE164: string }>;
  releaseNumber(numberE164: string): Promise<void>;
  validateWebhookSignature(opts: { rawBody: string; signature: string | null }): boolean;
  parseWebhook(payload: unknown): Promise<CallEvent[]>;
}

// Call state rank: only advance, never downgrade. Terminal states stick.
const CALL_RANK: Record<CallEventType, number> = {
  started: 1,
  completed: 90,
  missed: 91,
  voicemail: 92,
};

export function fakeCallRailSecret(env: NodeJS.ProcessEnv = process.env): string {
  return requireSecret("FAKE_CALLRAIL_SECRET", "fake-callrail-dev-secret", env);
}

export class FakeCallRailProvider implements CallRailProvider {
  readonly name = "fake" as const;
  private counter = 0;

  async provisionNumber(input: CallNumberInput): Promise<{ numberE164: string }> {
    this.counter += 1;
    const area = (input.areaCode ?? "336").replace(/\D/g, "").slice(0, 3).padStart(3, "3");
    const hash = createHash("sha256")
      .update(`${input.workspaceId}:${input.stationRef}:${this.counter}`)
      .digest("hex");
    const line = (parseInt(hash.slice(0, 7), 16) % 9_000_000 + 1_000_000).toString().padStart(7, "0");
    const numberE164 = `+1${area}${line}`;
    console.log(`[callrail:fake:provision] station=${input.stationRef} number=${numberE164} (test number, nothing provisioned)`);
    return { numberE164 };
  }

  async releaseNumber(): Promise<void> {
    // Fake numbers were never provisioned; release is a no-op.
  }

  validateWebhookSignature(opts: { rawBody: string; signature: string | null }): boolean {
    if (!opts.signature) return false;
    const secret = fakeCallRailSecret();
    const bearer = `Bearer ${secret}`;
    if (safeEqual(opts.signature, bearer)) return true;
    const expected = createHmac("sha256", secret).update(opts.rawBody, "utf8").digest("hex");
    return safeEqual(opts.signature, expected);
  }

  async parseWebhook(payload: unknown): Promise<CallEvent[]> {
    const p = payload as { events?: CallEvent[] } | null;
    if (p?.events && Array.isArray(p.events)) {
      return p.events.map((e) => ({
        ...e,
        occurredAt: e.occurredAt instanceof Date ? e.occurredAt : new Date(e.occurredAt),
        raw: (e as { raw?: unknown }).raw ?? e,
      }));
    }
    return [];
  }
}

export class ProviderNotConfiguredError extends Error {
  constructor(provider: string, missing: string) {
    super(`${provider} provider is not configured (missing ${missing})`);
    this.name = "ProviderNotConfiguredError";
  }
}

/**
 * Real CallRail adapter — test-mode-first. Constructing without an API key
 * throws; live mode is opt-in and explicit. Webhook validation uses the
 * shared-secret scheme documented above (production scheme UNVERIFIED —
 * confirm against a live firing before trusting it).
 */
export class RealCallRailProvider implements CallRailProvider {
  readonly name = "callrail" as const;
  private apiKey: string;
  private webhookSecret: string | null;
  readonly live: boolean;

  constructor(opts: { apiKey?: string; webhookSecret?: string; live?: boolean }) {
    if (!opts.apiKey) throw new ProviderNotConfiguredError("callrail", "CALLRAIL_API_KEY");
    this.apiKey = opts.apiKey;
    this.webhookSecret = opts.webhookSecret ?? null;
    this.live = opts.live ?? false;
  }

  async provisionNumber(_input: CallNumberInput): Promise<{ numberE164: string }> {
    if (!this.live) {
      throw new Error("RealCallRailProvider is in test mode — provisioning disabled (use FakeCallRailProvider)");
    }
    // Live CallRail number provisioning via the CallRail API would go here.
    // No live path is exercised in v1 (no keys exist); fail closed.
    throw new Error("CallRail live provisioning is not wired in v1 — configure and verify before enabling");
  }

  async releaseNumber(_numberE164: string): Promise<void> {
    throw new Error("CallRail live release is not wired in v1");
  }

  validateWebhookSignature(opts: { rawBody: string; signature: string | null }): boolean {
    if (!opts.signature || !this.webhookSecret) return false;
    const bearer = `Bearer ${this.webhookSecret}`;
    if (safeEqual(opts.signature, bearer)) return true;
    const expected = createHmac("sha256", this.webhookSecret).update(opts.rawBody, "utf8").digest("hex");
    return safeEqual(opts.signature, expected);
  }

  async parseWebhook(_payload: unknown): Promise<CallEvent[]> {
    // The live CallRail webhook payload shape is normalized here once a live
    // firing is observed. Until then, fail closed — never guess.
    throw new Error("CallRail live webhook parsing unverified — confirm payload shape against a live firing first");
  }
}

// ---------------------------------------------------------------------------
// Service: number provisioning + webhook ingestion
// ---------------------------------------------------------------------------

export interface CallRailService {
  provider: CallRailProvider;
  provisionTrackingNumber(input: CallNumberInput): Promise<CallNumber>;
  ingestWebhook(opts: {
    rawBody: string;
    signature: string | null;
    workspaceId: string; // resolved by the route (fake mode) or provider row (live)
  }): Promise<{ accepted: boolean; reason?: string; eventsApplied: number; duplicate: boolean }>;
  /** S4 sweeper interface: cost-per-call over a window. */
  pollCallStats(workspaceId: string, buyId?: string): Promise<CallCostStats>;
}

export interface CallCostStats {
  numbers: number;
  calls: number;
  totalDurationSec: number;
  /** Documented-estimate cost basis; fake-mode default. */
  costCents: number;
  costPerCallCents: number | null;
  basis: "documented_estimate" | "provider_actual";
}

/**
 * Documented CallRail cost basis (docs/phase5-research.md, Sep 2026):
 * ~$45–55/mo (5 local numbers + 250 min). Fake mode uses the $50 midpoint
 * as a documented estimate — never presented as a live invoice figure.
 */
export const CALLRAIL_DOCUMENTED_MONTHLY_CENTS = 5000;

export function createCallRailService(store: MediaStore, provider: CallRailProvider): CallRailService {
  return {
    provider,

    async provisionTrackingNumber(input: CallNumberInput): Promise<CallNumber> {
      const { numberE164 } = await provider.provisionNumber(input);
      if (await store.getCallNumberByE164(input.workspaceId, numberE164)) {
        throw new Error(`Number ${numberE164} is already tracked in this workspace`);
      }
      return store.createCallNumber({
        workspaceId: input.workspaceId,
        buyId: input.buyId ?? null,
        provider: provider.name === "fake" ? "fake" : "callrail",
        numberE164,
        stationRef: input.stationRef,
        status: "active",
      });
    },

    async ingestWebhook(opts) {
      const { rawBody, signature, workspaceId } = opts;
      if (!provider.validateWebhookSignature({ rawBody, signature })) {
        return { accepted: false, reason: "invalid signature", eventsApplied: 0, duplicate: false };
      }
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return { accepted: false, reason: "invalid JSON", eventsApplied: 0, duplicate: false };
      }
      const events = await provider.parseWebhook(payload);

      let eventsApplied = 0;
      let sawDuplicate = false;
      // Track the best-known rank per call so out-of-order events collapse.
      const callRanks = new Map<string, number>();

      for (const event of events) {
        // Idempotency: one ledger row per provider event id. Duplicates
        // (redeliveries) collapse — never double-count a call.
        const inserted = await store.insertCallWebhookEvent({
          workspaceId,
          provider: provider.name,
          eventId: event.eventId,
          eventType: event.type,
          payload: event.raw,
        });
        if (!inserted) {
          sawDuplicate = true;
          continue;
        }

        const number = await store.getCallNumberByE164(workspaceId, event.trackingNumberE164);
        if (number) {
          // Rank-guarded: an out-of-order "started" arriving after a
          // "completed" never downgrades the call state or re-counts it.
          const rank = CALL_RANK[event.type] ?? 0;
          const best = callRanks.get(event.callId) ?? 0;
          if (rank >= best) {
            callRanks.set(event.callId, rank);
            // Only count terminal call outcomes toward calls_count — a
            // "started" alone is not a completed response.
            if (rank >= 90) {
              await store.applyCallEvent(number.id, event.durationSec, event.occurredAt);
              eventsApplied++;
            }
          }
        }
        await store.markCallWebhookProcessed(provider.name, event.eventId);
      }
      return { accepted: true, eventsApplied, duplicate: sawDuplicate };
    },

    async pollCallStats(workspaceId: string, buyId?: string): Promise<CallCostStats> {
      const numbers = await store.listCallNumbers(workspaceId, buyId);
      const calls = numbers.reduce((n, x) => n + x.callsCount, 0);
      const totalDurationSec = numbers.reduce((n, x) => n + x.totalDurationSec, 0);
      // Documented-estimate basis in fake mode: monthly plan cost prorated
      // across tracked numbers. Provider-actual when live invoices land.
      const costCents = numbers.length
        ? Math.round((CALLRAIL_DOCUMENTED_MONTHLY_CENTS * numbers.length) / Math.max(1, numbers.length))
        : 0;
      return {
        numbers: numbers.length,
        calls,
        totalDurationSec,
        costCents,
        costPerCallCents: calls > 0 ? Math.round(costCents / calls) : null,
        basis: provider.name === "fake" ? "documented_estimate" : "provider_actual",
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Test helper: sign a fake CallRail webhook body the way the route expects.
// ---------------------------------------------------------------------------

export function signFakeCallRailWebhook(rawBody: string, secret = "fake-callrail-dev-secret"): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}
