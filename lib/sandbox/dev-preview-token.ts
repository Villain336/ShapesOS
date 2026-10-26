// ShapesOS — dev-preview capability tokens (v2, server-stored).
//
// Replaces the v1 ambient capability cookie (deleted): the bearer is an
// UNGUESSABLE URL segment, not a SameSite=None cookie, so no ambient
// authority rides cross-site requests and no credentialed CORS is needed.
//
// Storage model (per independent security review, 2026-10-26):
//  - tokenHash (sha256, unique): the ONLY thing request verification reads.
//    A database read alone yields no usable token.
//  - tokenEnc (lib/secrets envelope): lets the authenticated status endpoint
//    re-serve the SAME raw token to its OWNING session, so a live pane's
//    iframe src never changes for renewal (no silent state-losing reload).
//    Recovering raws needs DB + the app secrets key - the same exposure the
//    codebase already accepts for provider traffic secrets.
//
// Expiry model:
//  - Sliding TTL (1h) extended ONLY by the owning session's status poll.
//    Bearer/asset requests NEVER extend it: a leaked token dies at its
//    current expiry no matter how much the attacker uses it.
//  - Absolute cap (24h from createdAt), never slidable: past it the status
//    endpoint mints a fresh token even mid-session.
//  - A leaked bearer therefore works until the EARLIEST of: the owner stops
//    polling + 1h; the issuer's membership is revoked (re-checked CURRENT on
//    every bearer request - uncached); sandbox generation change; the 24h cap.
//  - Browser background-tab throttling can pause the renewal poll; the 1h TTL
//    absorbs it, and a lapsed token fails safe (401 -> the panel shows an
//    explicit reload affordance, never a silent iframe src swap).

import { createHash, randomBytes } from "node:crypto";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

export const DEV_PREVIEW_TOKEN_TTL_MS = 60 * 60 * 1000;
export const DEV_PREVIEW_TOKEN_MAX_LIFE_MS = 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32; // 256-bit, base64url -> 43 chars

export function hashDevPreviewToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface VerifiedPreviewToken {
  userId: string;
  workspaceId: string;
  projectId: string;
  port: number;
  sandboxId: string;
}

/**
 * Verify a bearer token for THIS project+port. NEVER extends expiry.
 * Returns null on any mismatch - fail closed. Membership, project workspace
 * binding and sandbox generation are re-checked by the CALLER (route), with
 * current data, on every request.
 */
export async function verifyDevPreviewToken(
  workspaceId: string,
  raw: string,
  projectId: string,
  port: number,
  now: Date = new Date(),
): Promise<VerifiedPreviewToken | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  // Scoped: the table is FORCE-RLS; outside a workspace scope every query
  // sees zero rows (fail closed). NEVER extends expiry.
  return withWorkspaceScope(workspaceId, async (tx) => {
    const row = await tx.projectDevPreviewToken.findUnique({ where: { tokenHash: hashDevPreviewToken(raw), workspaceId } });
    if (!row || row.revokedAt) return null;
    if (row.expiresAt.getTime() <= now.getTime()) return null;
    if (row.createdAt.getTime() + DEV_PREVIEW_TOKEN_MAX_LIFE_MS <= now.getTime()) return null;
    if (row.projectId !== projectId || row.port !== port) return null;
    return { userId: row.userId, workspaceId: row.workspaceId, projectId: row.projectId, port: row.port, sandboxId: row.sandboxId };
  });
}

export interface IssuedPreviewToken {
  raw: string;
  expiresAt: Date;
  /** false when a fresh token was minted (a src swap decision point). */
  reused: boolean;
}

/**
 * Idempotent issue-or-renew for the OWNING SESSION (status endpoint only):
 * returns the user's live token for (user, project, port, sandbox generation)
 * when one exists and is inside its absolute lifetime, extending its sliding
 * expiry; otherwise mints a fresh one. This is the ONLY place expiry moves.
 */
export async function issueOrRenewDevPreviewToken(
  input: { workspaceId: string; projectId: string; port: number; sandboxId: string; userId: string },
  now: Date = new Date(),
): Promise<IssuedPreviewToken | null> {
  const { workspaceId, projectId, port, sandboxId, userId } = input;
  const expiresAt = new Date(now.getTime() + DEV_PREVIEW_TOKEN_TTL_MS);
  return withWorkspaceScope(workspaceId, async (tx) => {
    const live = await tx.projectDevPreviewToken.findFirst({
      where: {
        workspaceId, projectId, port, sandboxId, userId,
        revokedAt: null,
        expiresAt: { gt: now },
        createdAt: { gt: new Date(now.getTime() - DEV_PREVIEW_TOKEN_MAX_LIFE_MS) },
      },
      orderBy: { createdAt: "desc" },
    });
    if (live) {
      try {
        const { secrets } = await import("@/lib/secrets");
        const raw = secrets().decrypt(live.tokenEnc);
        await tx.projectDevPreviewToken.update({
          where: { id: live.id, workspaceId },
          data: { expiresAt, lastRenewedAt: now },
        });
        return { raw, expiresAt, reused: true };
      } catch {
        // Undecryptable row (key rotation, corruption): revoke and re-mint.
        await tx.projectDevPreviewToken.update({ where: { id: live.id, workspaceId }, data: { revokedAt: now } });
      }
    }
    const raw = randomBytes(TOKEN_BYTES).toString("base64url");
    const { secrets } = await import("@/lib/secrets");
    await tx.projectDevPreviewToken.create({
      data: {
        workspaceId, projectId, port, sandboxId, userId,
        tokenHash: hashDevPreviewToken(raw),
        tokenEnc: secrets().encrypt(raw),
        expiresAt,
      },
    });
    return { raw, expiresAt, reused: false };
  });
}

/** Grace after expiry/revocation before rows are deleted (forensics window). */
export const DEV_PREVIEW_TOKEN_PRUNE_GRACE_MS = 24 * 60 * 60 * 1000;

/** Delete rows past the grace window (cron hygiene). Expiry/revocation
 * already kills the bearer; this only bounds table growth. */
export async function pruneDevPreviewTokens(workspaceId: string, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - DEV_PREVIEW_TOKEN_PRUNE_GRACE_MS);
  return withWorkspaceScope(workspaceId, async (tx) => {
    const r = await tx.projectDevPreviewToken.deleteMany({
      where: { workspaceId, OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
    });
    return r.count;
  });
}

/** Revoke every live token for a sandbox generation (pause/destroy). */
export async function revokeDevPreviewTokens(workspaceId: string, projectId: string, now: Date = new Date()): Promise<void> {
  await withWorkspaceScope(workspaceId, async (tx) => {
    await tx.projectDevPreviewToken.updateMany({
      where: { workspaceId, projectId, revokedAt: null },
      data: { revokedAt: now },
    });
  });
}
