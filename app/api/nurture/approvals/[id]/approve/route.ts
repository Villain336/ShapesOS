// Marketr — R3 approval decision API.
// POST /api/nurture/approvals/[id]/approve { note? } (editor+)
// POST /api/nurture/approvals/[id]/reject  { note? } (editor+)
//
// Approving releases the linked message to the dispatcher's next run; this
// route also triggers an immediate dispatch pass so an approval isn't stuck
// waiting on the cron schedule.

import { z } from "zod";
import { nurtureCtx, requireNurtureEditor, readJson } from "../../../_lib";
import { decideApproval, dispatchDue } from "@/lib/messaging/dispatcher";

export const dynamic = "force-dynamic";

const BodySchema = z.object({ note: z.string().trim().max(500).optional() });

async function decide(
  req: Request,
  params: Promise<{ id: string }>,
  decision: "approve" | "reject",
) {
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

  let updated;
  try {
    updated = await decideApproval(
      id,
      ctx.workspaceId,
      decision,
      ctx.userId,
      parsed.data.note ?? undefined,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Decision failed";
    const status = /not found/i.test(msg) ? 404 : /already/i.test(msg) ? 409 : 400;
    return Response.json({ error: msg }, { status });
  }

  // Release approved messages promptly (best-effort; the cron re-runs anyway).
  if (decision === "approve") {
    try {
      await dispatchDue(ctx.workspaceId);
    } catch {
      /* dispatch retries on the next cron tick */
    }
  }

  return Response.json({ item: updated });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return decide(req, params, "approve");
}
