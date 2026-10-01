// Marketr — E-sign module API.
// POST /api/esign/vault/purge-expired — retention enforcement. Entries past
// retention with no legal hold have their sealed bytes purged; legal holds
// always block purging.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { purgeExpired } from "@/lib/esign/vault";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const result = await purgeExpired(prisma, { workspaceId: workspace.id, actor: user.id });
    return Response.json(result);
  } catch (e) {
    return httpErrorResponse(e);
  }
}
