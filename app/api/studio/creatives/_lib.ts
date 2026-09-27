// Marketr — studio creatives API shared helpers (Phase 4, T2).
// Every route: guardWorkspace + workspace-scoped queries.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { CreativeHttpError } from "@/lib/studio/creatives";

export { guardWorkspace, httpErrorResponse, readJson };

export function creativeErrorResponse(e: unknown) {
  if (e instanceof CreativeHttpError) {
    return Response.json({ error: e.message }, { status: e.status });
  }
  return httpErrorResponse(e);
}
