// Marketr — MCP server authentication (Phase C, W5).
//
// Two bearer mechanisms, both deriving the tenant workspaceId server-side:
//   1. Workspace API keys: "mcpk_<32 hex chars>", SHA-256 hash stored.
//   2. OAuth 2.1 access tokens (DCR flow): "mcpt_<64 hex chars>", hash stored.
//
// Raw key/token material is NEVER persisted, logged, or returned after the
// one-time creation response. Comparisons are constant-time.
//
// Phase 1: every call re-checks the credential user's CURRENT membership
// (removed → denied; API key creator no longer admin → denied) and caps the
// scopes to that role.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { WorkspaceRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getMembership, roleAtLeast } from "@/lib/authz";
import { capScopesToRole } from "./scopes";

export const MCP_KEY_PREFIX = "mcpk_";
export const MCP_TOKEN_PREFIX = "mcpt_";

/** SHA-256 hex digest — the only form of key/token material we store. */
export function hashSecret(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Mint a new API key. Returns the raw key ONCE — the caller must show it and forget it. */
export function mintApiKey(): { raw: string; keyHash: string; keyPrefix: string } {
  const raw = `${MCP_KEY_PREFIX}${randomBytes(24).toString("hex")}`;
  return { raw, keyHash: hashSecret(raw), keyPrefix: raw.slice(0, MCP_KEY_PREFIX.length + 6) };
}

/** Mint a new OAuth access token (raw, once). */
export function mintAccessToken(): { raw: string; tokenHash: string } {
  const raw = `${MCP_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
  return { raw, tokenHash: hashSecret(raw) };
}

export interface McpAuthContext {
  workspaceId: string;
  /** For audit tenant tags: which credential authorized this call. */
  credential: { kind: "api_key"; keyId: string; keyPrefix: string } | { kind: "oauth"; clientId: string };
  scopes: string[];
  /** The user who owns the credential (for actor attribution). */
  userId: string;
}

export type McpAuthFailure =
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "malformed" }
  | { ok: false; reason: "unknown" }
  | { ok: false; reason: "revoked" }
  | { ok: false; reason: "expired" }
  | { ok: false; reason: "not_member" }
  | { ok: false; reason: "insufficient_role" };

/** Minimum CURRENT role of the credential's user, per credential kind. */
export const MCP_KEY_MIN_ROLE: WorkspaceRole = "admin";

/**
 * Phase 1: re-check the credential user's membership on EVERY call. A
 * removed member's keys/tokens stop working immediately; an API key stops
 * working once its creator is no longer an admin; scopes are capped to what
 * the user's current role allows (lib/mcp/scopes.ts TOOL_MIN_ROLE).
 */
async function withCurrentRole(
  ctx: McpAuthContext,
): Promise<{ ok: true; ctx: McpAuthContext } | McpAuthFailure> {
  const membership = await getMembership(ctx.userId, ctx.workspaceId);
  if (!membership) return { ok: false, reason: "not_member" };
  if (ctx.credential.kind === "api_key" && !roleAtLeast(membership.role, MCP_KEY_MIN_ROLE)) {
    return { ok: false, reason: "insufficient_role" };
  }
  return { ok: true, ctx: { ...ctx, scopes: capScopesToRole(ctx.scopes, membership.role) } };
}

/**
 * requireMcpAuth — the M11-recognized authorization primitive for MCP routes.
 * Resolves a Bearer credential to a tenant-scoped auth context, or null.
 * Detailed failure reasons stay server-side (generic "authentication failed"
 * goes to the client — see THREAT-MODEL-MCP.md T3).
 */
export async function requireMcpAuth(
  authorizationHeader: string | null,
): Promise<{ ok: true; ctx: McpAuthContext } | McpAuthFailure> {
  const resolved = await resolveCredential(authorizationHeader);
  if (!resolved.ok) return resolved;
  return withCurrentRole(resolved.ctx);
}

async function resolveCredential(
  authorizationHeader: string | null,
): Promise<{ ok: true; ctx: McpAuthContext } | McpAuthFailure> {
  if (!authorizationHeader) return { ok: false, reason: "missing" };
  const m = /^Bearer\s+(\S+)$/.exec(authorizationHeader.trim());
  if (!m) return { ok: false, reason: "malformed" };
  const raw = m[1];

  if (raw.startsWith(MCP_KEY_PREFIX)) {
    const keyHash = hashSecret(raw);
    const key = await prisma.mcpApiKey.findUnique({ where: { keyHash } });
    // Constant-time compare even on the found row: the unique lookup already
    // matched, but this keeps the comparison shape uniform.
    if (!key || !safeEqualHex(key.keyHash, keyHash)) return { ok: false, reason: "unknown" };
    if (key.revokedAt) return { ok: false, reason: "revoked" };
    if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };
    // Touch lastUsedAt best-effort (never blocks the call).
    prisma.mcpApiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
    return {
      ok: true,
      ctx: {
        workspaceId: key.workspaceId,
        credential: { kind: "api_key", keyId: key.id, keyPrefix: key.keyPrefix },
        scopes: key.scopes,
        userId: key.userId,
      },
    };
  }

  if (raw.startsWith(MCP_TOKEN_PREFIX)) {
    const tokenHash = hashSecret(raw);
    const token = await prisma.mcpOAuthToken.findUnique({ where: { tokenHash } });
    if (!token || !safeEqualHex(token.tokenHash, tokenHash)) return { ok: false, reason: "unknown" };
    if (token.expiresAt.getTime() <= Date.now()) {
      // Prune expired tokens opportunistically.
      prisma.mcpOAuthToken.delete({ where: { tokenHash } }).catch(() => {});
      return { ok: false, reason: "expired" };
    }
    return {
      ok: true,
      ctx: {
        workspaceId: token.workspaceId,
        credential: { kind: "oauth", clientId: token.clientId },
        scopes: token.scopes,
        userId: token.userId,
      },
    };
  }

  return { ok: false, reason: "malformed" };
}

/** Exact scope check — no wildcards, no prefix matching (T2). */
export function hasScope(ctx: McpAuthContext, tool: string): boolean {
  return ctx.scopes.includes(`tools:${tool}`);
}
