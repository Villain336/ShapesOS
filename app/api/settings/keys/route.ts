// ShapesOS — Phase 15.1: the workspace's own keys (Settings → Providers).
//   GET    /api/settings/keys            → { credentials, deployment } (admin+)
//   POST   /api/settings/keys {id, values} → validate + store      (admin+, audited)
//   DELETE /api/settings/keys?id=…       → remove                  (admin+, audited)
// Covers the workspace's own model keys (Anthropic / OpenAI — no AI credits),
// its own sidecar instances (Postiz, Listmonk, … — required on hosted) and
// its Smartlead / Instantly accounts. A secret is never returned or logged:
// the response carries only non-secret settings, who stored them and when.

import type { NextRequest } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { auditEvent } from "@/lib/auditlog";
import { deploymentMode } from "@/lib/billing/trial";
import { credentialDef } from "@/lib/providers/workspace-credentials";
import {
  CredentialInputError,
  deleteWorkspaceCredential,
  listWorkspaceCredentials,
  saveWorkspaceCredential,
} from "@/lib/providers/workspace-credentials-server";

export const dynamic = "force-dynamic";

async function admin(): Promise<{ error: Response } | { user: { id: string; email?: string | null }; workspace: { id: string } }> {
  const user = await requireUser();
  if (!user) return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "admin"))) return { error: forbidden() };
  return { user, workspace };
}

function inputError(e: unknown): Response {
  if (e instanceof CredentialInputError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
  // Never echo an unexpected error (it could carry request content).
  return Response.json({ error: "Could not save the key." }, { status: 500 });
}

export async function GET(): Promise<Response> {
  const ctx = await admin();
  if ("error" in ctx) return ctx.error;
  return Response.json({
    credentials: await listWorkspaceCredentials(ctx.workspace.id),
    deployment: deploymentMode(),
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const ctx = await admin();
  if ("error" in ctx) return ctx.error;
  let body: { id?: unknown; values?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id : "";
  const values = body.values && typeof body.values === "object" ? (body.values as Record<string, unknown>) : {};
  try {
    await saveWorkspaceCredential({ workspaceId: ctx.workspace.id, userId: ctx.user.id, id, values });
  } catch (e) {
    return inputError(e);
  }
  await auditEvent({
    projectId: null,
    workspaceId: ctx.workspace.id,
    action: "credential_created",
    summary: `Workspace key saved: ${credentialDef(id)?.label ?? id} (${id})`,
    actorUserId: ctx.user.id,
  });
  return Response.json({ ok: true, credentials: await listWorkspaceCredentials(ctx.workspace.id) });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const ctx = await admin();
  if ("error" in ctx) return ctx.error;
  const id = req.nextUrl.searchParams.get("id") ?? "";
  let removed: number;
  try {
    removed = await deleteWorkspaceCredential(ctx.workspace.id, id);
  } catch (e) {
    return inputError(e);
  }
  if (removed > 0) {
    await auditEvent({
      projectId: null,
      workspaceId: ctx.workspace.id,
      action: "credential_deleted",
      summary: `Workspace key removed: ${credentialDef(id)?.label ?? id} (${id})`,
      actorUserId: ctx.user.id,
    });
  }
  return Response.json({ ok: true, removed, credentials: await listWorkspaceCredentials(ctx.workspace.id) });
}
