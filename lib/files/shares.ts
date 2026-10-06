// ShapesOS — Phase 18.2 (WS=content): per-file share links (server only).
//
// The share-link pattern the app already uses (DesignShare /s/[token],
// CadShareLink, FundingShareLink): a random token returned ONCE at creation
// and stored only as SHA-256; an expiry; revocable; resolved by ONE public
// route family (/r/file/<token> — the viewer page — and
// /r/file/<token>/raw — the bytes and the password unlock). Plus:
//   - access "view" (look only: the bytes are served inline, never as a
//     download) or "download"
//   - an optional password (scrypt, salted); a correct password sets a
//     short-lived HttpOnly cookie scoped to that link's path (HMAC-signed
//     with a key derived from AUTH_SECRET), so the password is never in a URL
//   - unknown, revoked, expired and trashed all look the same from outside
// The one cross-workspace read — token hash → link — goes through the
// SELECT-only app.file_share_route policy (live links only); everything after
// it runs under the link's own workspace scope.

import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { auditEvent } from "@/lib/auditlog";
import { BadRequestError, ForbiddenError, NotFoundError } from "@/lib/api/errors";
import { fileCan } from "./acl";
import { requireFileAction, type FileActor } from "./access";

const scrypt = promisify(scryptCb) as (pw: string | Buffer, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

export const SHARE_TOKEN_PREFIX = "fsh_";
export const SHARE_ACCESS = ["view", "download"] as const;
export type ShareAccess = (typeof SHARE_ACCESS)[number];
export const SHARE_MAX_DAYS = 90;
export const SHARE_DEFAULT_DAYS = 7;
export const SHARE_PASSWORD_MIN = 6;
export const SHARE_PASSWORD_MAX = 128;
/** How long a correct password keeps the link open in that browser. */
export const SHARE_UNLOCK_MS = 12 * 60 * 60_000;

const TOKEN_RE = /^fsh_[0-9a-f]{32}$/;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// ---------------------------------------------------------------------------
// PURE helpers (unit-tested)
// ---------------------------------------------------------------------------

export function generateShareToken(): string {
  return `${SHARE_TOKEN_PREFIX}${randomBytes(16).toString("hex")}`;
}

export function isShareTokenShape(token: string): boolean {
  return TOKEN_RE.test(token ?? "");
}

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Expiry from a number of days (1..90; default 7). */
export function shareExpiry(days: unknown, now = new Date()): Date {
  const n = days === undefined || days === null || days === "" ? SHARE_DEFAULT_DAYS : Number(days);
  if (!Number.isInteger(n) || n < 1 || n > SHARE_MAX_DAYS) throw new BadRequestError(`A link lasts 1 to ${SHARE_MAX_DAYS} days.`);
  return new Date(now.getTime() + n * 86_400_000);
}

/** Why a link can't be used right now, or null when it can. */
export function shareUnusableReason(link: { revokedAt: Date | null; expiresAt: Date | null }, now = new Date()): "revoked" | "expired" | null {
  if (link.revokedAt) return "revoked";
  if (link.expiresAt && link.expiresAt.getTime() <= now.getTime()) return "expired";
  return null;
}

export async function hashSharePassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize("NFKC"), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifySharePassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, saltB64, hashB64] = (stored ?? "").split("$");
  if (alg !== "scrypt" || !saltB64 || !hashB64 || Number(n) !== SCRYPT.N) return false;
  const want = Buffer.from(hashB64, "base64");
  const got = await scrypt(String(password ?? "").normalize("NFKC"), Buffer.from(saltB64, "base64"), want.length, SCRYPT);
  return want.length === got.length && timingSafeEqual(want, got);
}

function unlockKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("shapes:file-share-unlock:v1").digest();
}

/** The unlock cookie value for one link: "<exp>.<mac>". */
export function signUnlock(linkId: string, secret: string, now = Date.now()): string {
  const exp = now + SHARE_UNLOCK_MS;
  const mac = createHmac("sha256", unlockKey(secret)).update(`${linkId}.${exp}`).digest("base64url");
  return `${exp}.${mac}`;
}

export function verifyUnlock(linkId: string, value: string | undefined, secret: string, now = Date.now()): boolean {
  const [expS, mac] = (value ?? "").split(".");
  const exp = Number(expS);
  if (!mac || !Number.isFinite(exp) || exp <= now) return false;
  const want = Buffer.from(createHmac("sha256", unlockKey(secret)).update(`${linkId}.${exp}`).digest("base64url"));
  const got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function shareSecret(env: Record<string, string | undefined> = process.env): string | null {
  const s = env.AUTH_SECRET?.trim() || env.NEXTAUTH_SECRET?.trim();
  return s && s.length >= 16 ? s : null;
}

export function unlockCookieName(linkId: string): string {
  return `fsh_unlock_${linkId.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

// ---------------------------------------------------------------------------
// Members (signed in, through requireFileAction)
// ---------------------------------------------------------------------------

export interface ShareLinkMeta {
  id: string;
  fileId: string;
  tokenHint: string;
  access: ShareAccess;
  hasPassword: boolean;
  expiresAt: string | null;
  revokedAt: string | null;
  createdBy: string;
  createdAt: string;
  openCount: number;
  lastOpenedAt: string | null;
  /** live | revoked | expired */
  state: "live" | "revoked" | "expired";
}

function toMeta(r: {
  id: string;
  fileId: string;
  tokenHint: string;
  access: string;
  passwordHash: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  openCount: number;
  lastOpenedAt: Date | null;
}): ShareLinkMeta {
  return {
    id: r.id,
    fileId: r.fileId,
    tokenHint: r.tokenHint,
    access: r.access === "download" ? "download" : "view",
    hasPassword: !!r.passwordHash,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    openCount: r.openCount,
    lastOpenedAt: r.lastOpenedAt?.toISOString() ?? null,
    state: shareUnusableReason(r) ?? "live",
  };
}

export interface CreateShareInput {
  access?: ShareAccess;
  expiresInDays?: number;
  password?: string | null;
}

/** Create a link. The token is in the result ONCE; only its hash is stored. */
export async function createShareLink(actor: FileActor, fileId: string, input: CreateShareInput): Promise<{ link: ShareLinkMeta; token: string; path: string }> {
  const { file } = await requireFileAction(actor, fileId, "share");
  const access: ShareAccess = input.access === "download" ? "download" : "view";
  const expiresAt = shareExpiry(input.expiresInDays);
  let passwordHash: string | null = null;
  if (input.password) {
    if (input.password.length < SHARE_PASSWORD_MIN || input.password.length > SHARE_PASSWORD_MAX) {
      throw new BadRequestError(`A link password is ${SHARE_PASSWORD_MIN} to ${SHARE_PASSWORD_MAX} characters.`);
    }
    passwordHash = await hashSharePassword(input.password);
  }
  const token = generateShareToken();
  const row = await withWorkspaceScope(actor.workspaceId, (tx) =>
    tx.workspaceFileShare.create({
      data: { workspaceId: actor.workspaceId, fileId, tokenHash: hashShareToken(token), tokenHint: token.slice(-4), access, passwordHash, expiresAt, createdBy: actor.userId },
    }),
  );
  await auditEvent({
    workspaceId: actor.workspaceId,
    projectId: null,
    action: "file_share_created",
    summary: `Share link …${row.tokenHint} for "${file.filename}" (${access}${passwordHash ? ", password" : ""}, until ${expiresAt.toISOString().slice(0, 10)})`,
    actorUserId: actor.userId,
  }).catch(() => {});
  return { link: toMeta(row), token, path: `/r/file/${token}` };
}

export async function listShareLinks(actor: FileActor, fileId: string): Promise<{ links: ShareLinkMeta[]; canShare: boolean }> {
  const { role } = await requireFileAction(actor, fileId, "view");
  if (!fileCan(role, "share")) return { links: [], canShare: false };
  const rows = await withWorkspaceScope(actor.workspaceId, (tx) =>
    tx.workspaceFileShare.findMany({ where: { workspaceId: actor.workspaceId, fileId }, orderBy: { createdAt: "desc" }, take: 100 }),
  );
  return { links: rows.map(toMeta), canShare: true };
}

/** Revoke: the person who made the link, or the file's owner / an admin. */
export async function revokeShareLink(actor: FileActor, fileId: string, linkId: string): Promise<ShareLinkMeta> {
  const { file, role } = await requireFileAction(actor, fileId, "view");
  const row = await withWorkspaceScope(actor.workspaceId, async (tx) => {
    const link = await tx.workspaceFileShare.findFirst({ where: { id: linkId, workspaceId: actor.workspaceId, fileId } });
    if (!link) throw new NotFoundError("Link not found.");
    if (link.createdBy !== actor.userId && !fileCan(role, "manageAccess")) throw new ForbiddenError("Only the person who made the link or the file's owner can revoke it.");
    if (link.revokedAt) return link;
    return tx.workspaceFileShare.update({ where: { id: link.id, workspaceId: actor.workspaceId }, data: { revokedAt: new Date(), revokedBy: actor.userId } });
  });
  await auditEvent({ workspaceId: actor.workspaceId, projectId: null, action: "file_share_revoked", summary: `Share link …${row.tokenHint} for "${file.filename}" revoked`, actorUserId: actor.userId }).catch(() => {});
  return toMeta(row);
}

// ---------------------------------------------------------------------------
// The public route (no session): token → link → file
// ---------------------------------------------------------------------------

export interface ResolvedShare {
  link: { id: string; workspaceId: string; fileId: string; access: ShareAccess; passwordHash: string | null; expiresAt: Date | null };
  file: { id: string; filename: string; mimeType: string; sizeBytes: number; storageKey: string; version: number };
}

/**
 * Resolve a token. Null for anything unusable — unknown, revoked, expired,
 * file trashed or gone — so the outside world can't tell which.
 */
export async function resolveShareToken(token: string, now = new Date()): Promise<ResolvedShare | null> {
  if (!isShareTokenShape(token)) return null;
  const hash = hashShareToken(token);
  const link = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.file_share_route = 'lookup'`);
    return tx.workspaceFileShare.findFirst({
      where: { tokenHash: hash, revokedAt: null },
      select: { id: true, workspaceId: true, fileId: true, access: true, passwordHash: true, expiresAt: true, revokedAt: true },
    });
  });
  if (!link || shareUnusableReason(link, now)) return null;
  const file = await prisma.workspaceFile.findFirst({
    where: { id: link.fileId, workspaceId: link.workspaceId, trashedAt: null },
    select: { id: true, filename: true, mimeType: true, sizeBytes: true, storageKey: true, version: true },
  });
  if (!file) return null;
  return { link: { ...link, access: link.access === "download" ? "download" : "view" }, file };
}

/** Count an open (the viewer page, not every byte request). Best effort. */
export async function recordShareOpen(share: ResolvedShare): Promise<void> {
  await withWorkspaceScope(share.link.workspaceId, (tx) =>
    tx.workspaceFileShare.update({ where: { id: share.link.id, workspaceId: share.link.workspaceId }, data: { openCount: { increment: 1 }, lastOpenedAt: new Date() } }),
  ).catch(() => undefined);
}
