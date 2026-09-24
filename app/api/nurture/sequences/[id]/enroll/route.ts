// Marketr — R3 sequence enrollment API.
// POST /api/nurture/sequences/[id]/enroll   { leadIds[] } (editor+)
// POST /api/nurture/sequences/[id]/unenroll { leadIds[] } (editor+)

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { nurtureCtx, requireNurtureEditor, readJson } from "../../../_lib";
import { enrollLead } from "@/lib/messaging/sequences";

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

  const results: Array<Record<string, unknown>> = [];
  for (const leadId of parsed.data.leadIds) {
    try {
      const r = await enrollLead(ctx.workspaceId, id, leadId);
      results.push({ leadId, ok: true, ...r });
    } catch (err) {
      results.push({ leadId, ok: false, error: err instanceof Error ? err.message : "Enroll failed" });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  return Response.json({ results, enrolled: okCount });
}
