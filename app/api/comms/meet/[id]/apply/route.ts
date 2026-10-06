// ShapesOS — Phase 18.2 (WS=comms): save the meeting agent's record.
//   POST /api/comms/meet/[id]/apply { saveDoc, items: [{ index, target: reminder|task|skip, opsProjectId? }] } → { meeting }
// Editor+, once per meeting, never from a mock summary: the notes become a
// note in the Notes app (lib/notes createNote — shared with the workspace,
// or private to you when the call was in a private conversation); each
// chosen action item becomes your reminder or a task in an ops project.

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { applySummary } from "@/lib/comms/meet/meet.server";
import { idParam, meetGuard } from "../../_lib";

export const dynamic = "force-dynamic";

const Body = z
  .object({
    saveDoc: z.boolean(),
    items: z
      .array(z.object({ index: z.number().int().min(0).max(100), target: z.enum(["reminder", "task", "skip"]), opsProjectId: z.string().max(64).nullable().optional() }).strict())
      .max(30),
  })
  .strict();

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await meetGuard();
    const parsed = validateBody(Body, await req.json().catch(() => null));
    if (!parsed.ok) return parsed.error;
    return Response.json({ meeting: await applySummary(ctx, idParam((await params).id), parsed.data) });
  } catch (err) {
    return errorResponse(err, "POST /api/comms/meet/[id]/apply");
  }
}
