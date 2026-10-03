// Marketr — MCP OAuth 2.1 + Dynamic Client Registration (Phase C, W5).
//
// Standard flow, no external provider:
//   POST /api/mcp/oauth/register   (RFC 7591 DCR — pre-auth, strictly rate-limited)
//   GET  /api/mcp/oauth/authorize  (signed-in user → consent screen)
//   POST /api/mcp/oauth/token      (code exchange + PKCE S256, pre-auth rate-limited)
//
// Security properties (THREAT-MODEL-MCP.md T5/T6/T7):
// - redirect_uris validated at registration AND exact-matched at authorize time.
// - codes: single-use (transactional), 10-min expiry, bound to client_id +
//   exact redirect_uri, S256 PKCE required.
// - tokens: 256-bit random, SHA-256 stored, 1-hour expiry, bound to one
//   workspaceId + scope set. No refresh tokens in v1.
// - the consent screen renders the server-stored requested scope set; the
//   consent POST can only approve/deny that stored set.
// - Phase 1: only editor+ of the chosen workspace can approve; the code is
//   capped to the scopes the approver's role allows (TOOL_MIN_ROLE), and
//   lib/mcp/auth.ts re-checks membership + re-caps on every call.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { WorkspaceRole } from "@prisma/client";
import { secrets } from "@/lib/secrets";
import { getMembership, roleAtLeast } from "@/lib/authz";
import { capScopesToRole, isKnownScope } from "./scopes";
import { mintAccessToken } from "./auth";

export const OAUTH_CODE_TTL_MS = 10 * 60_000;
export const OAUTH_TOKEN_TTL_MS = 60 * 60_000;

/** RFC 7591 client metadata (subset we accept). */
export interface DcrRequest {
  redirect_uris: string[];
  client_name?: string;
  scope?: string;
}

/**
 * Validate a redirect URI for registration (T5).
 * https required; http allowed ONLY for loopback (RFC 8252).
 * No fragments, no userinfo, no non-loopback IPs.
 */
export function validateRedirectUri(raw: string): { ok: true } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (u.hash) return { ok: false, reason: "fragments not allowed" };
  if (u.username || u.password) return { ok: false, reason: "userinfo not allowed" };
  const host = u.hostname.toLowerCase();
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (u.protocol === "http:") {
    if (!isLoopback) return { ok: false, reason: "http only allowed for loopback" };
  } else if (u.protocol !== "https:") {
    return { ok: false, reason: "only https (or http loopback) allowed" };
  }
  // Reject non-loopback IP literals (avoid DNS-rebinding-shaped registrations).
  const isIp = /^[0-9.]+$/.test(host) || host.includes(":");
  if (isIp && !isLoopback) return { ok: false, reason: "IP literals not allowed" };
  return { ok: true };
}

/** Parse + validate a space-separated scope string; unknown scopes rejected. */
export function parseScopes(scopeParam: string | undefined): { ok: true; scopes: string[] } | { ok: false; reason: string } {
  const parts = (scopeParam ?? "").split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { ok: false, reason: "at least one scope is required" };
  const unique = [...new Set(parts)];
  for (const s of unique) {
    if (!isKnownScope(s)) return { ok: false, reason: `unknown scope: ${s}` };
  }
  return { ok: true, scopes: unique };
}

/** Register a DCR client. Returns the client record (RFC 7591 response shape). */
/**
 * Dynamic Client Registration (RFC 7591) is intentionally PUBLIC: no session
 * is required. Registration creates an opaque client id, stores redirect URIs,
 * and binds NOTHING — no workspace, no token, no secret. The dangerous steps
 * (code issuance, token minting) happen only after the signed-in user's
 * explicit consent, and codes go only to the exact registered redirect_uri.
 */
export async function registerClient(req: DcrRequest, userId: string | null): Promise<
  | { ok: true; client: { client_id: string; client_name?: string; redirect_uris: string[]; scope: string } }
  | { ok: false; status: number; error: string }
> {
  if (!Array.isArray(req.redirect_uris) || req.redirect_uris.length === 0) {
    return { ok: false, status: 400, error: "redirect_uris is required" };
  }
  for (const uri of req.redirect_uris) {
    const v = validateRedirectUri(String(uri));
    if (!v.ok) return { ok: false, status: 400, error: `invalid redirect_uri: ${v.reason}` };
  }
  const scopeCheck = parseScopes(req.scope);
  // Scope may be omitted at registration; it is requested at authorize time.
  const requestedScopes = req.scope == null ? [] : scopeCheck.ok ? scopeCheck.scopes : null;
  if (requestedScopes === null) return { ok: false, status: 400, error: (scopeCheck as { reason: string }).reason };

  const clientId = `mcpc_${randomBytes(16).toString("hex")}`;
  await prisma.mcpOAuthClient.create({
    data: {
      clientId,
      userId,
      clientName: typeof req.client_name === "string" ? req.client_name.slice(0, 120) : null,
      redirectUris: req.redirect_uris.map(String),
    },
  });
  return {
    ok: true,
    client: {
      client_id: clientId,
      client_name: typeof req.client_name === "string" ? req.client_name.slice(0, 120) : undefined,
      redirect_uris: req.redirect_uris.map(String),
      scope: requestedScopes.join(" "),
    },
  };
}

/** Pending authorization (stored server-side between authorize GET and consent POST — T7). */
export interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  /**
   * Bound by the workspace-picker step (G3): the workspace the approver chose
   * on the consent screen, sealed into the grant. Absent on grants sealed by
   * the authorize endpoint before the picker step.
   */
  workspaceId?: string;
}

/** Begin the authorize flow: validate everything, return the pending record for the consent screen. */
export async function beginAuthorize(params: {
  clientId: string;
  redirectUri: string;
  scope?: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  responseType?: string;
}): Promise<{ ok: true; pending: PendingAuthorization; clientName: string | null } | { ok: false; error: string }> {
  if (params.responseType && params.responseType !== "code") {
    return { ok: false, error: "only response_type=code is supported" };
  }
  const client = await prisma.mcpOAuthClient.findUnique({ where: { clientId: params.clientId } });
  if (!client) return { ok: false, error: "unknown client_id" };
  // Exact match against a registered URI — never redirect to an unregistered one (T5).
  if (!client.redirectUris.includes(params.redirectUri)) {
    return { ok: false, error: "redirect_uri does not match a registered URI" };
  }
  const scopeCheck = parseScopes(params.scope);
  if (!scopeCheck.ok) return { ok: false, error: scopeCheck.reason };
  if (params.codeChallenge && params.codeChallengeMethod && params.codeChallengeMethod !== "S256") {
    return { ok: false, error: "only S256 code_challenge_method is supported" };
  }
  return {
    ok: true,
    clientName: client.clientName,
    pending: {
      clientId: client.clientId,
      redirectUri: params.redirectUri,
      scopes: scopeCheck.scopes,
      state: params.state,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
    },
  };
}

/**
 * Approve the pending authorization: mint a single-use code bound to the
 * client, redirect URI, workspace, and the SERVER-STORED scope set (T7).
 * The workspace is bound here from the approving user's workspace — the
 * token's tenant can never come from client input (T1).
 */
export async function approveAuthorization(
  pending: PendingAuthorization,
  userId: string,
  workspaceId: string,
): Promise<{ code: string; redirectUri: string; state?: string; scopes: string[] }> {
  // Phase 1: editor+ only, and the code carries no scope above the
  // approver's role (lib/mcp/scopes.ts TOOL_MIN_ROLE). Checked here too so
  // every caller of this primitive is covered.
  const gate = await consentGate(userId, workspaceId);
  if (!gate.ok) throw new Error(gate.error);
  const scopes = capScopesToRole(pending.scopes, gate.role);
  if (scopes.length === 0) throw new Error("no_permitted_scopes");

  // Ownership claim (T6b): the first approver owns the client. A public DCR
  // client starts unowned (userId null); whoever approves first claims it.
  // A different user can never steal a claimed client.
  const client = await prisma.mcpOAuthClient.findUnique({ where: { clientId: pending.clientId } });
  if (!client) throw new Error("unknown client");
  if (client.userId !== null && client.userId !== userId) {
    throw new Error("client owned by another user");
  }
  if (client.userId === null) {
    const claimed = await prisma.mcpOAuthClient.updateMany({
      where: { clientId: pending.clientId, userId: null },
      data: { userId, workspaceId },
    });
    if (claimed.count !== 1) throw new Error("client claimed concurrently");
  } else {
    await prisma.mcpOAuthClient.update({ where: { clientId: pending.clientId }, data: { workspaceId } });
  }

  const code = randomBytes(32).toString("hex");
  await prisma.mcpOAuthCode.create({
    data: {
      code,
      clientId: pending.clientId,
      userId,
      workspaceId,
      redirectUri: pending.redirectUri,
      scopes,
      codeChallenge: pending.codeChallenge ?? null,
      expiresAt: new Date(Date.now() + OAUTH_CODE_TTL_MS),
    },
  });
  await prisma.fileChangeLog
    .create({
      data: {
        projectId: null,
        workspaceId,
        filePath: "mcp:mcp_oauth_authorized",
        actor: "user",
        action: "mcp_oauth_authorized",
        summary: `[mcp] oauth authorized client=${pending.clientId} scopes=${scopes.join(",")} workspace=${workspaceId}`.slice(0, 500),
        approvedBy: userId,
      },
    })
    .catch(() => {});
  return { code, redirectUri: pending.redirectUri, state: pending.state, scopes };
}

function base64UrlDecode(input: string): Buffer {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}

/**
 * Exchange an authorization code for an access token.
 * Single-use enforced RACE-SAFELY (T6): the code row is claimed with a
 * conditional update (used=false AND unexpired). Two concurrent exchanges
 * race on that single atomic statement — exactly one wins.
 */
export async function exchangeCode(params: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier?: string;
}): Promise<
  | { ok: true; token: { access_token: string; token_type: "Bearer"; expires_in: number; scope: string } }
  | { ok: false; status: number; error: string }
> {
  const row = await prisma.mcpOAuthCode.findUnique({ where: { code: params.code } });
  if (!row) return { ok: false, status: 400, error: "invalid code" };
  if (row.clientId !== params.clientId) return { ok: false, status: 400, error: "client mismatch" };
  if (row.redirectUri !== params.redirectUri) return { ok: false, status: 400, error: "redirect_uri mismatch" };
  // PKCE verification when a challenge was registered.
  if (row.codeChallenge) {
    if (!params.codeVerifier) return { ok: false, status: 400, error: "code_verifier required" };
    const expected = createHash("sha256").update(params.codeVerifier, "utf8").digest();
    const provided = base64UrlDecode(row.codeChallenge);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      return { ok: false, status: 400, error: "PKCE verification failed" };
    }
  }

  // Atomic single-use claim: only one concurrent exchange can flip used=false→true.
  const claimed = await prisma.mcpOAuthCode.updateMany({
    where: { code: row.code, used: false, expiresAt: { gt: new Date() } },
    data: { used: true },
  });
  if (claimed.count !== 1) {
    return row.used || row.expiresAt.getTime() <= Date.now()
      ? { ok: false, status: 400, error: "code already used" }
      : { ok: false, status: 400, error: "code expired" };
  }

  const { raw, tokenHash } = mintAccessToken();
  await prisma.mcpOAuthToken.create({
    data: {
      tokenHash,
      clientId: row.clientId,
      userId: row.userId,
      workspaceId: row.workspaceId,
      scopes: row.scopes,
      expiresAt: new Date(Date.now() + OAUTH_TOKEN_TTL_MS),
    },
  });
  return {
    ok: true,
    token: {
      access_token: raw,
      token_type: "Bearer",
      expires_in: Math.floor(OAUTH_TOKEN_TTL_MS / 1000),
      scope: row.scopes.join(" "),
    },
  };
}

/* ── Workspace picker (G3) ────────────────────────────────────────────────
 * The consent screen lets the approver choose which of THEIR workspaces the
 * OAuth token binds to (previously: the approver's default workspace).
 *
 * Two-step, both server-verified (T14/T15):
 *   1. select: POST { grant, decision: "select", workspaceId } — the posted
 *      id is checked against a FRESH membership query; on success the pending
 *      authorization is RE-SEALED with workspaceId bound inside.
 *   2. approve: POST { grant: <re-sealed>, decision: "approve" } — the grant
 *      is decrypted (AES-GCM: any tamper → invalid_grant, fail closed), the
 *      sealed workspaceId is membership-checked AGAIN (the user may have been
 *      removed between steps), mcpEnabled is checked, then the code is
 *      minted for exactly that workspace.
 */

/** Fresh workspace ids the user can access (owner OR member) — never cached across the check. */
export async function userWorkspaceIds(userId: string): Promise<string[]> {
  const rows = await prisma.workspace.findMany({
    where: { OR: [{ ownerUserId: userId }, { members: { some: { userId } } }] },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Minimum role to approve an MCP OAuth client for a workspace (Phase 1). */
export const MCP_CONSENT_MIN_ROLE: WorkspaceRole = "editor";

/**
 * Fresh membership + role check for consent (T14 + Phase 1): the approver
 * must be an editor+ of the workspace the token will bind to — a viewer
 * could otherwise mint a token that fires flows and burns credits.
 */
export async function consentGate(
  userId: string,
  workspaceId: string,
): Promise<{ ok: true; role: WorkspaceRole } | { ok: false; error: "workspace_not_accessible" | "insufficient_role" }> {
  const membership = await getMembership(userId, workspaceId);
  if (!membership) return { ok: false, error: "workspace_not_accessible" };
  if (!roleAtLeast(membership.role, MCP_CONSENT_MIN_ROLE)) return { ok: false, error: "insufficient_role" };
  return { ok: true, role: membership.role };
}

function decryptPending(grant: string): PendingAuthorization | null {
  try {
    const pending = JSON.parse(secrets().decrypt(grant)) as PendingAuthorization;
    if (!pending || typeof pending.clientId !== "string" || typeof pending.redirectUri !== "string") return null;
    if (!Array.isArray(pending.scopes)) return null;
    return pending;
  } catch {
    return null;
  }
}

/**
 * Step 1 — bind the approver's chosen workspace into a re-sealed grant.
 * The posted workspaceId is NEVER trusted without a membership check (T14).
 */
export async function bindWorkspaceToGrant(
  grant: string,
  userId: string,
  workspaceId: string,
): Promise<{ ok: true; grant: string } | { ok: false; error: string }> {
  const pending = decryptPending(grant);
  if (!pending) return { ok: false, error: "invalid_grant" };
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    return { ok: false, error: "workspaceId is required" };
  }
  // Re-validate against current DB state (client may have been deleted).
  const client = await prisma.mcpOAuthClient.findUnique({ where: { clientId: pending.clientId } });
  if (!client) return { ok: false, error: "unknown client" };
  const gate = await consentGate(userId, workspaceId);
  if (!gate.ok) return { ok: false, error: gate.error };
  const resealed = secrets().encrypt(JSON.stringify({ ...pending, workspaceId }));
  return { ok: true, grant: resealed };
}

export type ApproveBoundResult =
  | { ok: true; code: string; redirectUri: string; state?: string }
  | { ok: false; status: number; error: string };

/**
 * Step 2 — approve a workspace-bound grant and mint the code.
 * A tampered grant (workspace swapped post-seal) fails closed at decrypt
 * (T15); membership is re-checked fresh (T14); mcpEnabled is enforced (T8).
 */
export async function approveWorkspaceBoundGrant(grant: string, userId: string): Promise<ApproveBoundResult> {
  const pending = decryptPending(grant);
  if (!pending) return { ok: false, status: 400, error: "invalid_grant" };
  const workspaceId = pending.workspaceId;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    return { ok: false, status: 400, error: "workspace_not_selected" };
  }
  const gate = await consentGate(userId, workspaceId);
  if (!gate.ok) return { ok: false, status: 403, error: gate.error };
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { mcpEnabled: true } });
  if (!ws?.mcpEnabled) {
    return { ok: false, status: 403, error: "MCP is not enabled for this workspace" };
  }
  try {
    const { code, redirectUri, state } = await approveAuthorization(pending, userId, workspaceId);
    return { ok: true, code, redirectUri, state };
  } catch (e) {
    return { ok: false, status: 403, error: e instanceof Error ? e.message : "authorization failed" };
  }
}

/** Decrypt a grant for the deny path (needs only redirectUri/state). */
export function decryptGrantForDeny(grant: string): { redirectUri: string; state?: string } | null {
  const pending = decryptPending(grant);
  if (!pending) return null;
  return { redirectUri: pending.redirectUri, state: pending.state };
}
