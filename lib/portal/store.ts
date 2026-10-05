// ShapesOS — Phase 10 (portal): client portal sign-in and sessions.
//
//   requestPortalLink    POST /api/portal/login   email → link to Client.loginEmail
//   consumePortalLink    POST /api/portal/link    link → portal session
//   resolvePortalSession every portal page / API request
//   revokePortalSessions sign out, Settings → Clients, portal off, email change
//
// Reuses the Phase 6 email sign-in primitives instead of a second copy:
// normalizeEmail, the token generator + SHA-256 hashing, the 15-minute link
// TTL, the per-address send limit (recentLinkCount + countLinkSend: portal
// mail shares the mailbox's EMAIL_SEND_LIMIT budget with workspace sign-in
// mail), the login lockout (per IP and per address, Postgres-backed), the
// CAPTCHA step-up, and the mail layer (sendAuthEmail, "portal" kind).
//
// Rules:
//   - No enumeration: the request answers the same whether or not the
//     address is a client anywhere (or has the portal turned on).
//   - Links are single use: one guarded UPDATE (used_at IS NULL AND
//     expires_at > now). The link is consumed even when sign-in is then
//     refused (client gone, portal off, sign-in email changed).
//   - A portal session NEVER becomes a workspace session: it is its own row
//     and cookie, read only by lib/portal. Every portal query runs under the
//     session's workspace RLS scope AND filters by (workspaceId, clientId).

import { prisma } from "@/lib/prisma";
import { BadRequestError } from "@/lib/api/errors";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { EMAIL_SEND_LIMIT, normalizeEmail } from "@/lib/auth/email/tokens";
import {
  CaptchaRequiredHttpError,
  EmailAuthLockedError,
  countLinkSend,
  recentLinkCount,
  type FlowDeps,
} from "@/lib/auth/email/store";
import { EmailAuthUnavailableError, emailAuthBaseUrl, emailAuthEnabled, sendAuthEmail } from "@/lib/auth/email/mail";
import { loginLockedOutAsync, recordLoginFailureAsync, recordLoginSuccessAsync } from "@/lib/auth/rate-limit";
import { captchaRequiredAsync, verifyCaptchaToken } from "@/lib/auth/captcha";
import {
  PORTAL_MAX_CLIENTS_PER_EMAIL,
  PORTAL_SEEN_RESOLUTION_MS,
  hashPortalToken,
  mintPortalToken,
  parsePortalToken,
  portalActorId,
  portalExpiry,
  type PortalLinks,
  type PortalRole,
} from "./core";

export const PORTAL_LINK_PATH = "/portal/link";
export const PORTAL_LINK_SENT =
  "If that address can use a client portal here, we've sent it a sign-in link. It works once and expires in 15 minutes.";

async function auditPortal(workspaceId: string, clientId: string, action: string, actor: string, summary: string) {
  await withWorkspaceScope(workspaceId, async (tx) => {
    await tx.opsAuditEvent.create({
      data: { workspaceId, entity: "portal", entityId: clientId, action, actor, summary: summary.slice(0, 2000) },
    });
  }).catch((err: unknown) => console.error("[portal] audit write failed:", (err as { code?: string })?.code ?? err));
}

// ── Request a link ──────────────────────────────────────────────────────────

export interface PortalLinkRequest {
  email: unknown;
  ip: string | null;
  captchaToken?: unknown;
}

export async function requestPortalLink(input: PortalLinkRequest, deps: FlowDeps = {}): Promise<{ ok: true; message: string }> {
  if (!emailAuthEnabled(deps.env)) throw new EmailAuthUnavailableError();
  const email = normalizeEmail(input.email);
  if (!email) throw new BadRequestError("Enter a valid email address.", { code: "invalid_email" });
  if (await loginLockedOutAsync(input.ip, email)) throw new EmailAuthLockedError();
  if (await captchaRequiredAsync(input.ip, email, { env: deps.env })) {
    const token = typeof input.captchaToken === "string" ? input.captchaToken : "";
    if (!(await verifyCaptchaToken(token, input.ip, { env: deps.env }))) throw new CaptchaRequiredHttpError();
  }
  const now = deps.now ?? new Date();
  const base = emailAuthBaseUrl(deps.env, deps.requestOrigin);
  // clients is not a tenant (RLS) table: the address may be a client of
  // several workspaces. Only clients whose portal is turned on get a link.
  const clients = base
    ? await prisma.client.findMany({
        where: { loginEmail: email, portalEnabled: true },
        orderBy: { createdAt: "asc" },
        take: PORTAL_MAX_CLIENTS_PER_EMAIL,
        select: { id: true, workspaceId: true, workspace: { select: { name: true } } },
      })
    : [];
  for (const c of clients) {
    // The mailbox's shared budget (workspace sign-in mail counts too).
    if ((await recentLinkCount(email, now)) >= EMAIL_SEND_LIMIT) break;
    const { raw, hash } = mintPortalToken("link", c.workspaceId);
    await withWorkspaceScope(c.workspaceId, async (tx) => {
      await tx.portalLoginLink.create({
        data: { workspaceId: c.workspaceId, clientId: c.id, tokenHash: hash, email, expiresAt: portalExpiry("link", now), createdAt: now },
      });
      // Housekeeping: this client's links that expired over a day ago.
      await tx.portalLoginLink.deleteMany({
        where: { workspaceId: c.workspaceId, clientId: c.id, expiresAt: { lt: new Date(now.getTime() - 86_400_000) } },
      });
    });
    await countLinkSend(email, now);
    await sendAuthEmail(
      { kind: "portal", to: email, url: `${base}${PORTAL_LINK_PATH}#token=${encodeURIComponent(raw)}`, detail: c.workspace.name },
      deps,
    );
  }
  return { ok: true, message: PORTAL_LINK_SENT };
}

// ── Use a link ──────────────────────────────────────────────────────────────

/** Lockout key for link attempts: per IP (a token names no account up front). */
function linkKey(ip: string | null): string {
  return `portal-link:${ip ?? "no-ip"}`;
}

export type PortalLinkResult =
  | { status: "ok"; sessionToken: string; expiresAt: Date; workspaceId: string; clientId: string }
  | { status: "invalid" };

export async function consumePortalLink(
  token: unknown,
  opts: { ip: string | null; userAgent?: string | null; now?: Date },
): Promise<PortalLinkResult> {
  const parsed = parsePortalToken(token, "link");
  if (await loginLockedOutAsync(opts.ip, linkKey(opts.ip))) throw new EmailAuthLockedError();
  const fail = async (): Promise<PortalLinkResult> => {
    await recordLoginFailureAsync(opts.ip, linkKey(opts.ip));
    return { status: "invalid" };
  };
  if (!parsed) return fail();
  const now = opts.now ?? new Date();
  const ws = parsed.workspaceId;
  const tokenHash = hashPortalToken(token as string);
  const result = await withWorkspaceScope(ws, async (tx) => {
    const used = await tx.portalLoginLink.updateMany({
      where: { tokenHash, workspaceId: ws, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (used.count !== 1) return null;
    const link = await tx.portalLoginLink.findFirst({ where: { tokenHash, workspaceId: ws } });
    if (!link) return null;
    const client = await tx.client.findFirst({ where: { id: link.clientId, workspaceId: ws } });
    // Consumed either way: the client must still exist, still have the
    // portal on, and still sign in with the address the link went to.
    if (!client || !client.portalEnabled || normalizeEmail(client.loginEmail) !== link.email) return null;
    const session = mintPortalToken("session", ws);
    const expiresAt = portalExpiry("session", now);
    await tx.portalSession.create({
      data: {
        workspaceId: ws,
        clientId: client.id,
        tokenHash: session.hash,
        expiresAt,
        lastSeenAt: now,
        ip: opts.ip?.slice(0, 64) ?? null,
        userAgent: opts.userAgent?.slice(0, 300) ?? null,
        createdAt: now,
      },
    });
    await tx.opsAuditEvent.create({
      data: {
        workspaceId: ws,
        entity: "portal",
        entityId: client.id,
        action: "portal_login",
        actor: portalActorId(client.id),
        summary: `client portal sign-in for ${client.name} (${link.email}) from ${opts.ip ?? "unknown ip"}`,
      },
    });
    return { sessionToken: session.raw, expiresAt, clientId: client.id, email: link.email };
  });
  if (!result) return fail();
  await recordLoginSuccessAsync(opts.ip, linkKey(opts.ip));
  return { status: "ok", sessionToken: result.sessionToken, expiresAt: result.expiresAt, workspaceId: ws, clientId: result.clientId };
}

// ── Resolve a session ───────────────────────────────────────────────────────

export interface PortalPrincipal {
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
  clientId: string;
  clientName: string;
  email: string;
  role: PortalRole;
  links: PortalLinks;
  expiresAt: Date;
}

/** The live portal session behind a raw token, or null (unknown, expired, revoked, portal off). */
export async function resolvePortalSession(raw: unknown, now: Date = new Date()): Promise<PortalPrincipal | null> {
  const parsed = parsePortalToken(raw, "session");
  if (!parsed) return null;
  const ws = parsed.workspaceId;
  const tokenHash = hashPortalToken(raw as string);
  return withWorkspaceScope(ws, async (tx) => {
    const s = await tx.portalSession.findFirst({ where: { tokenHash, workspaceId: ws } });
    if (!s || s.workspaceId !== ws || s.revokedAt || s.expiresAt.getTime() <= now.getTime()) return null;
    const client = await tx.client.findFirst({
      where: { id: s.clientId, workspaceId: ws },
      include: { workspace: { select: { name: true } } },
    });
    if (!client || !client.portalEnabled) return null;
    if (!s.lastSeenAt || now.getTime() - s.lastSeenAt.getTime() > PORTAL_SEEN_RESOLUTION_MS) {
      await tx.portalSession.updateMany({ where: { id: s.id, workspaceId: ws }, data: { lastSeenAt: now } });
    }
    return {
      sessionId: s.id,
      workspaceId: ws,
      workspaceName: client.workspace.name,
      clientId: client.id,
      clientName: client.name,
      email: client.loginEmail,
      role: client.viewerRole,
      links: { portalCompanyIds: client.portalCompanyIds, portalContactIds: client.portalContactIds, portalLeadIds: client.portalLeadIds },
      expiresAt: s.expiresAt,
    };
  });
}

// ── Revoke ──────────────────────────────────────────────────────────────────

/**
 * Revoke a client's live sessions (one, when sessionId is given). `by` is
 * "client" (sign out), a workspace user id, or "system". Returns the count.
 */
export async function revokePortalSessions(
  workspaceId: string,
  clientId: string,
  by: string,
  opts: { sessionId?: string; now?: Date; reason?: string } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const n = await withWorkspaceScope(workspaceId, async (tx) => {
    const r = await tx.portalSession.updateMany({
      where: { workspaceId, clientId, revokedAt: null, ...(opts.sessionId ? { id: opts.sessionId } : {}) },
      data: { revokedAt: now, revokedBy: by.slice(0, 128) },
    });
    return r.count;
  });
  if (n > 0) {
    await auditPortal(
      workspaceId,
      clientId,
      by === "client" ? "portal_logout" : "portal_revoke",
      by === "client" ? portalActorId(clientId) : by,
      `${n} client portal session${n === 1 ? "" : "s"} ${by === "client" ? "signed out" : "revoked"}${opts.reason ? ` (${opts.reason})` : ""}`,
    );
  }
  return n;
}

export interface PortalSessionView {
  id: string;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  active: boolean;
  revokedAt: string | null;
}

/** A client's recent portal sessions (newest first) for Settings → Clients. */
export async function listPortalSessions(workspaceId: string, clientId: string, now: Date = new Date()): Promise<PortalSessionView[]> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.portalSession.findMany({ where: { workspaceId, clientId }, orderBy: { createdAt: "desc" }, take: 20 }),
  );
  return rows.map((s) => ({
    id: s.id,
    createdAt: s.createdAt.toISOString(),
    lastSeenAt: s.lastSeenAt?.toISOString() ?? null,
    expiresAt: s.expiresAt.toISOString(),
    ip: s.ip,
    userAgent: s.userAgent,
    active: !s.revokedAt && s.expiresAt.getTime() > now.getTime(),
    revokedAt: s.revokedAt?.toISOString() ?? null,
  }));
}
