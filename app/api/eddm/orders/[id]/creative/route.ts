// Marketr — EDDM concierge API: creative binding.
// PUT /api/eddm/orders/[id]/creative (editor+) → bind a Studio creative.
// Format-track enforced: EDDM orders require an "eddm"-track flat
// (min 6.125" x 11.5"); a 4x6 "addressed" postcard is rejected.

import { z } from "zod";
import {
  guardWorkspace,
  httpErrorResponse,
  readJson,
} from "@/lib/enrichment/guard";
import { setEddmCreative } from "@/lib/mail/eddm";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const CreativeSchema = z.object({
  creativeId: z.string().trim().min(1),
});

export async function PUT(req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = CreativeSchema.parse(await readJson(req));
    const order = await setEddmCreative(workspace.id, id, body.creativeId);
    return Response.json({ order });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
