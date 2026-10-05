// ShapesOS — SCIM provisioning tokens for this workspace (Phase 4a).
//
// GET  → { tokens, endpoint } (owner only)
// POST { name } → { token, raw } — the raw token is returned ONCE and never
//      stored (SHA-256 only). Owner only; audited.
// scim_tokens is FORCE RLS: every read/write runs in withWorkspaceScope.

import { BadRequestError, ForbiddenError, errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { readJsonBody } from "@/lib/sitefiles/api";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { auditEvent } from "@/lib/auditlog";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { mintScimToken } from "@/lib/scim/auth";
import { appBaseUrl } from "@/lib/workspace/invite-mail";

export const dynamic = "force-dynamic";

const MAX_ACTIVE_TOKENS = 10;

function view(t: { id: string; name: string; tokenPrefix: string; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null }) {
  return {
    id: t.id,
    name: t.name,
    tokenPrefix: t.tokenPrefix,
    createdAt: t.createdAt.toISOString(),
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    revokedAt: t.revokedAt?.toISOString() ?? null,
  };
}

async function ownerContext() {
  const user = await requireUser();
  if (!user) return null;
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "owner");
  if (!membership) throw new ForbiddenError("Only owners can manage SCIM provisioning.");
  return { user, workspace };
}

export async function GET(req: Request) {
  try {
    const ctx = await ownerContext();
    if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const tokens = await withWorkspaceScope(ctx.workspace.id, (tx) =>
      tx.scimToken.findMany({ where: { workspaceId: ctx.workspace.id }, orderBy: { createdAt: "desc" } }),
    );
    const base = appBaseUrl(process.env, new URL(req.url).origin) ?? new URL(req.url).origin;
    return Response.json({ tokens: tokens.map(view), endpoint: `${base}/api/scim/v2` });
  } catch (err) {
    return errorResponse(err, "GET /api/settings/security/scim-tokens");
  }
}

const Schema = z.object({ name: z.string().trim().min(1, "Name the token").max(80) });

export async function POST(req: Request) {
  try {
    const ctx = await ownerContext();
    if (!ctx) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const v = validateBody(Schema, await readJsonBody(req));
    if (!v.ok) return v.error;
    const minted = mintScimToken(ctx.workspace.id);
    const row = await withWorkspaceScope(ctx.workspace.id, async (tx) => {
      const active = await tx.scimToken.count({ where: { workspaceId: ctx.workspace.id, revokedAt: null } });
      if (active >= MAX_ACTIVE_TOKENS) throw new BadRequestError(`Revoke a token first (limit ${MAX_ACTIVE_TOKENS} active).`);
      return tx.scimToken.create({
        data: {
          workspaceId: ctx.workspace.id,
          name: v.data.name,
          tokenHash: minted.tokenHash,
          tokenPrefix: minted.tokenPrefix,
          createdBy: ctx.user.id,
        },
      });
    });
    await auditEvent({
      projectId: null,
      workspaceId: ctx.workspace.id,
      action: "scim_token_created",
      summary: `SCIM token "${row.name}" created (${row.tokenPrefix})`,
      actorUserId: ctx.user.id,
    });
    return Response.json({ token: view(row), raw: minted.raw }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/settings/security/scim-tokens");
  }
}
