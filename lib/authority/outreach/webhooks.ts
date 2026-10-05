// Marketr — Phase 6 O1: Smartlead / Instantly webhook handler.
//
// Signature-verified (HMAC-SHA256 of the raw body against the provider
// webhook secret), idempotent (provider event ids claimed in
// outreach_webhook_events — durable across instances/restarts — and
// recorded on the event), and stop-on-reply enforced: a reply halts the
// sequence, marks the prospect replied, and suppresses reply-based —
// in the same processing cycle.
//
// Tenant binding (Phase 1): the workspace comes ONLY from signed data — the
// referenced sequence's own workspace, or a workspaceId field inside the
// signed body. An unsigned ?workspaceId= query param is never trusted (the
// HMAC covers only the body, so a captured event could otherwise be
// replayed into another tenant).

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { authorityAudit } from "@/lib/authority/db";
import type { SequenceStore } from "./sequences";
import { stopSequenceOnReply, recordHardBounce } from "./sequences";
import { suppressEmail, type SuppressionStore } from "./suppression";
import type { ProspectStore } from "./prospects";
import type { CampaignStore } from "./campaigns";

export type WebhookProvider = "smartlead" | "instantly";

const webhookPayloadSchema = z.object({
  eventId: z.string().min(1),
  type: z.enum(["sent", "opened", "clicked", "replied", "bounced", "unsubscribed"]),
  sequenceId: z.string().optional(),
  email: z.string().email().optional(),
  replyId: z.string().optional(),
  /** Our workspace id, when the relay includes it — covered by the HMAC. */
  workspaceId: z.string().min(1).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;

function secretFor(provider: WebhookProvider): string | null {
  const key = provider === "smartlead" ? "SMARTLEAD_WEBHOOK_SECRET" : "INSTANTLY_WEBHOOK_SECRET";
  return process.env[key] ?? null;
}

/** Verify HMAC-SHA256 signature of the raw body. Throws when not configured or mismatched. */
export function verifyWebhookSignature(provider: WebhookProvider, rawBody: string, signature: string | null): void {
  const secret = secretFor(provider);
  if (!secret) {
    throw new Error(`${provider} webhook verification is not configured — set ${provider === "smartlead" ? "SMARTLEAD_WEBHOOK_SECRET" : "INSTANTLY_WEBHOOK_SECRET"} to receive provider events.`);
  }
  if (!signature) throw new Error("Missing webhook signature.");
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature.trim(), "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("Invalid webhook signature.");
  }
}

/**
 * Resolve the tenant from SIGNED payload data only: the referenced
 * sequence's own workspace, else the body's workspaceId. A body workspaceId
 * that disagrees with the sequence's workspace is rejected (null).
 */
export async function resolveWebhookWorkspace(
  payload: { sequenceId?: string; workspaceId?: string },
  sequenceWorkspace: (sequenceId: string) => Promise<string | null>,
): Promise<string | null> {
  const claimed = payload.workspaceId?.trim() || null;
  if (payload.sequenceId) {
    const owner = await sequenceWorkspace(payload.sequenceId);
    if (owner) return claimed && claimed !== owner ? null : owner;
  }
  return claimed;
}

/** Parse + validate a webhook body (after the signature was verified). */
export function parseWebhookPayload(rawBody: string): WebhookPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error("Invalid webhook JSON.");
  }
  return webhookPayloadSchema.parse(parsed);
}

/**
 * Durable idempotency port. claim() returns false when the (provider,
 * eventId) was already processed; release() undoes a claim when processing
 * failed so the provider's retry can succeed.
 */
export interface WebhookEventStore {
  claim(input: { provider: WebhookProvider; eventId: string; workspaceId: string; type: string }): Promise<boolean>;
  release(provider: WebhookProvider, eventId: string): Promise<void>;
}

/** In-memory store (unit tests / batteries). Production uses the Prisma store. */
export function memoryWebhookEventStore(seen: Set<string> = new Set<string>()): WebhookEventStore {
  return {
    async claim({ provider, eventId }) {
      const key = `${provider}:${eventId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
    async release(provider, eventId) {
      seen.delete(`${provider}:${eventId}`);
    },
  };
}

const defaultClaims = new Set<string>();
const defaultEventStore = memoryWebhookEventStore(defaultClaims);

export interface WebhookDeps {
  sequences: SequenceStore;
  prospects: ProspectStore;
  campaigns: CampaignStore;
  suppression: SuppressionStore;
  /** Durable dedupe (outreach_webhook_events). Defaults to in-memory. */
  events?: WebhookEventStore;
}

export interface WebhookResult {
  provider: WebhookProvider;
  eventId: string;
  type: string;
  handled: boolean;
  duplicate: boolean;
}

export async function handleProviderWebhook(
  deps: WebhookDeps,
  opts: { provider: WebhookProvider; rawBody: string; signature: string | null; workspaceId: string },
): Promise<WebhookResult> {
  verifyWebhookSignature(opts.provider, opts.rawBody, opts.signature);

  const payload = parseWebhookPayload(opts.rawBody);
  if (payload.workspaceId && payload.workspaceId !== opts.workspaceId) {
    throw new Error("Invalid input: webhook workspace does not match the signed payload.");
  }
  const events = deps.events ?? defaultEventStore;
  const claimed = await events.claim({
    provider: opts.provider, eventId: payload.eventId, workspaceId: opts.workspaceId, type: payload.type,
  });
  if (!claimed) {
    return { provider: opts.provider, eventId: payload.eventId, type: payload.type, handled: true, duplicate: true };
  }
  try {
    return await processWebhookEvent(deps, opts, payload);
  } catch (err) {
    // Let the provider's retry reprocess an event we failed to apply.
    await events.release(opts.provider, payload.eventId).catch(() => {});
    throw err;
  }
}

async function processWebhookEvent(
  deps: WebhookDeps,
  opts: { provider: WebhookProvider; workspaceId: string },
  payload: WebhookPayload,
): Promise<WebhookResult> {
  const detail = { providerEventId: payload.eventId, provider: opts.provider, ...(payload.detail ?? {}) };
  let handled = false;

  if (payload.sequenceId) {
    const seq = await deps.sequences.get(payload.sequenceId, opts.workspaceId);
    if (seq) {
      switch (payload.type) {
        case "replied": {
          // Stop-on-reply: halt + mark replied + suppress reply-based, same cycle.
          await stopSequenceOnReply(deps, {
            workspaceId: opts.workspaceId,
            sequenceId: seq.id,
            replyId: payload.replyId ?? payload.eventId,
            replyFromEmail: payload.email,
            actor: "system",
          });
          handled = true;
          break;
        }
        case "bounced": {
          if (payload.email) {
            await recordHardBounce(
              { sequences: deps.sequences, prospects: deps.prospects, suppression: deps.suppression, campaigns: deps.campaigns },
              { workspaceId: opts.workspaceId, sequenceId: seq.id, email: payload.email, detail },
            );
            handled = true;
          }
          break;
        }
        case "unsubscribed": {
          // Instant same-cycle enforcement: global suppression, sequence stopped.
          if (payload.email) {
            await suppressEmail(deps.suppression, {
              workspaceId: opts.workspaceId, email: payload.email, kind: "global", source: "unsubscribed",
            });
          }
          const steps = (Array.isArray(seq.stepsJson) ? seq.stepsJson : []) as Array<Record<string, unknown>>;
          await deps.sequences.update(seq.id, opts.workspaceId, {
            status: "stopped", stoppedAt: new Date(),
            stepsJson: steps.map((s) => (s.status === "pending" ? { ...s, status: "skipped" } : s)) as never,
          });
          await deps.sequences.recordEvent(seq.id, opts.workspaceId, "unsubscribed", detail);
          handled = true;
          break;
        }
        case "opened":
        case "clicked":
        case "sent": {
          await deps.sequences.recordEvent(seq.id, opts.workspaceId, payload.type, detail);
          handled = true;
          break;
        }
      }
    }
  }

  if (!payload.sequenceId && payload.email && (payload.type === "unsubscribed" || payload.type === "bounced")) {
    // Provider-level event without a sequence: still suppress instantly.
    await suppressEmail(deps.suppression, {
      workspaceId: opts.workspaceId, email: payload.email, kind: "global", source: payload.type,
    });
    handled = true;
  }

  await authorityAudit.logAsync({
    workspaceId: opts.workspaceId, actor: `webhook:${opts.provider}`, action: `webhook_${payload.type}`,
    entityType: "outreach_sequence", entityId: payload.sequenceId ?? payload.eventId, detail,
  });

  return { provider: opts.provider, eventId: payload.eventId, type: payload.type, handled, duplicate: false };
}

/** Test seam: forget the default in-memory claims (the Prisma store is durable). */
export function __clearWebhookIdempotency(): void {
  for (const key of [...defaultClaims]) defaultClaims.delete(key);
}
