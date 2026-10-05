// ShapesOS — Phase 15.1: re-check a saved workspace key.
//   POST /api/settings/keys/test { id } → { ok, message } (admin+)
// A model key is checked with one free provider call; a sidecar URL with the
// SSRF check and one request. The key itself never leaves the server.

import type { NextRequest } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { CredentialInputError, testWorkspaceCredential } from "@/lib/providers/workspace-credentials-server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "admin"))) return forbidden();
  let body: { id?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const result = await testWorkspaceCredential(workspace.id, typeof body.id === "string" ? body.id : "");
    return Response.json(result);
  } catch (e) {
    if (e instanceof CredentialInputError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    return Response.json({ error: "Could not test the key." }, { status: 500 });
  }
}
