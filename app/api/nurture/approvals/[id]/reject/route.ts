// Marketr — R3 approval rejection API.
// POST /api/nurture/approvals/[id]/reject { note? } (editor+)

import { z } from "zod";
import { nurtureCtx, requireNurtureEditor, readJson } from "../../../_lib";
import { decideApproval } from "@/lib/messaging/dispatcher";

export const dynamic = "force-dynamic";

const BodySchema = z.object({ note: z.string().trim().max(500).optional() });

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

  const item = await (async () => {
    try {
      return await decideApproval(id, ctx.workspaceId, "reject", ctx.userId, parsed.data.note ?? undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Reject failed";
      const status = /not found/i.test(msg) ? 404 : /already/i.test(msg) ? 409 : 400;
      return Response.json({ error: msg }, { status });
    }
  })();
  if (item instanceof Response) return item;
  return Response.json({ item });
}
