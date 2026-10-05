// ShapesOS — Phase 15.4 (zernio): shared route helpers for /api/zernio/*.
// Every route resolves the workspace from the request and gates it with
// requireWorkspaceAccess (viewer reads the card; admin connects accounts),
// then works only on THAT workspace's Zernio profile (lib/zernio/tenancy.ts).

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { requireWorkspaceAccess, workspaceIdFrom } from "@/lib/route-utils";
import type { WorkspaceRole } from "@prisma/client";
import { ZernioError } from "@/lib/zernio/client";
import { ZernioNotConfiguredError } from "@/lib/zernio/config";
import { ZernioScopeError } from "@/lib/zernio/tenancy";
import { ZernioConnectConfigError } from "@/lib/zernio/connect";

export async function zernioGuard(
  req: NextRequest,
  min: WorkspaceRole,
  body?: { workspaceId?: unknown } | null,
): Promise<{ userId: string; workspaceId: string } | Response> {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req, body ?? null), min);
  if ("error" in access) return access.error ?? Response.json({ error: "Forbidden" }, { status: 403 });
  return { userId: user.id, workspaceId: access.workspaceId };
}

/** Errors → honest JSON (no key material; Zernio's own message is scrubbed by the client). */
export function zernioErrorResponse(e: unknown): Response {
  if (e instanceof ZernioNotConfiguredError) return Response.json({ error: e.message, code: "not_connected" }, { status: 503 });
  if (e instanceof ZernioConnectConfigError) return Response.json({ error: e.message, code: "config_missing" }, { status: 503 });
  if (e instanceof ZernioScopeError) return Response.json({ error: e.message, code: "forbidden" }, { status: 400 });
  if (e instanceof ZernioError) {
    const status = e.code === "rate_limited" ? 429 : e.code === "not_found" ? 404 : 502;
    return Response.json(
      { error: e.message, code: e.zernioCode ?? e.code, ...(e.retryAfterSec !== null ? { retryAfterSec: e.retryAfterSec } : {}) },
      { status, headers: e.retryAfterSec !== null ? { "Retry-After": String(e.retryAfterSec) } : undefined },
    );
  }
  return Response.json({ error: "Zernio request failed." }, { status: 500 });
}
