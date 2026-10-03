// Marketr — R6 API guard helper. Mirrors the session/workspace guard in
// app/api/attribution/bundles/route.ts: requireUser + getOrCreateWorkspace,
// with an optional editor-role gate for mutations.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import {
  BadRequestError,
  ForbiddenError,
  HttpError,
  UnauthorizedError,
  errorResponse,
} from "@/lib/api/errors";

// HttpError lives in lib/api/errors (one class app-wide); re-exported so
// existing `import { HttpError } from "@/lib/enrichment/guard"` keeps working.
export { HttpError };

export async function guardWorkspace(opts?: { editor?: boolean }) {
  const user = await requireUser();
  if (!user) throw new UnauthorizedError("Unauthorized");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (opts?.editor && !(await requireWorkspaceRole(user.id, workspace.id, "editor"))) {
    throw new ForbiddenError("Insufficient role for this action.");
  }
  return { user, workspace };
}

/**
 * Route catch-all: HttpError → its status, ZodError → 400, not found → 404,
 * anything else → a generic 500 (logged, never echoed). See lib/api/errors.
 */
export function httpErrorResponse(e: unknown) {
  return errorResponse(e);
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new BadRequestError("Invalid JSON");
  }
}
