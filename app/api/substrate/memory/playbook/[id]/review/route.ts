// Marketr — POST /api/substrate/memory/playbook/[id]/review (Phase 8 G3).
// Human review decision: { decision: "approved" | "rejected", note? }.
// Approval stamps reviewer + timestamp; only then does the pattern publish.

import type { NextRequest } from "next/server";
import { memoryGuard, badRequest, readJson } from "../../../_lib";
import { reviewPattern } from "@/lib/substrate/memory/playbook";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await memoryGuard(req, "editor");
  if (gate instanceof Response) return gate;
  const { id } = await ctx.params;
  const body = await readJson(req);
  const decision = String(body.decision ?? "");
  if (decision !== "approved" && decision !== "rejected") {
    return badRequest('decision must be "approved" or "rejected"');
  }
  const ok = await reviewPattern(
    gate.workspaceId,
    gate.userId,
    id,
    decision,
    body.note != null ? String(body.note).slice(0, 500) : undefined,
  );
  if (!ok) return Response.json({ error: "Pattern not found or not pending review." }, { status: 404 });
  return Response.json({ id, decision });
}
