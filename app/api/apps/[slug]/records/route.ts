// ShapesOS — Phase 9 (apps): GET /api/apps/[slug]/records
//   ?entity=<key> | ?view=<key>, &q=, &limit= (≤500), &filters=<JSON array>
// Read-only: records are written through actions (POST …/actions). The read
// role is the view's minRole, or the entity's (lowest role among its views).

import type { NextRequest } from "next/server";
import { appsError, appsGuard } from "../../_lib";
import { listRecords } from "@/lib/apps/service";
import type { FilterSpec } from "@/lib/apps/spec";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const actor = await appsGuard("viewer");
  if (actor instanceof Response) return actor;
  try {
    const { slug } = await params;
    const q = req.nextUrl.searchParams;
    let filters: FilterSpec[] | undefined;
    const rawFilters = q.get("filters");
    if (rawFilters) {
      try {
        const parsed = JSON.parse(rawFilters) as unknown;
        if (!Array.isArray(parsed)) throw new Error("not an array");
        filters = parsed as FilterSpec[];
      } catch {
        return Response.json({ error: "filters must be a JSON array" }, { status: 400 });
      }
    }
    const limit = q.get("limit") ? Number(q.get("limit")) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      return Response.json({ error: "limit must be a positive integer" }, { status: 400 });
    }
    const res = await listRecords(actor, slug, {
      entity: q.get("entity") ?? undefined,
      view: q.get("view") ?? undefined,
      q: q.get("q") ?? undefined,
      filters,
      limit,
    });
    return Response.json(res);
  } catch (err) {
    return appsError(err);
  }
}
