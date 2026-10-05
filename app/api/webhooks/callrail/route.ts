// Marketr — POST /api/webhooks/callrail (PUBLIC, no session).
//
// CallRail call events → attribution ledger. Signature-verified, idempotent
// (CallWebhookEvent unique(provider, eventId) — redeliveries collapse),
// rank-guarded so out-of-order events never downgrade call state.
// Mirrors app/api/webhooks/mail/*: invalid signatures → 401; internal
// failures → 200 (avoid retry storms).
//
// Workspace resolution: the webhook URL carries ?w=<workspaceId>. It is not
// trusted on its own — the real provider verifies the signature with that
// workspace's own derived secret (lib/media/callrail.ts
// callRailWorkspaceWebhookSecret), so editing ?w= can't move an event into
// another tenant. The fake provider is dev/test-scoped (refused in
// production unless ALLOW_FAKE_PROVIDERS=1).

import type { NextRequest } from "next/server";
import { getMediaStore } from "@/lib/media/store";
import {
  createCallRailService,
  FakeCallRailProvider,
  RealCallRailProvider,
} from "@/lib/media/callrail";
import { fakeProvidersAllowed } from "@/lib/env/secrets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature =
    req.headers.get("x-callrail-signature") ?? req.headers.get("authorization");
  const workspaceId = req.nextUrl.searchParams.get("w");

  const providerName = (process.env.CALLRAIL_PROVIDER ?? "fake").toLowerCase();
  if (providerName !== "callrail" && !fakeProvidersAllowed()) {
    return Response.json({ error: "CallRail provider not configured" }, { status: 503 });
  }
  const provider =
    providerName === "callrail"
      ? new RealCallRailProvider({
          apiKey: process.env.CALLRAIL_API_KEY,
          webhookSecret: process.env.CALLRAIL_WEBHOOK_SECRET,
          live: false, // test-mode-first: live enabling is explicit, never by env accident
          acceptSharedSecret: process.env.CALLRAIL_WEBHOOK_ACCEPT_SHARED_SECRET === "1",
        })
      : new FakeCallRailProvider();
  if (provider.name === "callrail" && !workspaceId) {
    return Response.json({ error: "missing workspace (?w=)" }, { status: 400 });
  }
  const service = createCallRailService(getMediaStore(), provider);

  try {
    const result = await service.ingestWebhook({
      rawBody,
      signature,
      workspaceId: workspaceId ?? "unscoped",
    });
    if (!result.accepted) {
      return Response.json({ error: result.reason ?? "rejected" }, { status: 401 });
    }
    return Response.json({
      ok: true,
      eventsApplied: result.eventsApplied,
      duplicate: result.duplicate,
    });
  } catch (e) {
    // Always 200 to the provider on internal failure; log and move on.
    // eslint-disable-next-line no-console
    console.error(`[callrail:webhook] ingest failed: ${e instanceof Error ? e.message : "unknown"}`);
    return Response.json({ ok: false }, { status: 200 });
  }
}
