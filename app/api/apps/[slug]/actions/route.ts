// ShapesOS — Phase 9 (apps): POST /api/apps/[slug]/actions — run a spec action.
//   { action, recordId?, data?, confirmed?, approvalId? }
// The ONLY record write path. Workspace floor: editor+ (viewers are
// read-only); the action's own minRole and tier then apply
// (lib/apps/service.ts runAppAction):
//   200 { outcome: "done", … }
//   409 { outcome: "confirm_required" }  — tier 1 without confirmed
//   202 { outcome: "approval_required", approval } — tier 2, proposed to
//       Approvals; call again with approvalId once it's approved
//   422 — the approval is missing / not approved / expired / replayed /
//         doesn't match this exact mutation (fail closed)

import { appsError, appsGuard, readJsonBody } from "../../_lib";
import { runAppAction } from "@/lib/apps/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

export async function POST(req: Request, { params }: Params) {
  const actor = await appsGuard("editor");
  if (actor instanceof Response) return actor;
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  if (typeof body.action !== "string" || !body.action) {
    return Response.json({ error: "Say which action to run" }, { status: 400 });
  }
  const data = body.data;
  if (data !== undefined && data !== null && (typeof data !== "object" || Array.isArray(data))) {
    return Response.json({ error: "data must be an object of field values" }, { status: 400 });
  }
  try {
    const { slug } = await params;
    const result = await runAppAction(actor, slug, {
      action: body.action,
      recordId: typeof body.recordId === "string" && body.recordId ? body.recordId : null,
      data: (data as Record<string, unknown> | null | undefined) ?? null,
      confirmed: body.confirmed === true,
      approvalId: typeof body.approvalId === "string" && body.approvalId ? body.approvalId : null,
      via: "ui",
    });
    const status = result.outcome === "done" ? 200 : result.outcome === "approval_required" ? 202 : 409;
    return Response.json(result, { status });
  } catch (err) {
    return appsError(err);
  }
}
