// Marketr — GET /api/substrate/memory/playbook (Phase 8 G3).
// Published playbook: APPROVED, human-reviewed, anonymized cross-client
// patterns ONLY. Unreviewed rows are invisible here by RLS policy.

import type { NextRequest } from "next/server";
import { memoryGuard } from "../_lib";
import { listReviewedPatterns } from "@/lib/substrate/memory/playbook";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await memoryGuard(req, "viewer");
  if (gate instanceof Response) return gate;
  const p = req.nextUrl.searchParams;
  const patterns = await listReviewedPatterns({
    q: p.get("q")?.trim() || undefined,
    limit: Math.min(Number(p.get("limit") ?? 50) || 50, 200),
  });
  return Response.json({ patterns });
}
