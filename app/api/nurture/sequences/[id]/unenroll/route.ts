// Marketr — R3 sequence unenroll API.
// POST /api/nurture/sequences/[id]/unenroll { leadIds[] } (editor+)
// Marks active/paused enrollments "unenrolled"; terminal ones are no-ops.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { nurtureCtx, requireNurtureEditor, readJson } from "../../../_lib";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  leadIds: z.array(z.string().min(1)).min(1).max(500),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await nurtureCtx();
  if (ctx instanceof Response) return ctx;
  const editor = await requireNurtureEditor(ctx);
  if (editor) return editor;
  const { id } = await params;

  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return parsedBody.res;
  const parsed = BodySchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const { count } = await prisma.sequenceEnrollment.updateMany({
    where: {
      workspaceId: ctx.workspaceId,
      sequenceId: id,
      leadId: { in: parsed.data.leadIds },
      status: { in: ["active", "paused"] },
    },
    data: { status: "unenrolled", nextRunAt: null },
  });
  return Response.json({ unenrolled: count });
}
