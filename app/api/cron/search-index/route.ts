// ShapesOS — Phase 18.1 (WS=find): keep Spotlight's text index complete.
// POST /api/cron/search-index
//
// Auth: the shared cron gate (lib/cron/gate.ts) — Authorization: Bearer
// <CRON_SECRET> runs every workspace; a signed-in editor+ runs their own.
// Indexes the text of files and Office docs the write hook missed (or that
// changed) and embeds chunks that have no embedding yet (the write hook only
// embeds when the model is already loaded). Idempotent: unchanged records
// are skipped by content hash. Batch-capped per run (SEARCH_INDEX_BATCH).

import type { NextRequest } from "next/server";
import { cronGate } from "@/lib/cron/gate";
import { backfillTextIndex } from "@/lib/search/text-index";

export const dynamic = "force-dynamic";

const DEFAULT_BATCH = 200;

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const batch = Math.min(Math.max(Number(process.env.SEARCH_INDEX_BATCH) || DEFAULT_BATCH, 1), 5_000);
  const summary = await backfillTextIndex({
    workspaceId: gate.isCron ? undefined : gate.workspaceId!,
    embed: true,
    limit: batch,
  });
  return Response.json({ ok: true, ...summary });
}
