// Marketr — OAuth 2.1 consent decision endpoint (Phase C, W5).
//
// POST /api/mcp/oauth/consent { grant, decision: "approve"|"deny" }
//
// PUBLIC BY DESIGN (capability model): the caller must present BOTH a valid
// signed-in session AND the AES-256-GCM-sealed grant token minted by the
// authorize endpoint. The grant is opaque and tamper-proof; the minted code
// carries exactly the scopes sealed inside it — the consent POST cannot
// widen them (T7). The token's workspace is bound here from the approving
// user's workspace (T1).

import type { NextRequest } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { approveAuthorization, beginAuthorize, type PendingAuthorization } from "@/lib/mcp/oauth";
import { secrets } from "@/lib/secrets";

export const dynamic = "force-dynamic";

function decryptGrant(grant: string): PendingAuthorization | null {
  try {
    const pending = JSON.parse(secrets().decrypt(grant)) as PendingAuthorization;
    if (!pending || typeof pending.clientId !== "string" || typeof pending.redirectUri !== "string") return null;
    return pending;
  } catch {
    return null;
  }
}

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
  const pending = typeof b.grant === "string" ? decryptGrant(b.grant) : null;
  if (!pending) return Response.json({ error: "invalid_grant" }, { status: 400 });

  // Re-validate against current DB state (client may have been deleted).
  const recheck = await beginAuthorize({
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    scope: pending.scopes.join(" "),
    state: pending.state,
    codeChallenge: pending.codeChallenge,
    codeChallengeMethod: pending.codeChallengeMethod,
    responseType: "code",
  });
  if (!recheck.ok) return Response.json({ error: recheck.error }, { status: 400 });

  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const decision = b.decision === "approve" ? "approve" : "deny";
  if (decision === "deny") {
    const url = new URL(pending.redirectUri);
    url.searchParams.set("error", "access_denied");
    if (pending.state) url.searchParams.set("state", pending.state);
    return Response.json({ redirect: url.toString() });
  }
  // MCP must be enabled for the workspace before any token is minted (T8).
  const ws = await (await import("@/lib/prisma")).prisma.workspace.findUnique({
    where: { id: workspace.id },
    select: { mcpEnabled: true },
  });
  if (!ws?.mcpEnabled) {
    return Response.json({ error: "MCP is not enabled for this workspace" }, { status: 403 });
  }
  let code: string, redirectUri: string, state: string | undefined;
  try {
    ({ code, redirectUri, state } = await approveAuthorization(pending, user.id, workspace.id));
  } catch (e) {
    // Ownership claim failed (e.g. another user claimed this public client first).
    return Response.json({ error: e instanceof Error ? e.message : "authorization failed" }, { status: 403 });
  }
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  return Response.json({ redirect: url.toString() });
}
