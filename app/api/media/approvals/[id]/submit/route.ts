// Marketr — POST /api/media/approvals/:id/submit (draft → pending)

import type { NextRequest } from "next/server";
import { mediaGuard, safetyError } from "../../../_lib";
import { mediaStores, safetyTablesReady } from "@/lib/media/db";
import { submitApproval } from "@/lib/media/approvals";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await mediaGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await safetyTablesReady())) {
    return Response.json({ error: "Media safety tables not provisioned yet." }, { status: 503 });
  }
  try {
    const { id } = await params;
    const { approvals } = mediaStores();
    const approval = await submitApproval(approvals, id, gate.workspaceId, gate.userId);
    return Response.json({ approval });
  } catch (err) {
    return safetyError(err);
  }
}
