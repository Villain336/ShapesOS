// ShapesOS — SCIM 2.0 bearer tokens (Phase 4a).
//
// One token = one workspace. Raw form: "scim_<workspaceId>_<48 hex chars>"
// (192 random bits). Only a SHA-256 of the raw token is stored; the raw token
// is shown once to the owner who creates it.
//
// The workspace id inside the token is NOT trusted on its own: it only picks
// the RLS scope (app.workspace_id) the hash lookup runs in. scim_tokens is
// FORCE RLS, so a token naming workspace B can only ever match B's rows — and
// a hash minted for A never exists in B's scope. Every SCIM handler then works
// strictly inside the authenticated workspace.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { ScimError } from "./http";
import { hasEntitlement } from "@/lib/billing/entitlements-server";
import { featureUpgradeMessage } from "@/lib/billing/entitlements";

export const SCIM_TOKEN_PREFIX = "scim_";
const TOKEN_RE = /^scim_([A-Za-z0-9-]{1,120})_([0-9a-f]{48})$/;

export interface ScimContext {
  workspaceId: string;
  tokenId: string;
}

export function hashScimToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Mint a token for a workspace. Returns the raw token ONCE. */
export function mintScimToken(workspaceId: string): { raw: string; tokenHash: string; tokenPrefix: string } {
  if (!/^[A-Za-z0-9-]{1,120}$/.test(workspaceId)) throw new Error("Unsupported workspace id for a SCIM token");
  const raw = `${SCIM_TOKEN_PREFIX}${workspaceId}_${randomBytes(24).toString("hex")}`;
  return { raw, tokenHash: hashScimToken(raw), tokenPrefix: `${raw.slice(0, SCIM_TOKEN_PREFIX.length + 4)}…${raw.slice(-4)}` };
}

/** The workspace a well-formed token names (unverified), or null. */
export function parseScimToken(raw: string): { workspaceId: string } | null {
  const m = TOKEN_RE.exec(raw);
  return m ? { workspaceId: m[1] } : null;
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1] : null;
}

const LAST_USED_RESOLUTION_MS = 60_000;

/**
 * Authenticate a SCIM request. Throws ScimError(401) on any failure —
 * missing, malformed, unknown, revoked: the same answer for all of them.
 */
export async function requireScimAuth(req: Request): Promise<ScimContext> {
  const raw = bearer(req);
  const parsed = raw ? parseScimToken(raw) : null;
  if (!raw || !parsed) throw new ScimError(401, "A valid SCIM bearer token is required.");
  const hash = hashScimToken(raw);
  const row = await withWorkspaceScope(parsed.workspaceId, async (tx) => {
    const t = await tx.scimToken.findFirst({ where: { tokenHash: hash, workspaceId: parsed.workspaceId } });
    if (!t || t.revokedAt || t.workspaceId !== parsed.workspaceId) return null;
    const a = Buffer.from(t.tokenHash, "hex");
    const b = Buffer.from(hash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    if (!t.lastUsedAt || Date.now() - t.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
      await tx.scimToken.update({ where: { id: t.id, workspaceId: t.workspaceId }, data: { lastUsedAt: new Date() } });
    }
    return t;
  });
  if (!row) throw new ScimError(401, "A valid SCIM bearer token is required.");
  // Phase 15.3 (pricing): SCIM is a plan feature (Business, Agency,
  // self-hosted). A valid token on a workspace that moved to a plan without
  // it stops provisioning (403, RFC 7644 error body) until the plan includes
  // it again — the token itself is kept so nothing has to be re-issued.
  if (!(await hasEntitlement(row.workspaceId, "scim"))) {
    throw new ScimError(403, featureUpgradeMessage("scim"));
  }
  return { workspaceId: row.workspaceId, tokenId: row.id };
}
