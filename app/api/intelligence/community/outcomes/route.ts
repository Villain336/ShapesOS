// Marketr — /api/intelligence/community/outcomes (Phase 10 M8).
//
// GET: the closed-loop feed — posted outcomes for this workspace, the rows
// M3's branded-mention tracking consumes via getCommunityOutcomes().
// POST: record that the human posted a queued draft natively
// (upvotes/replies/traffic entered by the human).

import { getCommunityOutcomes, recordCommunityOutcome } from "@/lib/intelligence/community";
import { intelligenceGuard, badRequest, readJson } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await intelligenceGuard("viewer");
  if (access instanceof Response) return access;
  const outcomes = await getCommunityOutcomes(access.workspaceId);
  return Response.json({ outcomes });
}

export async function POST(req: Request) {
  const access = await intelligenceGuard("editor");
  if (access instanceof Response) return access;
  const body = await readJson(req);

  const approvalId = body.approvalId;
  if (typeof approvalId !== "string" || !approvalId) {
    return badRequest("approvalId is required.");
  }
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  try {
    const result = await recordCommunityOutcome(access.workspaceId, {
      approvalId,
      actor: access.userId,
      postedAt: typeof body.postedAt === "string" ? body.postedAt : undefined,
      upvotes: num(body.upvotes),
      replies: num(body.replies),
      traffic: num(body.traffic),
      note: typeof body.note === "string" ? body.note : undefined,
    });
    return Response.json({ ok: true, ...result });
  } catch (e) {
    return badRequest(e instanceof Error ? e.message : "Failed to record outcome.");
  }
}
