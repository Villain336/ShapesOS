// ShapesOS — PUT /api/status/components/[key]: a platform operator sets or
// clears the MANUAL state of a status component (beta readiness, WS=legal).
//   { state: "maintenance" | "degraded" | … , note? } → 200 { key, state, note }
//   { state: null }                                    → 200 (back to the derived state)
// Platform operators only (requirePlatformOperator). Unknown key → 404.

import { requirePlatformOperator } from "@/lib/auth/require-platform-operator";
import { errorResponse } from "@/lib/api/errors";
import { validateBody } from "@/lib/api/validate";
import { componentOverrideBody } from "@/lib/status/schema";
import { isComponentKey, setComponentOverride } from "@/lib/status/store";
import { invalidateStatusSnapshot } from "@/lib/status/public";

export const dynamic = "force-dynamic";

export async function PUT(req: Request, { params }: { params: Promise<{ key: string }> }): Promise<Response> {
  try {
    const operator = await requirePlatformOperator();
    if (operator instanceof Response) return operator;
    const { key } = await params;
    if (!isComponentKey(key)) return Response.json({ error: "Unknown component." }, { status: 404 });
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const v = validateBody(componentOverrideBody, body);
    if (!v.ok) return v.error;
    const override = v.data.state ? { state: v.data.state, note: v.data.note?.trim() || null } : null;
    await setComponentOverride(key, override, operator.id);
    invalidateStatusSnapshot();
    return Response.json({ key, state: override?.state ?? null, note: override?.note ?? null });
  } catch (err) {
    return errorResponse(err, "PUT /api/status/components/[key]", req);
  }
}
