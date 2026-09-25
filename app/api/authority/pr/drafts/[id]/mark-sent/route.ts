// Marketr — POST /api/authority/pr/drafts/:id/mark-sent
// Records a HUMAN-EXECUTED send. Marketr never sends on the client identity:
// the human sends from their own email client, and this endpoint creates the
// pr_send approval object, approves it as the acting human's attestation,
// enforces the journalist ruleset (fail closed — violations are audit-logged),
// and executes the approval (binding re-verified; HALTs on mismatch).
// No approved approval → blocked + audit-logged. Editor+.

import type { NextRequest } from "next/server";
import { authorityGuard, safetyError, readJson } from "@/app/api/authority/_lib";
import { authorityTablesReady } from "@/lib/authority/db";
import { markSent } from "@/lib/authority/pr/service";

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
  await readJson(_req).catch(() => ({}));

  try {
    const { id } = await params;
    const result = await markSent({
      workspaceId: gate.workspaceId,
      draftId: id,
      actor: gate.userId,
    });
    return Response.json(result);
  } catch (err) {
    return safetyError(err);
  }
}
