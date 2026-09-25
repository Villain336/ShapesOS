// Marketr — /api/authority/aeo/actions/:id/approve
// POST → approve an action. Owned fixes enter the supervised ladder (an
//        aeo_content_fix authority approval is created + submitted — the fix
//        applies only after that approval is approved AND executed, with the
//        binding re-verified). Third-party plans are approved as a user
//        commitment — Marketr never publishes on third-party pages. (editor+)

import type { NextRequest } from "next/server";
import { authorityGuard, safetyError } from "@/app/api/authority/_lib";
import { authorityTablesReady } from "@/lib/authority/db";
import { approveAction } from "@/lib/authority/aeo/act";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
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
  try {
    const result = await approveAction({ id, workspaceId: gate.workspaceId, approver: gate.userId });
    return Response.json(result);
  } catch (err) {
    return safetyError(err);
  }
}
