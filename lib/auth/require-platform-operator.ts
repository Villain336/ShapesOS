// ShapesOS — route guard for host-wide resources (Phase 1). See
// lib/auth/platform-operator.ts for who counts as an operator.

import { requireUser } from "@/lib/session";
import { isPlatformOperator } from "./platform-operator";

export interface PlatformOperator {
  id: string;
  email: string | null;
}

type SessionUser = { id?: string | null; email?: string | null } | null | undefined;

/** 401 when signed out, 403 unless the user is a platform operator. */
export async function requirePlatformOperator(
  getUser: () => Promise<SessionUser> = requireUser,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PlatformOperator | Response> {
  const user = await getUser();
  if (!user?.id) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isPlatformOperator({ id: user.id, email: user.email }, env)) {
    return Response.json({ error: "Platform operators only." }, { status: 403 });
  }
  return { id: user.id, email: user.email ?? null };
}
