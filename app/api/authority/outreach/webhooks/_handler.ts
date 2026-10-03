// Marketr — O1 provider webhook ingress (not a route: no HTTP exports).
//
// Smartlead/Instantly event pipeline: signature-verified (HMAC-SHA256),
// idempotent (provider event id dedupe), stop-on-reply enforced, bounce ->
// circuit-breaker quarantine, unsubscribe -> instant global suppression.
// No session guard — webhooks authenticate by signature.
//
// Order: verify the HMAC first, then resolve the tenant from SIGNED data
// only — the referenced sequence's own workspace (global id lookup), or a
// workspaceId field inside the signed body for provider-level events without
// a sequence (e.g. a bare unsubscribe). The ?workspaceId= query param is NOT
// covered by the signature and is ignored (Phase 1: a captured event could
// otherwise be replayed into another tenant). Without a signed workspace the
// event is rejected with 422 rather than guessing a tenant. Idempotency is
// durable (outreach_webhook_events).

import { authorityTablesReady } from "@/lib/authority/db";
import {
  handleProviderWebhook,
  parseWebhookPayload,
  prismaWebhookEventStore,
  resolveWebhookWorkspace,
  verifyWebhookSignature,
  type WebhookProvider,
} from "@/lib/authority/outreach";
import { outreachStores } from "@/app/api/authority/outreach/_stores";
import { prisma } from "@/lib/prisma";

function mapWebhookError(err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err);
  if (/not configured/i.test(message)) {
    return Response.json({ error: message }, { status: 503 });
  }
  if (/missing webhook signature|invalid webhook signature/i.test(message)) {
    return Response.json({ error: message }, { status: 401 });
  }
  if (/invalid webhook json|invalid input|invalid/i.test(message)) {
    return Response.json({ error: message }, { status: 400 });
  }
  return Response.json({ error: message }, { status: 422 });
}

/** Global id lookup -> the sequence's own workspace (tenant never guessed). */
async function sequenceWorkspace(sequenceId: string): Promise<string | null> {
  const seq = await prisma.outreachSequence.findUnique({
    where: { id: sequenceId },
    select: { workspaceId: true },
  });
  return seq?.workspaceId ?? null;
}

export async function handleProviderEvent(req: Request, provider: WebhookProvider): Promise<Response> {
  if (!(await authorityTablesReady().catch(() => false))) {
    return Response.json({ error: "Authority tables not provisioned." }, { status: 503 });
  }
  const rawBody = await req.text();
  const signature = req.headers.get("x-marketr-signature") ?? req.headers.get("x-webhook-signature");

  let workspaceId: string | null;
  try {
    verifyWebhookSignature(provider, rawBody, signature);
    workspaceId = await resolveWebhookWorkspace(parseWebhookPayload(rawBody), sequenceWorkspace);
  } catch (err) {
    return mapWebhookError(err);
  }
  if (!workspaceId) {
    return Response.json(
      { error: "Cannot resolve workspace: the signed payload has no known sequenceId or workspaceId." },
      { status: 422 },
    );
  }

  const stores = outreachStores();
  try {
    const result = await handleProviderWebhook(
      {
        sequences: stores.sequences,
        prospects: stores.prospects,
        campaigns: stores.campaigns,
        suppression: stores.suppression,
        events: prismaWebhookEventStore(),
      },
      { provider, rawBody, signature, workspaceId },
    );
    return Response.json(result);
  } catch (err) {
    return mapWebhookError(err);
  }
}
