// Marketr — O1 provider webhook ingress (not a route: no HTTP exports).
//
// Smartlead/Instantly event pipeline: signature-verified (HMAC-SHA256),
// idempotent (provider event id dedupe), stop-on-reply enforced, bounce ->
// circuit-breaker quarantine, unsubscribe -> instant global suppression.
// No session guard — webhooks authenticate by signature.
//
// Workspace resolution: provider payloads don't carry our workspace id, so
// the workspace is resolved from the referenced sequence (global id lookup).
// Provider-level events without a sequence id (e.g. a bare unsubscribe)
// fall back to the ?workspaceId= query param; without either, the event is
// rejected with 422 rather than guessing a tenant.

import { authorityTablesReady } from "@/lib/authority/db";
import { handleProviderWebhook, type WebhookProvider } from "@/lib/authority/outreach";
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

async function resolveWorkspaceId(req: Request, rawBody: string): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const sequenceId =
    parsed && typeof parsed === "object" && "sequenceId" in parsed
      ? String((parsed as { sequenceId?: unknown }).sequenceId ?? "")
      : "";
  if (sequenceId) {
    // Global id lookup -> the sequence's own workspace (tenant never guessed).
    const seq = await prisma.outreachSequence.findUnique({
      where: { id: sequenceId },
      select: { workspaceId: true },
    });
    if (seq) return seq.workspaceId;
  }
  const qp = new URL(req.url).searchParams.get("workspaceId");
  return qp && qp.trim() ? qp.trim() : null;
}

export async function handleProviderEvent(req: Request, provider: WebhookProvider): Promise<Response> {
  if (!(await authorityTablesReady().catch(() => false))) {
    return Response.json({ error: "Authority tables not provisioned." }, { status: 503 });
  }
  const rawBody = await req.text();
  const signature = req.headers.get("x-marketr-signature") ?? req.headers.get("x-webhook-signature");

  const workspaceId = await resolveWorkspaceId(req, rawBody);
  if (!workspaceId) {
    return Response.json(
      { error: "Cannot resolve workspace: payload has no sequenceId and no ?workspaceId= was provided." },
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
      },
      { provider, rawBody, signature, workspaceId },
    );
    return Response.json(result);
  } catch (err) {
    return mapWebhookError(err);
  }
}
