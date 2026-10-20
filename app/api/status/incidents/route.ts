// ShapesOS — POST /api/status/incidents: a platform operator opens an
// incident on the public status page (beta readiness, WS=legal).
//   { title, status, impact, componentKeys[], message }  → 201 the incident
// Platform operators only (requirePlatformOperator, MARKETR_PLATFORM_OPERATORS):
// the status page is host-wide, not a workspace resource.

import { requirePlatformOperator } from "@/lib/auth/require-platform-operator";
import { errorResponse } from "@/lib/api/errors";
import { validateBody } from "@/lib/api/validate";
import { incidentCreateBody } from "@/lib/status/schema";
import { createIncident, toPublic } from "@/lib/status/store";
import { invalidateStatusSnapshot } from "@/lib/status/public";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  try {
    const operator = await requirePlatformOperator();
    if (operator instanceof Response) return operator;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const v = validateBody(incidentCreateBody, body);
    if (!v.ok) return v.error;
    const incident = await createIncident(v.data, operator.id);
    invalidateStatusSnapshot();
    return Response.json(toPublic(incident), { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/status/incidents", req);
  }
}
