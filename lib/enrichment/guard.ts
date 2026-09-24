// Marketr — R6 API guard helper. Mirrors the session/workspace guard in
// app/api/attribution/bundles/route.ts: requireUser + getOrCreateWorkspace,
// with an optional editor-role gate for mutations.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function guardWorkspace(opts?: { editor?: boolean }) {
  const user = await requireUser();
  if (!user) throw new HttpError(401, "Unauthorized");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (opts?.editor && !(await requireWorkspaceRole(user.id, workspace.id, "editor"))) {
    throw new HttpError(403, "Insufficient role for this action.");
  }
  return { user, workspace };
}

export function httpErrorResponse(e: unknown) {
  if (e instanceof HttpError) {
    return Response.json({ error: e.message }, { status: e.status });
  }
  const message = e instanceof Error ? e.message : "Internal error";
  const status = message === "Prospect not found" || message === "List not found" ? 404 : 500;
  return Response.json({ error: message }, { status });
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}
