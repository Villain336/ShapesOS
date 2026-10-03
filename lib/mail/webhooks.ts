// Marketr — Phase 4 T1: webhook ingestion (Lob + PostGrid).
//
// Public routes (app/api/webhooks/mail/*) call ingestMailWebhook(). Flow:
//   1. Find candidate provider rows (provider name match); the first row
//      whose webhook secret validates the signature wins. No secret
//      validates → 401. Fail closed.
//   2. Insert MailWebhookEvent — the UNIQUE(provider, eventId) constraint is
//      the idempotency backstop; P2002 = duplicate delivery, collapsed.
//   3. provider.parseWebhook(payload) → normalized MailEvents.
//   4. For each event: advance the MailPiece status (rank-guarded so
//      out-of-order events never downgrade; terminal states stick),
//      set delivered_at on first "delivered", and record an AttributionTouch
//      (channel "direct_mail") when the piece has a leadId.
//   5. Mark the event processed.
//
// Duplicate + out-of-order deliveries collapse to ONE ledger entry each:
// one MailWebhookEvent row per provider event id, one touch per
// (lead, channel, campaign, hour) via logTouch's dedup hash.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { secrets } from "@/lib/secrets";
import { logTouch } from "@/lib/attribution/touches";
import { FakeMailProvider, fakeMailSecret, signFakeMailWebhook } from "./fake";
import { LobProvider } from "./lob";
import { PostGridProvider, decodeJwtClaimsUnsafe } from "./postgrid";
import type { MailEvent, MailEventType, MailProviderName } from "./provider";
import { fakeProvidersAllowed } from "@/lib/env/secrets";

// Piece status rank: only advance, never downgrade. Terminal states stick.
const STATUS_RANK: Record<string, number> = {
  queued: 0,
  suppressed: 0,
  sent: 1,
  in_transit: 2,
  in_local_area: 3,
  processed_for_delivery: 4,
  delivered: 90,
  returned: 91,
  failed: 92,
};

const TERMINAL = new Set(["delivered", "returned", "failed"]);

export function statusRank(status: string): number {
  return STATUS_RANK[status] ?? -1;
}

export interface IngestInput {
  providerName: MailProviderName;
  rawBody: string;
  signature: string | null;
  timestamp?: string | null;
  /** PostGrid JWT may arrive in the body instead of a header. */
  tokenFromBody?: string | null;
  env?: NodeJS.ProcessEnv;
}

export interface IngestResult {
  accepted: boolean;
  duplicate?: boolean;
  workspaceId?: string;
  eventsApplied?: number;
  touchesLogged?: number;
  reason?: string;
}

/**
 * Validate the signature against configured provider rows and ingest.
 * Returns accepted=false when no row validates (caller → 401).
 */
export async function ingestMailWebhook(input: IngestInput): Promise<IngestResult> {
  const { providerName } = input;
  const env = input.env ?? process.env;

  // The fake webhook transport is a shared-secret test path: refused in
  // production unless the operator opted into fake providers.
  if (providerName === "fake" && !fakeProvidersAllowed(env)) {
    return { accepted: false, reason: "fake provider disabled in production" };
  }

  // Candidate rows for this provider with a webhook secret configured.
  const rows = await prisma.mailProvider.findMany({
    where: { provider: providerName, webhookSecretEnc: { not: null } },
    select: { id: true, workspaceId: true, provider: true, webhookSecretEnc: true, mode: true, testKeyEnc: true, liveKeyEnc: true },
  });

  let workspaceId: string | null = null;
  let webhookSecret: string | null = null;

  // Fake provider path (tests/dev): shared env secret, no DB row needed.
  if (providerName === "fake") {
    const fake = new FakeMailProvider();
    if (!fake.validateWebhookSignature({ rawBody: input.rawBody, signature: input.signature, env })) {
      return { accepted: false, reason: "invalid signature" };
    }
    // Fake events are test-scoped; the caller passes workspaceId explicitly.
    workspaceId = null;
    webhookSecret = fakeMailSecret(env);
  } else {
    for (const row of rows) {
      let secret: string;
      try {
        secret = secrets().decrypt(row.webhookSecretEnc!);
      } catch {
        continue;
      }
      const provider =
        providerName === "lob"
          ? new LobProvider("test_placeholder", { webhookSecret: secret })
          : new PostGridProvider("test_placeholder", { webhookSecret: secret });
      // NOTE: constructed with a placeholder key — never used for API calls
      // here, only for signature validation. The constructor throws on an
      // empty key, hence the non-empty placeholder. No network, no spend.
      const valid =
        providerName === "lob"
          ? (provider as LobProvider).validateWebhookSignature({
              rawBody: input.rawBody,
              signature: input.signature,
              timestamp: input.timestamp ?? null,
            })
          : (provider as PostGridProvider).validateWebhookSignature({
              rawBody: input.rawBody,
              signature: input.signature,
              tokenFromBody: input.tokenFromBody ?? null,
            });
      if (valid) {
        workspaceId = row.workspaceId;
        webhookSecret = secret;
        break;
      }
    }
    if (!workspaceId) return { accepted: false, reason: "invalid signature" };
  }

  // Parse the body. PostGrid JWT-in-body: the validated token's claims are
  // the event payload (exact PostGrid delivery shape UNVERIFIED).
  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return { accepted: false, reason: "invalid JSON" };
  }
  if (providerName === "postgrid" && input.tokenFromBody) {
    try {
      payload = decodeJwtClaimsUnsafe(input.tokenFromBody.trim());
    } catch {
      return { accepted: false, reason: "invalid JWT claims" };
    }
  }

  // Normalize events (fake provider: payload already carries events[]).
  let events: MailEvent[];
  if (providerName === "fake") {
    events = await new FakeMailProvider().parseWebhook(payload);
  } else if (providerName === "lob") {
    events = await new LobProvider("test_placeholder", { webhookSecret: webhookSecret ?? undefined }).parseWebhook(payload);
  } else {
    events = await new PostGridProvider("test_placeholder", { webhookSecret: webhookSecret ?? undefined }).parseWebhook(payload);
  }

  let eventsApplied = 0;
  let touchesLogged = 0;

  for (const event of events) {
    // Idempotency: one ledger row per provider event id. P2002 = duplicate
    // (or out-of-order redelivery) → collapse.
    try {
      await prisma.mailWebhookEvent.create({
        data: {
          workspaceId,
          provider: providerName,
          eventId: event.eventId,
          eventType: event.type,
          // Defensive: a provider-shaped event without `raw` must not crash
          // the ledger write (the fake provider's simulated events hit this).
          payload: (event.raw ?? {}) as unknown as Prisma.InputJsonValue,
          processedAt: null,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        continue;
      }
      throw e;
    }

    const applied = await applyMailEvent(providerName, workspaceId, event);
    if (applied.pieceUpdated) eventsApplied++;
    if (applied.touchLogged) touchesLogged++;

    await prisma.mailWebhookEvent.updateMany({
      where: { provider: providerName, eventId: event.eventId, processedAt: null },
      data: { processedAt: new Date() },
    });
  }

  return { accepted: true, workspaceId: workspaceId ?? undefined, eventsApplied, touchesLogged };
}

interface ApplyResult {
  pieceUpdated: boolean;
  touchLogged: boolean;
}

async function applyMailEvent(
  providerName: string,
  workspaceId: string | null,
  event: MailEvent,
): Promise<ApplyResult> {
  // Tenant scope: the piece must belong to the workspace whose webhook
  // secret validated. Fake events are test-scoped — resolve by piece id.
  const piece = await prisma.mailPiece.findFirst({
    where: {
      providerPieceId: event.providerPieceId,
      ...(workspaceId ? { campaign: { workspaceId } } : {}),
    },
    include: { campaign: { select: { id: true, workspaceId: true, name: true } } },
  });
  if (!piece) return { pieceUpdated: false, touchLogged: false };
  if (workspaceId && piece.campaign.workspaceId !== workspaceId) {
    return { pieceUpdated: false, touchLogged: false };
  }

  const out: ApplyResult = { pieceUpdated: false, touchLogged: false };
  const currentRank = statusRank(piece.status);
  const newRank = statusRank(event.type);
  const isTerminalNow = TERMINAL.has(piece.status);

  // Rank-guarded advance: out-of-order (older) events never downgrade.
  if (!isTerminalNow && newRank > currentRank) {
    const data: Record<string, unknown> = { status: event.type };
    if (event.type === "delivered" && !piece.deliveredAt) {
      data.deliveredAt = event.occurredAt;
    }
    await prisma.mailPiece.update({ where: { id: piece.id }, data });
    out.pieceUpdated = true;
  }

  // Attribution: a delivery/return event on a lead-linked piece logs a
  // direct_mail touch. logTouch's (leadId, dedupHash) unique constraint
  // collapses retries within the hour window.
  if (piece.leadId && (event.type === "delivered" || event.type === "returned")) {
    try {
      await logTouch({
        workspaceId: piece.campaign.workspaceId,
        leadId: piece.leadId,
        channel: "direct_mail",
        source: providerName,
        medium: "mail",
        campaign: piece.campaign.name,
        touchType: "visit",
        occurredAt: event.occurredAt,
        meta: { mailEvent: event.type, providerPieceId: event.providerPieceId, qrSlug: piece.qrSlug },
      });
      out.touchLogged = true;
    } catch {
      // Touch logging must never break webhook ingestion.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Test helper: sign a fake webhook body the way the route expects.
// Re-exported here so tests import from one place.
// ---------------------------------------------------------------------------

export { signFakeMailWebhook };
