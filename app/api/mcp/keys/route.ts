// Marketr — MCP API key management (Phase C, W5). Admin+ only.
//
// GET  /api/mcp/keys → { enabled, keys: [{ id, name, keyPrefix, scopes, expiresAt, lastUsedAt, revokedAt, createdAt }] }
// POST /api/mcp/keys { name, scopes, expiresAt? } → { id, name, keyPrefix, scopes, key }
//        The raw key is returned ONCE — it is never stored and never retrievable.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { mintApiKey } from "@/lib/mcp/auth";
import { MCP_TOOL_NAMES, scopeForTool } from "@/lib/mcp/scopes";

export const dynamic = "force-dynamic";

function publicKey(k: {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: k.id,
    name: k.name,
    keyPrefix: k.keyPrefix,
    scopes: k.scopes,
    expiresAt: k.expiresAt?.toISOString() ?? null,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    revokedAt: k.revokedAt?.toISOString() ?? null,
    createdAt: k.createdAt.toISOString(),
  };
}

async function adminCtx() {
  const user = await requireUser();
  if (!user) return { error: Response.json({ error: "unauthorized" }, { status: 401 }) };
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!membership) return { error: forbidden() };
  return { user, workspace };
}

export async function GET() {
  const ctx = await adminCtx();
  if ("error" in ctx) return ctx.error;
  const keys = await prisma.mcpApiKey.findMany({
    where: { workspaceId: ctx.workspace.id },
    orderBy: { createdAt: "desc" },
  });
  return Response.json({ enabled: ctx.workspace.mcpEnabled, keys: keys.map(publicKey) });
}

const CreateKeySchema = z
  .object({
    name: z.string().min(1).max(80),
    scopes: z.array(z.string()).min(1).max(MCP_TOOL_NAMES.length),
    expiresAt: z.string().datetime({ offset: true }).optional().nullable(),
  })
  .strict();

export async function POST(req: NextRequest) {
  const ctx = await adminCtx();
  if ("error" in ctx) return ctx.error;
  if (!ctx.workspace.mcpEnabled) {
    return Response.json({ error: "MCP is not enabled for this workspace" }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = CreateKeySchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "invalid request" }, { status: 400 });
  const { name, scopes, expiresAt } = parsed.data;

  // Scopes must be exact known tool scopes — no wildcards, no extras.
  const validScopes = new Set(MCP_TOOL_NAMES.map(scopeForTool));
  const unique = [...new Set(scopes)];
  for (const s of unique) {
    if (!validScopes.has(s)) return Response.json({ error: `unknown scope: ${s}` }, { status: 400 });
  }
  let expires: Date | null = null;
  if (expiresAt) {
    expires = new Date(expiresAt);
    if (Number.isNaN(expires.getTime()) || expires.getTime() <= Date.now()) {
      return Response.json({ error: "expiresAt must be a future datetime" }, { status: 400 });
    }
  }

  const { raw, keyHash, keyPrefix } = mintApiKey();
  const row = await prisma.mcpApiKey.create({
    data: {
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      name,
      keyHash,
      keyPrefix,
      scopes: unique,
      expiresAt: expires,
    },
  });
  await prisma.fileChangeLog
    .create({
      data: {
        projectId: null,
        workspaceId: ctx.workspace.id,
        filePath: "mcp:mcp_key_created",
        actor: "user",
        action: "mcp_key_created",
        summary: `[mcp] api key created name="${name}" scopes=${unique.join(",")} keyId=${row.id}`.slice(0, 500),
        approvedBy: ctx.user.id,
      },
    })
    .catch(() => {});
  // The raw key appears here ONCE and is never stored (T3).
  return Response.json({ ...publicKey(row), key: raw }, { status: 201 });
}
