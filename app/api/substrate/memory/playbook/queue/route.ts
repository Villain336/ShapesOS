// Marketr — /api/substrate/memory/playbook/queue (Phase 8 G3).
// GET (editor): the human review queue — pending_review patterns, visible
// only through the reviewer GUC.
// POST (editor): propose a pattern from a learning (anonymized; quarantined
// candidates are refused with reasons).

import type { NextRequest } from "next/server";
import { memoryGuard, badRequest, readJson, memoryAudit } from "../../_lib";
import {
  listReviewQueue,
  proposePlaybookPattern,
} from "@/lib/substrate/memory/playbook";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await memoryGuard(req, "editor");
  if (gate instanceof Response) return gate;
  const queue = await listReviewQueue(gate.workspaceId);
  return Response.json({ queue });
}

export async function POST(req: NextRequest) {
  const gate = await memoryGuard(req, "editor");
  if (gate instanceof Response) return gate;
  const body = await readJson(req);
  const learningId = String(body.learningId ?? "").trim();
  if (!learningId) return badRequest("learningId is required");
  const result = await proposePlaybookPattern(gate.workspaceId, {
    learningId,
    title: body.title != null ? String(body.title) : null,
  });
  if (result.inserted) {
    memoryAudit().log(gate.workspaceId, gate.userId, "playbook.proposed", result.playbookId!, {
      learningId,
    });
    return Response.json({ playbookId: result.playbookId, status: "pending_review" }, { status: 201 });
  }
  return Response.json(
    { quarantined: true, reasons: result.quarantineReasons },
    { status: 422 },
  );
}
