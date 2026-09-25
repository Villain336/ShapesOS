// Marketr — Phase 6 O1: Smartlead / Instantly webhook handler.
//
// Signature-verified (HMAC-SHA256 of the raw body against the provider
// webhook secret), idempotent (provider event ids deduped in-process and
// recorded on the event), and stop-on-reply enforced: a reply halts the
// sequence, marks the prospect replied, and suppresses reply-based —
// in the same processing cycle.

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

// In-process idempotency set (batteries + single-instance dev). Production
// multi-instance would back this with a DB unique constraint on the provider
// event id; every event also records providerEventId in its detail.
const seenEventIds = new Set<string>();

export interface WebhookDeps {
  sequences: SequenceStore;
  prospects: ProspectStore;
  campaigns: CampaignStore;
  suppression: SuppressionStore;
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.rawBody);
  } catch {
    throw new Error("Invalid webhook JSON.");
  }
  const payload = webhookPayloadSchema.parse(parsed);
  const dedupeKey = `${opts.provider}:${payload.eventId}`;
  if (seenEventIds.has(dedupeKey)) {
    return { provider: opts.provider, eventId: payload.eventId, type: payload.type, handled: true, duplicate: true };
  }

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

  seenEventIds.add(dedupeKey);
  await authorityAudit.logAsync({
    workspaceId: opts.workspaceId, actor: `webhook:${opts.provider}`, action: `webhook_${payload.type}`,
    entityType: "outreach_sequence", entityId: payload.sequenceId ?? payload.eventId, detail,
  });

  return { provider: opts.provider, eventId: payload.eventId, type: payload.type, handled, duplicate: false };
}

/** Test seam: clear the in-process idempotency set. */
export function __clearWebhookIdempotency(): void {
  seenEventIds.clear();
}
