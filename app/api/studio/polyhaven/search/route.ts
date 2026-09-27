// Marketr — studio Poly Haven 3D search API (Phase 11 "Canvas").
// GET /api/studio/polyhaven/search?q=&limit= — server-side proxy to the
// keyless Poly Haven API. The ToS-mandated identifying Referer/user-agent
// is sent from here, never the browser. All Poly Haven assets are CC0
// catalog-wide; results are models only (type filter) with their
// hotlinkable 256px render thumbnails. Poly Haven 429 is passed through.

import { guardWorkspace, httpErrorResponse } from "../../designs/_lib";
import {
  fetchPolyHavenModels,
  parsePolyHavenSearchParams,
  PolyHavenApiError,
  SearchParamError,
} from "@/lib/design/polyhaven";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await guardWorkspace({ editor: true });

    let params;
    try {
      params = parsePolyHavenSearchParams(new URL(req.url).searchParams);
    } catch (e) {
      const message = e instanceof SearchParamError ? e.message : "Invalid search parameters.";
      return Response.json({ error: message, code: "polyhaven_bad_request" }, { status: 400 });
    }

    try {
      const { results, total } = await fetchPolyHavenModels(params);
      return Response.json({ results, total, q: params.q, limit: params.limit });
    } catch (e) {
      if (e instanceof PolyHavenApiError && e.status === 429) {
        // Pass the provider's rate limit through honestly.
        return Response.json(
          {
            error: "Poly Haven rate limit reached (HTTP 429). Wait a bit and try again.",
            code: "polyhaven_rate_limited",
          },
          { status: 429 },
        );
      }
      if (e instanceof PolyHavenApiError && e.status === 0) {
        return Response.json(
          { error: "Could not reach Poly Haven. Check your connection and try again.", code: "polyhaven_unreachable" },
          { status: 502 },
        );
      }
      const status = e instanceof PolyHavenApiError ? e.status : 500;
      return Response.json(
        { error: `Poly Haven search failed (HTTP ${status}).`, code: "polyhaven_failed" },
        { status: 502 },
      );
    }
  } catch (e) {
    return httpErrorResponse(e);
  }
}
