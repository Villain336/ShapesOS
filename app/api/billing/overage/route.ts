// Marketr — auto-overage opt-in toggle.
// POST /api/billing/overage { workspaceId, enabled } → { workspaceId, autoOverage }
// Admin-only (M11: requireWorkspaceAccess … "admin"). The core is exported
// as setOverageForUser so the adversarial battery can exercise the real
// authorization path without an HTTP session.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { workspaceIdFrom, requireWorkspaceAccess, badRequest } from "@/lib/route-utils";
import { setAutoOverage } from "@/lib/metering/billing";

export const dynamic = "force-dynamic";

/** Authorization-gated toggle core (unit-testable without a session). */
export async function setOverageForUser(args: {
  userId: string;
  workspaceId: string | null;
  enabled: boolean;
}): Promise<{ status: number; body: unknown }> {
  const access = await requireWorkspaceAccess(args.userId, args.workspaceId, "admin");
  if ("error" in access && access.error) {
    const res: Response = access.error;
    let body: unknown = { error: "forbidden" };
    try {
      body = await res.json();
    } catch {
      /* keep default */
    }
    return { status: res.status, body };
  }
  const result = await setAutoOverage({
    workspaceId: access.workspaceId,
    enabled: args.enabled,
    actorId: args.userId,
  });
  return { status: 200, body: result };
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let body: { enabled?: unknown; workspaceId?: unknown } | null = null;
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid JSON");
  }
  if (typeof body?.enabled !== "boolean") return badRequest("enabled must be a boolean");
  const { status, body: out } = await setOverageForUser({
    userId: user.id,
    workspaceId: workspaceIdFrom(req, body),
    enabled: body.enabled,
  });
  return Response.json(out, { status });
}
