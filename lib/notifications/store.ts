// ShapesOS — Phase 3 (J): notification center store.
//
// One Notification row per recipient, so read state is per user. Every read
// and write is keyed by (userId, workspaceId): a member only ever sees and
// marks their own notifications in the workspace they are looking at.

import type { NotificationKind, Prisma } from "@prisma/client";

export type NotificationDb = Pick<Prisma.TransactionClient, "notification">;

export interface NotificationInput {
  workspaceId: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  href?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  /** Idempotency per recipient (unique with userId). */
  dedupKey?: string | null;
}

export interface NotificationView {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  href: string | null;
  sourceType: string | null;
  sourceId: string | null;
  readAt: string | null;
  createdAt: string;
}

/**
 * Only same-app dashboard links are stored: a notification can never point
 * a member off-site (no scheme, no protocol-relative "//", no backslashes).
 */
export function safeHref(href: string | null | undefined): string | null {
  if (typeof href !== "string") return null;
  const h = href.trim();
  if (!h.startsWith("/dashboard")) return null;
  if (h.startsWith("//") || h.includes("\\") || /[\u0000-\u001f]/.test(h)) return null;
  return h.slice(0, 500);
}

function clip(s: string | null | undefined, n: number): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t ? t.slice(0, n) : null;
}

/** Insert notifications; duplicates (same user + dedupKey) are skipped. Returns rows created. */
export async function createNotifications(db: NotificationDb, inputs: NotificationInput[]): Promise<number> {
  const data = inputs
    .filter((n) => n.workspaceId && n.userId && n.title?.trim())
    .map((n) => ({
      workspaceId: n.workspaceId,
      userId: n.userId,
      kind: n.kind,
      title: clip(n.title, 200)!,
      body: clip(n.body, 1000),
      href: safeHref(n.href),
      sourceType: clip(n.sourceType, 64),
      sourceId: clip(n.sourceId, 128),
      dedupKey: clip(n.dedupKey, 200),
    }));
  if (data.length === 0) return 0;
  const res = await db.notification.createMany({ data, skipDuplicates: true });
  return res.count;
}

function toView(r: {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  href: string | null;
  sourceType: string | null;
  sourceId: string | null;
  readAt: Date | null;
  createdAt: Date;
}): NotificationView {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    href: r.href,
    sourceType: r.sourceType,
    sourceId: r.sourceId,
    readAt: r.readAt ? r.readAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

export interface ListOptions {
  userId: string;
  workspaceId: string;
  limit?: number;
  unreadOnly?: boolean;
  /** Cursor: return notifications created before this ISO timestamp. */
  before?: string | null;
}

export async function listNotifications(db: NotificationDb, opts: ListOptions): Promise<NotificationView[]> {
  const take = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const before = opts.before ? new Date(opts.before) : null;
  const rows = await db.notification.findMany({
    where: {
      userId: opts.userId,
      workspaceId: opts.workspaceId,
      ...(opts.unreadOnly ? { readAt: null } : {}),
      ...(before && !Number.isNaN(before.getTime()) ? { createdAt: { lt: before } } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
  });
  return rows.map(toView);
}

export async function unreadCount(db: NotificationDb, opts: { userId: string; workspaceId: string }): Promise<number> {
  return db.notification.count({
    where: { userId: opts.userId, workspaceId: opts.workspaceId, readAt: null },
  });
}

/** Mark specific notifications read — only the caller's own, in this workspace. */
export async function markRead(
  db: NotificationDb,
  opts: { userId: string; workspaceId: string; ids: string[] },
): Promise<number> {
  const ids = [...new Set(opts.ids.filter((i) => typeof i === "string" && i))].slice(0, 200);
  if (ids.length === 0) return 0;
  const res = await db.notification.updateMany({
    where: { id: { in: ids }, userId: opts.userId, workspaceId: opts.workspaceId, readAt: null },
    data: { readAt: new Date() },
  });
  return res.count;
}

/** "Mark all read" for the caller in this workspace. */
export async function markAllRead(db: NotificationDb, opts: { userId: string; workspaceId: string }): Promise<number> {
  const res = await db.notification.updateMany({
    where: { userId: opts.userId, workspaceId: opts.workspaceId, readAt: null },
    data: { readAt: new Date() },
  });
  return res.count;
}
