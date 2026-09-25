// Marketr — studio creative mark-ready (Phase 4, T2, spec §7).
// POST /api/studio/creatives/[id]/mark-ready { attested: boolean } (editor)
// Requires the "contains no USPS/government impersonation markings"
// confirmation checkbox. The attestation is stored on the creative's
// validation report alongside the creative hash bound to approvals.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { markReady } from "@/lib/studio/creatives";
import {
  creativeErrorResponse,
  guardWorkspace,
  readJson,
} from "../../_lib";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const MarkReadySchema = z.object({ attested: z.boolean() });

export async function POST(req: Request, { params }: Params) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const parsed = MarkReadySchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
    }
    const creative = await markReady(prisma, workspace.id, id, {
      attested: parsed.data.attested,
      attestedBy: user.id,
    });
    return Response.json({ creative });
  } catch (e) {
    return creativeErrorResponse(e);
  }
}
