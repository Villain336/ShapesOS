// Marketr — POST /api/messaging/approvals/[id]
//
// { decision: "approve" | "reject", note? } — decide a pending approval.
// On approve, immediately flush anything the approval unlocks via
// dispatchDue(workspaceId) so the human doesn't wait for the cron.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { messagingGuard, badRequest } from "../../_lib";
import { decideApproval, dispatchDue } from "@/lib/messaging/dispatcher";

export const dynamic = "force-dynamic";

const DecideSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(1000).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await messagingGuard("editor");
  if (gate instanceof Response) return gate;

  const { id } = await params;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const parsed = DecideSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const approval = await decideApproval(
      id,
      gate.workspaceId,
      parsed.data.decision,
      gate.userId,
      parsed.data.note,
    );
    const dispatch =
      parsed.data.decision === "approve" ? await dispatchDue(gate.workspaceId) : null;
    return Response.json({ approval, dispatch });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Decision failed";
    const status = msg.includes("not found") ? 404 : 400;
    return Response.json({ error: msg }, { status });
  }
}
