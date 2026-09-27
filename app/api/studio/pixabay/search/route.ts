// Marketr — studio Pixabay search API (Phase 11 "Canvas").
// GET /api/studio/pixabay/search?q=&page=&per_page=&type=image|video&image_type=photo|illustration|vector
// Server-side proxy to the Pixabay API. The API key (PIXABAY_API_KEY) is
// appended to the Pixabay request query string HERE — it never appears in a
// browser-visible URL. No key → honest 400, never fake media.
// Responses are cached 24h per the Pixabay API terms; ~100 req/60s per
// workspace answered with an honest 429.

import { guardWorkspace, httpErrorResponse } from "../../designs/_lib";
import {
  PixabayApiError,
  RateLimitError,
  checkRateLimit,
  fetchPixabayMedia,
  getPixabayApiKey,
  notConfiguredError,
  parseSearchParams,
  SearchParamError,
} from "@/lib/design/pixabay";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });

    let params;
    try {
      params = parseSearchParams(new URL(req.url).searchParams);
    } catch (e) {
      const message = e instanceof SearchParamError ? e.message : "Invalid search parameters.";
      return Response.json({ error: message, code: "pixabay_bad_request" }, { status: 400 });
    }

    if (!checkRateLimit(workspace.id)) {
      return Response.json(
        {
          error: "Pixabay rate limit reached (~100 requests/minute). Wait a bit and try again.",
          code: "pixabay_rate_limited",
        },
        { status: 429 },
      );
    }

    const apiKey = getPixabayApiKey();
    if (!apiKey) {
      const { status, body } = notConfiguredError();
      return Response.json(body, { status });
    }

    try {
      const { results, total } = await fetchPixabayMedia(apiKey, params);
      return Response.json({
        results,
        total,
        page: params.page,
        per_page: params.perPage,
        type: params.type,
        cached: true,
      });
    } catch (e) {
      if (e instanceof RateLimitError) {
        return Response.json({ error: e.message, code: "pixabay_rate_limited" }, { status: 429 });
      }
      if (e instanceof PixabayApiError && e.status === 429) {
        // Pass the provider's rate limit through honestly.
        return Response.json(
          {
            error: "Pixabay rate limit reached (HTTP 429). Wait a bit and try again.",
            code: "pixabay_rate_limited",
          },
          { status: 429 },
        );
      }
      if (e instanceof PixabayApiError && e.status === 0) {
        return Response.json(
          { error: "Could not reach Pixabay. Check your connection and try again.", code: "pixabay_unreachable" },
          { status: 502 },
        );
      }
      const status = e instanceof PixabayApiError ? e.status : 500;
      return Response.json(
        {
          error: `Pixabay search failed (HTTP ${status}). Your key may be invalid or revoked.`,
          code: "pixabay_failed",
        },
        { status: 502 },
      );
    }
  } catch (e) {
    return httpErrorResponse(e);
  }
}
