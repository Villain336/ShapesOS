// ShapesOS — Phase 9 (apps): GET /api/apps/[slug]/records/[recordId]
// One record, with the spec version it was written under (older-version
// fields stay readable).

import { appsError, appsGuard } from "../../../_lib";
import { getRecord } from "@/lib/apps/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string; recordId: string }> };

export async function GET(_req: Request, { params }: Params) {
  const actor = await appsGuard("viewer");
  if (actor instanceof Response) return actor;
  try {
    const { slug, recordId } = await params;
    return Response.json(await getRecord(actor, slug, recordId));
  } catch (err) {
    return appsError(err);
  }
}
