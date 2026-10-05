// ShapesOS — Phase 13 (twincore): POST /api/twin/sites/sample { kind }
//
// Creates the workspace's optional SAMPLE site for a kind (warehouse,
// factory or store) from REAL ops records — warehouse, locations, products
// and stock through the ledger, work centres and a running work order, a
// register with an open session, dock bookings, two forklifts — and lays it
// out with objects bound to them (lib/twin/sample.ts). Idempotent per kind
// per workspace: a second call returns the existing site (200, created
// false). Admin+ only (it writes many records at once). The site stays a
// draft — publishing it is a person's gated step.

import type { NextRequest } from "next/server";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { OpsError, OpsGateError } from "@/lib/ops/doctype";
import { createSampleSite } from "@/lib/twin/sample";
import { TWIN_SITE_KINDS, type TwinSiteKind } from "@/lib/twin/types";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "admin"))) {
    return Response.json({ error: "Forbidden: admin role required" }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const kind = (body as { kind?: unknown } | null)?.kind;
  if (typeof kind !== "string" || !(TWIN_SITE_KINDS as readonly string[]).includes(kind)) {
    return Response.json({ error: `kind must be one of ${TWIN_SITE_KINDS.join(", ")}` }, { status: 400 });
  }
  try {
    const result = await withWorkspaceScope(
      workspace.id,
      (tx) => createSampleSite(tx, { workspaceId: workspace.id, userId: user.id }, kind as TwinSiteKind),
      { timeoutMs: 60_000 },
    );
    return Response.json(result, { status: result.created ? 201 : 200 });
  } catch (err) {
    if (err instanceof OpsError) return Response.json({ error: err.message }, { status: err.status });
    if (err instanceof OpsGateError) return Response.json({ error: err.message, code: err.code }, { status: 422 });
    // A concurrent first call created the same codes: the unique keys refuse the second.
    if (err instanceof Error && /Unique constraint|P2002/.test(err.message)) {
      return Response.json({ error: "The sample site is already being created — reload in a moment" }, { status: 409 });
    }
    return errorResponse(err);
  }
}
