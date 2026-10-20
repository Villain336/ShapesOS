// ShapesOS — PATCH /api/status/incidents/[id]: a platform operator appends an
// update to an incident; status "resolved" closes it (beta readiness,
// WS=legal). { status, message, impact? } → 200 the incident, 404 unknown id.
// Platform operators only (requirePlatformOperator).

import { requirePlatformOperator } from "@/lib/auth/require-platform-operator";
import { errorResponse } from "@/lib/api/errors";
import { validateBody } from "@/lib/api/validate";
import { incidentUpdateBody } from "@/lib/status/schema";
import { toPublic, updateIncident } from "@/lib/status/store";
import { invalidateStatusSnapshot } from "@/lib/status/public";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const operator = await requirePlatformOperator();
    if (operator instanceof Response) return operator;
    const { id } = await params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const v = validateBody(incidentUpdateBody, body);
    if (!v.ok) return v.error;
    const incident = await updateIncident(id, v.data, operator.id);
    if (!incident) return Response.json({ error: "Incident not found." }, { status: 404 });
    invalidateStatusSnapshot();
    return Response.json(toPublic(incident));
  } catch (err) {
    return errorResponse(err, "PATCH /api/status/incidents/[id]", req);
  }
}
