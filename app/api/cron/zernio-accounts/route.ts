// ShapesOS — Phase 15.4 (zernio): monthly Zernio account metering.
// POST /api/cron/zernio-accounts
//
// Auth (either), same pattern as the other /api/cron/* routes (lib/cron/gate.ts):
//   1. Cron: Authorization: Bearer <CRON_SECRET> — every workspace with a
//      Zernio profile. Schedule monthly (see DEPLOY.md): 30 2 1 * *
//   2. Signed-in session (editor+) — the user's workspace only (pooling still
//      sees the owner's whole agency group).
//
// Counts each workspace's connected Zernio accounts (live, on its own
// profile), charges zernio_account_month beyond the plan's included accounts
// plus Zernio's managed-ad overage at cost × margin (lib/zernio/metering.ts).
// Idempotent per workspace + month. Only runs on the LIVE key: on the
// labelled fake (no ZERNIO_API_KEY) it reports skipped and charges nothing.

import type { NextRequest } from "next/server";
import { cronGate } from "@/lib/cron/gate";
import { getZernioClient, zernioMode } from "@/lib/zernio/config";
import { runZernioAccountMetering } from "@/lib/zernio/metering";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  if (zernioMode() !== "live") {
    return Response.json({ ok: true, skipped: "ZERNIO_API_KEY is not set — nothing is metered on the mock Zernio." });
  }
  const out = await runZernioAccountMetering({
    client: getZernioClient(),
    workspaceIds: gate.isCron ? null : [gate.workspaceId!],
  });
  return Response.json({ ok: true, ...out });
}
