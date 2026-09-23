// Marketr — OAuth 2.1 consent decision endpoint (Phase C, W5; G3 workspace picker).
//
// POST /api/mcp/oauth/consent { grant, decision, workspaceId? }
//
// PUBLIC BY DESIGN (capability model): the caller must present BOTH a valid
// signed-in session AND the AES-256-GCM-sealed grant token minted by the
// authorize endpoint.
//
// Three decisions:
//   "select"  — bind the approver's chosen workspace into a re-sealed grant.
//               The posted workspaceId is membership-checked against a fresh
//               DB query — never trusted blind (T14).
//   "approve" — consume a workspace-bound grant: decrypt (tamper →
//               invalid_grant, fail closed, T15), re-check membership (T14),
//               enforce mcpEnabled (T8), mint the code for exactly the sealed
//               workspace.
//   "deny"    — redirect with access_denied (works with either grant shape).

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import {
  bindWorkspaceToGrant,
  approveWorkspaceBoundGrant,
  decryptGrantForDeny,
} from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "authentication required" }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const grant = typeof b.grant === "string" ? b.grant : null;
  const decision = b.decision;
  if (!grant) return Response.json({ error: "invalid_grant" }, { status: 400 });

  if (decision === "select") {
    const workspaceId = typeof b.workspaceId === "string" ? b.workspaceId : "";
    const bound = await bindWorkspaceToGrant(grant, user.id, workspaceId);
    if (!bound.ok) {
      const status = bound.error === "invalid_grant" || bound.error === "workspaceId is required" ? 400 : 403;
      return Response.json({ error: bound.error }, { status });
    }
    return Response.json({ grant: bound.grant });
  }

  if (decision === "approve") {
    const res = await approveWorkspaceBoundGrant(grant, user.id);
    if (!res.ok) return Response.json({ error: res.error }, { status: res.status });
    const url = new URL(res.redirectUri);
    url.searchParams.set("code", res.code);
    if (res.state) url.searchParams.set("state", res.state);
    return Response.json({ redirect: url.toString() });
  }

  if (decision === "deny") {
    const denied = decryptGrantForDeny(grant);
    if (!denied) return Response.json({ error: "invalid_grant" }, { status: 400 });
    const url = new URL(denied.redirectUri);
    url.searchParams.set("error", "access_denied");
    if (denied.state) url.searchParams.set("state", denied.state);
    return Response.json({ redirect: url.toString() });
  }

  return Response.json({ error: "invalid decision" }, { status: 400 });
}
