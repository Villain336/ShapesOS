// Marketr — studio Pexels search API (Phase 11 "Canvas").
// GET /api/studio/pexels/search?q=&page=&per_page=&type=photo|video — server-side
// proxy to Pexels photo/video search. The API key (PEXELS_API_KEY) stays on
// the server; the browser only sees the trimmed shape. No key → honest 400,
// never fake media. Pexels 429 is passed through as a 429.

import { guardWorkspace, httpErrorResponse } from "../../designs/_lib";
import {
  PexelsApiError,
  fetchPexelsMedia,
  getPexelsApiKey,
  notConfiguredError,
  parseSearchParams,
  SearchParamError,
} from "@/lib/design/pexels";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await guardWorkspace({ editor: true });

    let params;
    try {
      params = parseSearchParams(new URL(req.url).searchParams);
    } catch (e) {
      const message = e instanceof SearchParamError ? e.message : "Invalid search parameters.";
      return Response.json({ error: message, code: "pexels_bad_request" }, { status: 400 });
    }

    const apiKey = getPexelsApiKey();
    if (!apiKey) {
      const { status, body } = notConfiguredError();
      return Response.json(body, { status });
    }

    try {
      const { results, total } = await fetchPexelsMedia(apiKey, params);
      return Response.json({ results, total, page: params.page, per_page: params.perPage, type: params.type });
    } catch (e) {
      if (e instanceof PexelsApiError && e.status === 429) {
        // Pass the provider's rate limit through honestly.
        return Response.json(
          {
            error: "Pexels rate limit reached (HTTP 429). Wait a bit and try again.",
            code: "pexels_rate_limited",
          },
          { status: 429 },
        );
      }
      if (e instanceof PexelsApiError && e.status === 0) {
        return Response.json(
          { error: "Could not reach Pexels. Check your connection and try again.", code: "pexels_unreachable" },
          { status: 502 },
        );
      }
      const status = e instanceof PexelsApiError ? e.status : 500;
      return Response.json(
        {
          error: `Pexels search failed (HTTP ${status}). Your key may be invalid or revoked.`,
          code: "pexels_failed",
        },
        { status: 502 },
      );
    }
  } catch (e) {
    return httpErrorResponse(e);
  }
}
