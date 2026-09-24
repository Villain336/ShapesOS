// Marketr — R3 speed-to-lead trigger API.
// POST /api/nurture/speed-to-lead { leadId } (editor+)
//
// The CRM lead-create route (owned by the CRM agent) can call this right
// after lead creation; until that hook is wired, clients can POST here
// directly. The message itself is still approval-gated by the dispatcher.

import { z } from "zod";
import { nurtureCtx, requireNurtureEditor, readJson } from "../_lib";
import { triggerSpeedToLead } from "@/lib/messaging/speed-to-lead";

export const dynamic = "force-dynamic";

const BodySchema = z.object({ leadId: z.string().min(1) });

export async function POST(req: Request) {
  const ctx = await nurtureCtx();
  if (ctx instanceof Response) return ctx;
  const editor = await requireNurtureEditor(ctx);
  if (editor) return editor;

  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return parsedBody.res;
  const parsed = BodySchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  try {
    const message = await triggerSpeedToLead(ctx.workspaceId, parsed.data.leadId);
    return Response.json({ message }, { status: 201 });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Speed-to-lead failed" },
      { status: 400 },
    );
  }
}
