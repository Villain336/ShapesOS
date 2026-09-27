// Marketr — studio Brandfetch brand-lookup API (Phase 11 "Canvas").
// POST /api/studio/brandfetch/lookup { domain } — server-side proxy to the
// Brandfetch Brand API v2. The API key (BRANDFETCH_API_KEY) stays on the
// server; the browser only sees the trimmed brand shape. No key → honest 400,
// never fake brand data. Brandfetch 404 → honest 404; 429 passes through as
// a 429. Lookups are metered per tenant (0-credit ledger event; the vendor
// bills the user's own Brandfetch key directly).

import { guardWorkspace, httpErrorResponse, readJson } from "../../designs/_lib";
import {
  BrandfetchApiError,
  BrandfetchNotConfiguredError,
  BrandfetchNotFoundError,
  DomainInputError,
  getBrandfetchApiKey,
  lookupBrandForKit,
  normalizeDomain,
} from "@/lib/design/brandfetch";
import { meter } from "@/lib/metering/service";
import { hourBucket } from "@/lib/metering/wiring";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });

    let domain: string;
    try {
      const body = (await readJson(req)) as { domain?: unknown };
      domain = normalizeDomain(typeof body.domain === "string" ? body.domain : "");
    } catch (e) {
      if (e instanceof DomainInputError) {
        return Response.json({ error: e.message, code: "brandfetch_bad_request" }, { status: 400 });
      }
      throw e;
    }

    const apiKey = getBrandfetchApiKey();

    try {
      const { brand, kitColors, kitFonts } = await lookupBrandForKit(apiKey, domain);
      // Per-tenant metering, best-effort: metering never breaks a lookup.
      // Hour-bucketed idempotency: retries/double-clicks dedup; genuinely
      // repeated lookups later record again. Follows the keyword-ideas pattern.
      await meter({
        workspaceId: workspace.id,
        action: "brandfetch_lookup",
        idempotencyKey: `brandfetch:${workspace.id}:${domain}:${hourBucket()}`,
        evidenceRef: `brandfetch:${domain}`,
      }).catch(() => {});
      return Response.json({ brand, kitColors, kitFonts });
    } catch (e) {
      if (e instanceof BrandfetchNotFoundError) {
        return Response.json({ error: e.message, code: e.code }, { status: 404 });
      }
      if (e instanceof BrandfetchNotConfiguredError) {
        return Response.json({ error: e.message, code: e.code }, { status: 400 });
      }
      if (e instanceof BrandfetchApiError && e.status === 429) {
        // Pass the provider's rate limit through honestly.
        return Response.json({ error: e.message, code: "brandfetch_rate_limited" }, { status: 429 });
      }
      if (e instanceof BrandfetchApiError && e.status === 0) {
        return Response.json({ error: e.message, code: "brandfetch_unreachable" }, { status: 502 });
      }
      const message =
        e instanceof BrandfetchApiError ? e.message : "Brand lookup failed unexpectedly.";
      return Response.json({ error: message, code: "brandfetch_failed" }, { status: 502 });
    }
  } catch (e) {
    return httpErrorResponse(e);
  }
}
