// Marketr — integrations API shared helpers (Phase 12 sidecars).
// Every route: guardWorkspace (workspace-scoped) + honest error mapping.
// The sidecars are talked to over raw fetch only — never linked code.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { ListmonkApiError, ListmonkConfigError } from "@/lib/integrations/listmonk";
import { PostizApiError, PostizConfigError } from "@/lib/integrations/postiz";

export { guardWorkspace, httpErrorResponse, readJson };

/** Maps sidecar/lib errors to a clean JSON response. Never leaks key material. */
export function sidecarError(e: unknown) {
  if (e instanceof ListmonkConfigError || e instanceof PostizConfigError) {
    return Response.json({ error: e.message }, { status: 400 });
  }
  if (e instanceof ListmonkApiError || e instanceof PostizApiError) {
    return Response.json(
      { error: e.message },
      { status: e.status >= 500 ? 502 : e.status },
    );
  }
  return httpErrorResponse(e);
}
