// ShapesOS — Phase 17 (observability): GET /api/usage/ai?workspaceId=&days=
//   → AI cost & speed for Settings → Usage (lib/metering/ai-health.ts):
//     cost per day, cache-hit %, cache-read share (window + 24 h), p50/p95
//     time to first token and call duration, cost by model, top runs.
// Reads: admin+ (billing data, the same gate as /api/usage/summary).

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { requireWorkspaceAccess, workspaceIdFrom } from "@/lib/route-utils";
import { getAiCostSpeed } from "@/lib/metering/ai-health";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "admin");
  if ("error" in access) return access.error;
  const days = Number(req.nextUrl.searchParams.get("days") ?? "14");
  const data = await getAiCostSpeed(access.workspaceId, { days: Number.isFinite(days) ? days : 14 });
  return Response.json(data);
}
