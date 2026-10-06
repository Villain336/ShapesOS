// ShapesOS — Phase 18.3 (WS=trust): the session registry, server half.
//
//   startUserSession()      a sign-in completed → one row, its id becomes token.sid
//   checkUserSession()      every session read (auth.ts jwt callback): is this
//                           token's session still honoured? touches last_seen
//                           at most every SESSION_TOUCH_MS
//   listUserSessions()      Settings → You → Privacy
//   revokeUserSession()     sign one session out (audited)
//   revokeOtherSessions()   sign every other session out (audited), including
//                           tokens minted before the registry (cutoff row)
//
// user_sessions is FORCE RLS on app.user_id: every statement here runs in a
// transaction that sets the GUC to the token's OWN subject, so one person can
// never read or revoke another's sessions — the routes never take a user id
// from the request. Failure policy: a database error while CHECKING allows
// the token (an outage must not sign the whole company out; revocation is
// re-checked on the next request), a revoked answer is cached for good.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { USER_GUC } from "@/lib/desktop/scope";
import {
  deviceLabel,
  ipPrefix,
  legacyRowId,
  LEGACY_ROW_PREFIX,
  sessionClaimDecision,
  shouldTouch,
  type ClaimDecision,
  type SessionRowState,
} from "./session-registry";

type Tx = Prisma.TransactionClient;

/** Run fn with app.user_id = userId (owner-only RLS on user_sessions). */
export async function withSessionOwner<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!userId) throw new Error("withSessionOwner: userId is required");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config(${USER_GUC}, ${userId}, true)`;
    return fn(tx);
  });
}

// Per-process refusals: sid → { decision, at }. Never expires (a revoke is final).
const checks = new Map<string, { decision: ClaimDecision; at: number }>();

/** Test hook. */
export function clearSessionCheckCache(): void {
  checks.clear();
}

export interface StartSessionInput {
  userId: string;
  provider?: string | null;
  userAgent?: string | null;
  ip?: string | null;
  /** When the JWT's absolute lifetime ends. */
  expiresAt: Date;
  now?: Date;
}

/** Write the row for a completed sign-in; returns its id (token.sid). */
export async function startUserSession(input: StartSessionInput): Promise<string> {
  const now = input.now ?? new Date();
  const row = await withSessionOwner(input.userId, (tx) =>
    tx.userSession.create({
      data: {
        userId: input.userId,
        provider: input.provider?.slice(0, 64) ?? null,
        userAgent: input.userAgent?.slice(0, 400) ?? null,
        deviceLabel: deviceLabel(input.userAgent)?.slice(0, 120) ?? null,
        ipPrefix: ipPrefix(input.ip),
        createdAt: now,
        lastSeenAt: now,
        expiresAt: input.expiresAt,
      },
      select: { id: true },
    }),
  );
  return row.id;
}

/**
 * Is this token's session still honoured? Used by the jwt callback on every
 * session read. Tokens with no subject are not the registry's business.
 */
export async function checkUserSession(
  token: { sub?: unknown; sid?: unknown; authAt?: unknown },
  now: Date = new Date(),
): Promise<ClaimDecision> {
  const sub = typeof token.sub === "string" ? token.sub : null;
  if (!sub) return "allow";
  const sid = typeof token.sid === "string" && token.sid ? token.sid : null;
  // A legacy token's answer depends on its own sign-in time: key it by both.
  const cacheKey = sid ?? `${legacyRowId(sub)}@${typeof token.authAt === "number" ? token.authAt : 0}`;
  const hit = checks.get(cacheKey);
  // Only a refusal is cached (a revoked session never comes back); an "allow"
  // is asked of the database on every session read, so a revoke made in any
  // process or module instance ends the token on its very next request.
  if (hit?.decision === "reject") return hit.decision;
  try {
    const decision = await withSessionOwner(sub, async (tx) => {
      let state: SessionRowState;
      if (sid) {
        const row = await tx.userSession.findFirst({
          where: { id: sid, userId: sub },
          select: { revokedAt: true, expiresAt: true, lastSeenAt: true },
        });
        state = row ? { kind: "row", revokedAt: row.revokedAt, expiresAt: row.expiresAt } : { kind: "missing" };
        if (row && !row.revokedAt && shouldTouch(row.lastSeenAt, now)) {
          await tx.userSession.updateMany({ where: { id: sid, userId: sub, revokedAt: null }, data: { lastSeenAt: now } });
        }
      } else {
        const cutoff = await tx.userSession.findFirst({ where: { id: legacyRowId(sub), userId: sub }, select: { revokedAt: true } });
        state = { kind: "legacy", cutoff: cutoff?.revokedAt ?? null };
      }
      return sessionClaimDecision(token, state, now);
    });
    if (decision === "reject") checks.set(cacheKey, { decision, at: now.getTime() });
    return decision;
  } catch (err) {
    console.warn("[sessions] registry check failed; allowing this request:", err instanceof Error ? err.message : err);
    return "allow";
  }
}

export interface SessionView {
  id: string;
  deviceLabel: string | null;
  provider: string | null;
  ipPrefix: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

/** The person's live sessions (not revoked, not expired), newest activity first. */
export async function listUserSessions(userId: string, currentSid: string | null, now: Date = new Date()): Promise<SessionView[]> {
  const rows = await withSessionOwner(userId, (tx) =>
    tx.userSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now }, NOT: { id: { startsWith: LEGACY_ROW_PREFIX } } },
      orderBy: { lastSeenAt: "desc" },
      take: 100,
      select: { id: true, deviceLabel: true, provider: true, ipPrefix: true, createdAt: true, lastSeenAt: true },
    }),
  );
  return rows.map((r) => ({
    id: r.id,
    deviceLabel: r.deviceLabel,
    provider: r.provider,
    ipPrefix: r.ipPrefix,
    createdAt: r.createdAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    current: r.id === currentSid,
  }));
}

/** Sign one of the person's own sessions out. Returns whether a live row was revoked. */
export async function revokeUserSession(userId: string, sid: string, by: string = "self", now: Date = new Date()): Promise<boolean> {
  if (!sid || sid.startsWith(LEGACY_ROW_PREFIX)) return false;
  const res = await withSessionOwner(userId, (tx) =>
    tx.userSession.updateMany({ where: { id: sid, userId, revokedAt: null }, data: { revokedAt: now, revokedBy: by.slice(0, 200) } }),
  );
  checks.set(sid, { decision: "reject", at: now.getTime() });
  return res.count > 0;
}

/**
 * Sign every other session out: revoke every live row except the current
 * one, and move the legacy cutoff to now (tokens from before the registry).
 * Returns how many listed sessions were revoked.
 */
export async function revokeOtherSessions(userId: string, currentSid: string | null, by: string = "self", now: Date = new Date()): Promise<number> {
  const count = await withSessionOwner(userId, async (tx) => {
    const res = await tx.userSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        NOT: [{ id: { startsWith: LEGACY_ROW_PREFIX } }, ...(currentSid ? [{ id: currentSid }] : [])],
      },
      data: { revokedAt: now, revokedBy: by.slice(0, 200) },
    });
    await tx.userSession.upsert({
      where: { id: legacyRowId(userId) },
      create: { id: legacyRowId(userId), userId, deviceLabel: "Sessions from before the session list", createdAt: now, lastSeenAt: now, expiresAt: now, revokedAt: now, revokedBy: by.slice(0, 200) },
      update: { revokedAt: now, revokedBy: by.slice(0, 200) },
    });
    return res.count;
  });
  // Forget this process's "allow" answers (other sessions, and the legacy
  // tokens keyed "legacy:<user>@<authAt>"), so the next read asks the database.
  for (const [key, v] of checks) if (key !== currentSid && v.decision === "allow") checks.delete(key);
  return count;
}
