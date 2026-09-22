// Marketr — workspace invite acceptance (day-1 hardening, M5).
// POST /api/workspace/invites/accept { token } → { ok, workspaceId, role }
//
// Invites are single-use token links. The token is the capability; the
// invite's email must additionally match the claimant's sign-in email so a
// leaked token can't be sprayed across accounts. Expired or already-claimed
// tokens are rejected. Acceptance is audit-logged in lib/authz.

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { claimInviteToken } from "@/lib/authz";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let token = "";
  try {
    const body = (await req.json()) as { token?: unknown };
    token = typeof body.token === "string" ? body.token : "";
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  if (!token.trim()) return Response.json({ error: "Invite token is required." }, { status: 400 });

  const member = await claimInviteToken(user.id, user.email ?? "", token);
  if (!member) {
    return Response.json(
      { error: "This invite link is invalid, expired, or was already used." },
      { status: 404 },
    );
  }
  const workspace = await prisma.workspace.findUnique({
    where: { id: member.workspaceId },
    select: { id: true, name: true },
  });
  return Response.json({
    ok: true,
    workspaceId: member.workspaceId,
    workspaceName: workspace?.name ?? null,
    role: member.role,
  });
}
