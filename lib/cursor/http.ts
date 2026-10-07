// ShapesOS — Phase 19A (WS=server): who is calling /api/cursor/*.
//
// Every cursor route accepts EITHER the ShapesOS session cookie (the
// desktop's main window signs in like a browser and its main process sends
// that partition's cookies) OR `Authorization: Bearer <cursor token>` from
// POST /api/cursor/session (lib/cursor/token.ts). Either way the caller's
// CURRENT membership is read for the bound workspace, so a removed member or
// a downgraded role takes effect at once. No session → 401; acting as a
// viewer → 403 (each route asks for the role it needs with
// requireWorkspaceRole). Errors use the contract's shape:
//   { error: { code, message } }.

import type { WorkspaceRole } from "@prisma/client";
import { getMembership } from "@/lib/authz";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { bearerCursorToken, cursorTokenSecret, verifyCursorToken } from "./token";

export class CursorHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CursorHttpError";
  }
}

export interface CursorCallerInfo {
  userId: string;
  name: string | null;
  workspaceId: string;
  role: WorkspaceRole;
  via: "cookie" | "token";
}

/** Resolve the caller (cookie or bearer token) and their current role. */
export async function resolveCursorCaller(req: Request): Promise<CursorCallerInfo> {
  const bearer = bearerCursorToken(req.headers);
  if (bearer) {
    const secret = cursorTokenSecret();
    if (!secret) throw new CursorHttpError(401, "unauthorized", "Cursor tokens are not enabled on this server.");
    const v = verifyCursorToken(bearer, secret);
    if (!v.ok) throw new CursorHttpError(401, v.reason === "expired" ? "token_expired" : "unauthorized", v.reason === "expired" ? "The cursor token expired. Ask for a new one." : "Invalid cursor token.");
    // The token was minted from a session that passed every sign-in check
    // (including a workspace's 2FA policy) at most 10 minutes ago; here the
    // CURRENT membership row decides (removed → 401, role changes at once).
    const m = await tokenMembership(v.claims.uid, v.claims.ws);
    if (!m) throw new CursorHttpError(401, "unauthorized", "You are no longer a member of that workspace.");
    return { userId: v.claims.uid, name: m.name, workspaceId: v.claims.ws, role: m.role, via: "token" };
  }
  const user = await requireUser();
  if (!user?.id) throw new CursorHttpError(401, "unauthorized", "Sign in to use the cursor.");
  const ws = await getOrCreateWorkspace(user.id, user.email);
  const m = await getMembership(user.id, ws.id);
  if (!m) throw new CursorHttpError(403, "forbidden", "You are not a member of this workspace.");
  return { userId: user.id, name: user.name ?? null, workspaceId: ws.id, role: m.role, via: "cookie" };
}

async function tokenMembership(userId: string, workspaceId: string): Promise<{ role: WorkspaceRole; name: string | null } | null> {
  const row = await prisma.workspaceMember.findFirst({ where: { workspaceId, userId }, select: { role: true, name: true } });
  if (row) return { role: row.role, name: row.name ?? null };
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { ownerUserId: true } });
  return ws?.ownerUserId === userId ? { role: "owner", name: null } : null;
}

/** The contract's error body. */
export function cursorErrorResponse(err: unknown, headers?: HeadersInit): Response {
  const e = err as { status?: unknown; code?: unknown; message?: unknown; name?: unknown };
  const known = typeof e?.status === "number" && typeof e?.code === "string" && typeof e?.message === "string";
  if (known) return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status as number, headers });
  if (err instanceof Error && err.name === "AgentsPausedError") {
    return Response.json({ error: { code: "agents_paused", message: err.message } }, { status: 409, headers });
  }
  console.error("[cursor] unhandled error", err);
  return Response.json({ error: { code: "internal", message: "Something went wrong. Try again." } }, { status: 500, headers });
}

export function forbiddenCursor(message = "Viewers can't do this."): CursorHttpError {
  return new CursorHttpError(403, "forbidden", message);
}

/** Read a JSON body with a byte limit (413 when larger). */
export async function readCursorJson(req: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw new CursorHttpError(413, "too_large", "The request is too large.");
  const text = await req.text();
  if (Buffer.byteLength(text) > maxBytes) throw new CursorHttpError(413, "too_large", "The request is too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw new CursorHttpError(400, "bad_request", "Invalid JSON.");
  }
}
