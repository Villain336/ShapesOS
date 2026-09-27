// Marketr — studio Unsplash search API (Phase 11 "Canvas").
// GET /api/studio/unsplash/search?q=&page=&per_page= — server-side proxy to
// Unsplash Search Photos. The access key (UNSPLASH_ACCESS_KEY) stays on the
// server; the browser only sees the trimmed shape. No key → honest 400,
// never fake photos. Unsplash 429 is passed through as a 429.

import { guardWorkspace, httpErrorResponse } from "../../designs/_lib";
import {
  UnsplashApiError,
  fetchUnsplashPhotos,
  getUnsplashAccessKey,
  notConfiguredError,
  parseSearchParams,
  SearchParamError,
} from "@/lib/design/unsplash";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await guardWorkspace({ editor: true });

    let params;
    try {
      params = parseSearchParams(new URL(req.url).searchParams);
    } catch (e) {
      const message = e instanceof SearchParamError ? e.message : "Invalid search parameters.";
      return Response.json({ error: message, code: "unsplash_bad_request" }, { status: 400 });
    }

    const accessKey = getUnsplashAccessKey();
    if (!accessKey) {
      const { status, body } = notConfiguredError();
      return Response.json(body, { status });
    }

    try {
      const { results, total } = await fetchUnsplashPhotos(accessKey, params);
      return Response.json({ results, total, page: params.page, per_page: params.perPage });
    } catch (e) {
      if (e instanceof UnsplashApiError && e.status === 429) {
        // Pass the provider's rate limit through honestly.
        return Response.json(
          {
            error: "Unsplash rate limit reached (HTTP 429). Wait a bit and try again.",
            code: "unsplash_rate_limited",
          },
          { status: 429 },
        );
      }
      if (e instanceof UnsplashApiError && e.status === 0) {
        return Response.json(
          { error: "Could not reach Unsplash. Check your connection and try again.", code: "unsplash_unreachable" },
          { status: 502 },
        );
      }
      const status = e instanceof UnsplashApiError ? e.status : 500;
      return Response.json(
        {
          error: `Unsplash search failed (HTTP ${status}). Your key may be invalid or revoked.`,
          code: "unsplash_failed",
        },
        { status: 502 },
      );
    }
  } catch (e) {
    return httpErrorResponse(e);
  }
}
