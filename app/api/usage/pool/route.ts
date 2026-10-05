// ShapesOS — Phase 15.2: agency credit pooling (Settings → Usage).
//   GET    /api/usage/pool                       → { plan, role, owner, members, candidates } (admin+)
//   POST   /api/usage/pool { clientWorkspaceId }  → join this agency workspace's pool (admin+ of BOTH, audited)
//   DELETE /api/usage/pool?clientWorkspaceId=…   → leave the pool (admin+ of the client or the agency, audited)
// The pool rules (Agency plan only, one level, admin of both) live in
// lib/metering/pool.ts; meter()/checkCap() charge and cap the pool.

import type { NextRequest } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { auditEvent } from "@/lib/auditlog";
import { HttpError } from "@/lib/api/errors";
import { joinCreditPool, leaveCreditPool, listPoolMembers, poolCandidates } from "@/lib/metering/pool";

export const dynamic = "force-dynamic";

async function admin(): Promise<{ error: Response } | { user: { id: string; email?: string | null }; workspace: { id: string } }> {
  const user = await requireUser();
  if (!user) return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "admin"))) return { error: forbidden() };
  return { user, workspace };
}

function fail(e: unknown): Response {
  if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
  return Response.json({ error: "Could not update the credit pool." }, { status: 500 });
}

export async function GET(): Promise<Response> {
  const ctx = await admin();
  if ("error" in ctx) return ctx.error;
  const ws = await prisma.workspace.findUnique({
    where: { id: ctx.workspace.id },
    select: { plan: true, creditPoolOwner: { select: { id: true, name: true } } },
  });
  const members = await listPoolMembers(ctx.workspace.id);
  return Response.json({
    plan: ws?.plan ?? null,
    role: ws?.creditPoolOwner ? "member" : members.length > 0 || ws?.plan === "agency" ? "owner" : "none",
    owner: ws?.creditPoolOwner ?? null,
    members,
    candidates: ws?.plan === "agency" ? await poolCandidates(ctx.workspace.id, ctx.user.id) : [],
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const ctx = await admin();
  if ("error" in ctx) return ctx.error;
  let body: { clientWorkspaceId?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const clientWorkspaceId = typeof body.clientWorkspaceId === "string" ? body.clientWorkspaceId : "";
  try {
    await joinCreditPool({ poolWorkspaceId: ctx.workspace.id, clientWorkspaceId, actorUserId: ctx.user.id });
  } catch (e) {
    return fail(e);
  }
  await auditEvent({
    projectId: null,
    workspaceId: ctx.workspace.id,
    action: "settings_workspace_updated",
    summary: `Credit pool: workspace ${clientWorkspaceId} now spends this agency's pooled credits`,
    actorUserId: ctx.user.id,
  });
  return Response.json({ ok: true, members: await listPoolMembers(ctx.workspace.id) });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const ctx = await admin();
  if ("error" in ctx) return ctx.error;
  const clientWorkspaceId = req.nextUrl.searchParams.get("clientWorkspaceId") ?? ctx.workspace.id;
  try {
    await leaveCreditPool({ clientWorkspaceId, actorUserId: ctx.user.id });
  } catch (e) {
    return fail(e);
  }
  await auditEvent({
    projectId: null,
    workspaceId: ctx.workspace.id,
    action: "settings_workspace_updated",
    summary: `Credit pool: workspace ${clientWorkspaceId} left the agency pool`,
    actorUserId: ctx.user.id,
  });
  return Response.json({ ok: true, members: await listPoolMembers(ctx.workspace.id) });
}
