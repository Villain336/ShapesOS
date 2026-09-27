// Marketr — Pixabay cached-asset endpoint (Phase 11 "Canvas").
// GET /api/studio/pixabay/asset?t=<token> — the no-permanent-hotlinking
// architecture: the server downloads the chosen Pixabay CDN asset, caches the
// bytes for 24h (per Pixabay's API terms), and serves them from Marketr's own
// route. Placed elements use this URL as their src — raw Pixabay CDN URLs are
// NEVER permanent design sources.
// The token is an opaque base64url of the Pixabay CDN URL; it is decoded and
// checked against the CDN host allowlist before any fetch (the asset route
// cannot be abused as an open proxy). No Pixabay key is needed here (file
// URLs are keyless) and none is ever accepted.

import { guardWorkspace, httpErrorResponse } from "../../designs/_lib";
import {
  PixabayApiError,
  decodeAssetToken,
  getCachedAsset,
} from "@/lib/design/pixabay";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await guardWorkspace({ editor: true });

    const token = new URL(req.url).searchParams.get("t") ?? "";
    const sourceUrl = token ? decodeAssetToken(token) : null;
    if (!sourceUrl) {
      return Response.json(
        { error: "Invalid or expired asset reference.", code: "pixabay_asset_bad_token" },
        { status: 400 },
      );
    }

    try {
      const { bytes, mime } = await getCachedAsset(sourceUrl);
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": mime,
          // Cached assets are immutable for the 24h window; the token itself
          // is a stable reference to one CDN URL.
          "Cache-Control": "public, max-age=86400, immutable",
          "Content-Length": String(bytes.length),
        },
      });
    } catch (e) {
      if (e instanceof PixabayApiError && e.status === 0) {
        return Response.json(
          { error: "Could not download the Pixabay asset. Try again.", code: "pixabay_asset_unreachable" },
          { status: 502 },
        );
      }
      const status = e instanceof PixabayApiError && e.status === 413 ? 413 : 502;
      return Response.json(
        { error: "Could not load the Pixabay asset.", code: "pixabay_asset_failed" },
        { status },
      );
    }
  } catch (e) {
    return httpErrorResponse(e);
  }
}
