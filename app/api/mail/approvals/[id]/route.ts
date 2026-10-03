// Marketr — POST /api/mail/approvals/[id]
//
// { decision: "approve" | "reject", note? } — decide a pending mail
// approval (C3 pattern, mirrors POST /api/messaging/approvals/[id]).
// Approve → campaign "approved"; reject → campaign "cancelled".

import type { NextRequest } from "next/server";
import { z } from "zod";
import { mailGuard, badRequest } from "../../_lib";
import { decideApproval } from "@/lib/mail/service";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

const DecideSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(1000).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await mailGuard("editor");
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
      gate.workspaceId,
      id,
      parsed.data.decision,
      gate.userId,
      parsed.data.note,
    );
    return Response.json({ approval });
  } catch (e) {
    return errorResponse(e, "POST /api/mail/approvals/[id]");
  }
}
