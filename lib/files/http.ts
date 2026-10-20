// ShapesOS — Phase 18.2 (WS=content): shared bits of the Files routes.
// Each route still runs requireWorkspaceAccess itself (the M11 battery reads
// the route file); this maps errors and builds the per-file actor.

import type { WorkspaceRole } from "@prisma/client";
import { FsError } from "@/lib/filesystem/service";
import { errorResponse } from "@/lib/api/errors";
import type { FileActor } from "./access";

export function fileActor(userId: string, workspaceId: string, role: WorkspaceRole): FileActor {
  return { userId, workspaceId, role };
}

/** FsError → its status; HttpError / Zod / anything else → lib/api/errors. */
export function filesErrorResponse(err: unknown, context: string): Response {
  if (err instanceof FsError) {
    const status =
      err.code === "not_found" ? 404
      : err.code === "conflict" || err.code === "invalid_state" || err.code === "stale_version" ? 409
      : err.code === "quota_exceeded" || err.code === "too_large" ? 413
      : err.code === "forbidden" ? 403
      : err.code === "scanner_unavailable" ? 503
      : 400;
    return Response.json({ error: err.message, code: err.code, ...(err.code === "stale_version" ? { currentVersion: err.meta?.currentVersion ?? null } : {}) }, { status });
  }
  return errorResponse(err, context);
}
