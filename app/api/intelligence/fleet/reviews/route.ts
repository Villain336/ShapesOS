// Marketr — Phase 10 M4: review-velocity API (licensed paths only).
// POST /api/intelligence/fleet/reviews
//   { source: "yelp", businessId } | { source: "dataforseo", keyword, lat, lng, depth? }
// → { result: ReviewAdapterResult, themes: ComplaintTheme[] }
//
// Per-business pulls need an explicit business identity — the API never
// guesses one. All adapters are graceful when unconfigured. The blocklist
// guard (types.ts) makes unlicensed review scraping structurally impossible.

import type { NextRequest } from "next/server";
import { requireWorkspaceRole } from "@/lib/authz";
import { requireUser } from "@/lib/session";
import { getOrCreateWorkspace } from "@/lib/session";
import {
  fetchDataForSeoReviews,
  fetchGbpReviewSignals,
  fetchYelpReviews,
  mineComplaintThemes,
  reviewVelocity,
} from "@/lib/intelligence/fleet/reviews";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    source?: string;
    businessId?: string;
    keyword?: string;
    lat?: number;
    lng?: number;
    depth?: number;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const workspaceId = (await getOrCreateWorkspace(user.id, user.email)).id;
  // Spends DataForSEO credits — editor+, like the other paid pulls.
  if (!(await requireWorkspaceRole(user.id, workspaceId, "editor")))
    return Response.json({ error: "Forbidden" }, { status: 403 });

  if (body.source === "yelp") {
    if (!body.businessId?.trim()) {
      return Response.json({ error: "businessId is required for Yelp" }, { status: 400 });
    }
    const result = await fetchYelpReviews(body.businessId.trim(), {
      limit: Math.max(1, Math.min(body.depth ?? 20, 50)),
    });
    return Response.json({
      result,
      velocity: reviewVelocity(result, new Date(Date.now() - 7 * 24 * 3600 * 1000)),
      themes: mineComplaintThemes(result.reviews),
    });
  }

  if (body.source === "dataforseo") {
    if (!body.keyword?.trim() || typeof body.lat !== "number" || typeof body.lng !== "number") {
      return Response.json(
        { error: "keyword, lat, and lng are required for DataForSEO Business Data" },
        { status: 400 },
      );
    }
    const result = await fetchDataForSeoReviews(
      { keyword: body.keyword.trim(), lat: body.lat, lng: body.lng, depth: body.depth ?? 20 },
      workspaceId,
    );
    return Response.json({
      result,
      velocity: reviewVelocity(result, new Date(Date.now() - 7 * 24 * 3600 * 1000)),
      themes: mineComplaintThemes(result.reviews),
    });
  }

  if (body.source === "gbp") {
    const result = await fetchGbpReviewSignals();
    return Response.json({
      result,
      velocity: reviewVelocity(result, new Date(Date.now() - 7 * 24 * 3600 * 1000)),
      themes: [],
    });
  }

  return Response.json(
    { error: 'source must be "yelp", "dataforseo", or "gbp"' },
    { status: 400 },
  );
}
