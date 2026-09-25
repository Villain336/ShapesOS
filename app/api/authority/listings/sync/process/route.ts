// Marketr — POST /api/authority/listings/sync/process (editor)
//
// Trigger one pass of the sync executor: due queued listing_sync_jobs run in
// cap order. Every job re-verifies its listing_edit binding at execution;
// binding mismatches HALT the job — the payload never reaches the provider.
// (v1 uses the fake GBP client; the real adapter throws NotConfiguredError
// without credentials — it never silently pretends to work.)

import type { NextRequest } from "next/server";
import { authorityGuard, safetyError } from "@/app/api/authority/_lib";
import { authorityTablesReady } from "@/lib/authority/db";
import { createPrismaListingStore } from "@/lib/authority/listings/store";
import { processDueSyncJobs } from "@/lib/authority/listings/sync";
import { resolveGbpClient } from "@/lib/authority/fake";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json({ error: "Authority tables not provisioned yet." }, { status: 503 });
  }
  try {
    const store = createPrismaListingStore();
    const client = resolveGbpClient({ fake: true });
    const result = await processDueSyncJobs(gate.workspaceId, { store, client });
    return Response.json({ ...result, provider: client.name });
  } catch (err) {
    return safetyError(err);
  }
}
