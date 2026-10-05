// ShapesOS — CAD route error mapping (Phase 4b). CadError codes are domain
// outcomes, not crashes: *_NOT_FOUND → 404, geometry that can't be measured
// → 422, an integrity mismatch → 409, every other domain rule → 400.
// Anything else goes through the shared errorResponse (500 logged, never echoed).

import { errorResponse } from "@/lib/api/errors";
import { CadError } from "./types";

const UNPROCESSABLE = new Set(["DERIVE_UNAVAILABLE"]);
const CONFLICT = new Set(["FILE_INTEGRITY", "FILE_MISSING"]);

export function cadErrorStatus(code: string): number {
  if (code.endsWith("_NOT_FOUND")) return 404;
  if (UNPROCESSABLE.has(code)) return 422;
  if (CONFLICT.has(code)) return 409;
  return 400;
}

export function cadRouteError(e: unknown, context?: string, req?: Request): Response {
  if (e instanceof CadError) {
    return Response.json({ error: e.message, code: e.code }, { status: cadErrorStatus(e.code) });
  }
  return errorResponse(e, context, req ?? null);
}
