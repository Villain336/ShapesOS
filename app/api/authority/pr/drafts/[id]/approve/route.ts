// Marketr — POST /api/authority/pr/drafts/:id/approve
// Human approves the draft content (de-AI pass + full checklist required).
// This is content approval — not a send. Drafts never send themselves. Editor+.

import type { NextRequest } from "next/server";
import { authorityGuard, safetyError } from "@/app/api/authority/_lib";
import { authorityTablesReady } from "@/lib/authority/db";
import { approveDraft } from "@/lib/authority/pr/service";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json({ error: "Authority tables not provisioned yet." }, { status: 503 });
  }

  try {
    const { id } = await params;
    const result = await approveDraft({
      workspaceId: gate.workspaceId,
      draftId: id,
      actor: gate.userId,
    });
    return Response.json(result);
  } catch (err) {
    return safetyError(err);
  }
}
