// ShapesOS — route guard for "your own account" actions (Phase 4a: GDPR
// export and account deletion).
//
// Authorization model: the signed-in subject IS the resource. These routes
// take no user, workspace or record id from the request — every query is
// keyed to the session's own subject id — so there is nothing another user
// could point them at. That is what distinguishes this from a bare
// requireUser(): callers must not read a target id from the request.

import { requireUser } from "@/lib/session";

export interface SelfServiceUser {
  id: string;
  email: string | null;
  name: string | null;
}

type SessionUser = { id?: string | null; email?: string | null; name?: string | null } | null | undefined;

/** 401 when signed out; otherwise the session's own account. */
export async function requireSelfService(
  getUser: () => Promise<SessionUser> = requireUser,
): Promise<SelfServiceUser | Response> {
  const user = await getUser();
  if (!user?.id) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return { id: user.id, email: user.email ?? null, name: user.name ?? null };
}
