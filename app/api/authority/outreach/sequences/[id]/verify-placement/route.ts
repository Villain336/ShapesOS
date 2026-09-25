// Marketr — O1 POST /api/authority/outreach/sequences/:id/verify-placement (editor+)
// Runs a placement verification check for one sequence (placed / lost /
// nofollow-flip / anchor-change alerts). Records a placement_verified event
// and audit-logs. `:id` is the SEQUENCE id.

import { authorityGuard, safetyError } from "@/app/api/authority/_lib";
import { authorityTablesReady } from "@/lib/authority/db";
import { verifyPlacement } from "@/lib/authority/outreach";
import { outreachStores } from "@/app/api/authority/outreach/_stores";

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
    const check = await verifyPlacement(
      { sequences: stores.sequences, prospects: stores.prospects },
      { workspaceId: gate.workspaceId, sequenceId: id, actor: gate.userId },
    );
    return Response.json({ placement: check });
  } catch (err) {
    return safetyError(err);
  }
}
