// Marketr — O1 POST /api/authority/outreach/sequences/:id/send (editor+)
//
// Dispatches the next pending step of a sequence. `:id` is the SEQUENCE id.
//
// - Depth 1: blocked — 422 (prospecting only; zero sending code paths).
// - Depth 2: the human click IS the approval — this handler creates,
//   submits, approves (by the clicking editor), and executes an
//   outreach_send approval bound to the exact payload, then dispatches.
// - Depth 3: requires an active campaign + an executed two-person
//   depth3_activation approval; the checklist is re-verified at dispatch and
//   the rail checks run (daily cap, CASL, suppression, bounce
//   circuit-breaker, spam ceiling).
// Every external send is audit-logged.

import { authorityGuard, safetyError } from "@/app/api/authority/_lib";
import { authorityTablesReady } from "@/lib/authority/db";
import { sendNextStep } from "@/lib/authority/outreach";
import { outreachStores, sendingPartner } from "@/app/api/authority/outreach/_stores";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json(
      { error: "Authority tables not provisioned yet (migration pending)." },
      { status: 503 },
    );
  }
  const { id } = await params;
  const stores = outreachStores();
  try {
    const result = await sendNextStep(
      { ...stores, partner: sendingPartner() },
      { workspaceId: gate.workspaceId, sequenceId: id, actor: gate.userId },
    );
    return Response.json({
      sequenceId: result.sequence.id,
      status: result.sequence.status,
      stepIndex: result.stepIndex,
      messageId: result.messageId,
      approvalId: result.approvalId,
      depth: result.sequence.depth,
    });
  } catch (err) {
    return safetyError(err);
  }
}
