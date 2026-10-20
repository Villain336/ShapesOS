// ShapesOS — Phase 18.3 (WS=trust): the daily email digest.
//
// For each person whose email digest is "daily" (UserPreference.notifications,
// the ONE store), once their local morning has come (DIGEST_HOUR) and no row
// went out today: every unread, delivered (not held), not-yet-mailed
// notification of the last week whose kind the person allows on the email
// channel, across their workspaces, in ONE email — sent through the Alerts
// hub's email delivery (lib/alerts/adapters.ts sendEmail + SMTP_*), not a new
// mailer. Mailed rows get notifications.digested_at, so a row is never mailed
// twice and a failed send is retried by the next sweep.

import { prisma } from "@/lib/prisma";
import type { AlertPayload, AdapterResult } from "@/lib/alerts/adapters";
import { coercePreferences, type UserPreferences } from "@/lib/preferences";
import { DEFAULT_TIME_ZONE, resolveTimeZone, zonedParts, zonedTimeToUtc } from "@/lib/time/zoned";
import { channelAllows } from "./channels";
import { DIGEST_HOUR, DIGEST_MAX_AGE_MS, DIGEST_MAX_ITEMS, assembleDigest, type DigestGroup } from "./digest";

export interface DigestDeps {
  send?: (to: string, payload: AlertPayload) => Promise<AdapterResult>;
  appUrl?: () => string | null;
  /** The person's summary text for today, when written (summary.server.ts). */
  summaryFor?: (userId: string, timeZone: string, now: Date) => Promise<string | null>;
}

export interface DigestSweepResult {
  people: number;
  sent: number;
  rows: number;
  skipped: number;
  failed: number;
}

/** Start of the person's local day, as an instant. */
export function localDayStart(now: Date, timeZone: string): Date {
  const tz = resolveTimeZone(timeZone);
  const p = zonedParts(now, tz);
  return zonedTimeToUtc(p.year, p.month, p.day, 0, tz).date;
}

function appUrlFromEnv(): string | null {
  for (const raw of [process.env.APP_URL, process.env.NEXTAUTH_URL, process.env.AUTH_URL]) {
    try {
      if (raw) return new URL(raw).origin;
    } catch {
      /* next */
    }
  }
  return null;
}

async function emailOf(userId: string): Promise<string | null> {
  const m = await prisma.workspaceMember.findFirst({ where: { userId, email: { not: null } }, select: { email: true }, orderBy: { createdAt: "asc" } });
  return m?.email ?? (userId.startsWith("email:") ? userId.slice(6) : null);
}

/** Digest for ONE person (exported for tests). */
export async function sendDigestFor(
  userId: string,
  prefs: UserPreferences,
  now: Date,
  deps: DigestDeps = {},
): Promise<{ status: "sent" | "not_due" | "already_sent" | "empty" | "no_email" | "failed"; rows: number }> {
  const tz = prefs.timeZone ?? DEFAULT_TIME_ZONE;
  const p = zonedParts(now, resolveTimeZone(tz));
  if (Math.floor(p.minutes / 60) < DIGEST_HOUR) return { status: "not_due", rows: 0 };
  const dayStart = localDayStart(now, tz);
  const already = await prisma.notification.findFirst({ where: { userId, digestedAt: { gte: dayStart } }, select: { id: true } });
  if (already) return { status: "already_sent", rows: 0 };
  const rows = await prisma.notification.findMany({
    where: { userId, readAt: null, heldAt: null, digestedAt: null, createdAt: { gte: new Date(now.getTime() - DIGEST_MAX_AGE_MS) } },
    orderBy: { createdAt: "desc" },
    take: DIGEST_MAX_ITEMS * 4,
    select: { id: true, workspaceId: true, kind: true, title: true, body: true, href: true, createdAt: true, workspace: { select: { name: true } } },
  });
  const allowed = rows.filter((r) => channelAllows(prefs.notifications, r.kind, "email")).slice(0, DIGEST_MAX_ITEMS);
  if (allowed.length === 0) return { status: "empty", rows: 0 };
  const to = await emailOf(userId);
  if (!to) return { status: "no_email", rows: 0 };
  const groups = new Map<string, DigestGroup>();
  for (const r of allowed) {
    const g = groups.get(r.workspaceId) ?? { workspaceName: r.workspace?.name ?? "Workspace", items: [] };
    g.items.push({ kind: r.kind, title: r.title, body: r.body, href: r.href, createdAt: r.createdAt });
    groups.set(r.workspaceId, g);
  }
  const summary = deps.summaryFor ? await deps.summaryFor(userId, tz, now).catch(() => null) : null;
  const payload = assembleDigest([...groups.values()], { appUrl: (deps.appUrl ?? appUrlFromEnv)(), summary });
  const send =
    deps.send ??
    (async (address: string, pl: AlertPayload) => {
      const { sendEmail } = await import("@/lib/alerts/adapters");
      return sendEmail({ to: address }, pl);
    });
  const res = await send(to, payload);
  if (!res.ok) {
    console.warn("[notifications] email digest not sent:", res.error);
    return { status: "failed", rows: 0 };
  }
  const marked = await prisma.notification.updateMany({ where: { id: { in: allowed.map((r) => r.id) }, userId, digestedAt: null }, data: { digestedAt: now } });
  return { status: "sent", rows: marked.count };
}

/** Everyone with the daily digest on (bounded per run). */
export async function runEmailDigestSweep(opts: { now?: Date; limit?: number; deps?: DigestDeps } = {}): Promise<DigestSweepResult> {
  const now = opts.now ?? new Date();
  const out: DigestSweepResult = { people: 0, sent: 0, rows: 0, skipped: 0, failed: 0 };
  const rows = await prisma.userPreference.findMany({
    where: { notifications: { path: ["emailDigest"], equals: "daily" } },
    take: opts.limit ?? 1000,
  });
  for (const row of rows) {
    out.people++;
    const prefs = coercePreferences({ timeZone: row.timeZone, language: row.language, notifications: row.notifications });
    try {
      const r = await sendDigestFor(row.userId, prefs, now, opts.deps);
      if (r.status === "sent") {
        out.sent++;
        out.rows += r.rows;
      } else if (r.status === "failed") out.failed++;
      else out.skipped++;
    } catch (err) {
      out.failed++;
      console.warn("[notifications] email digest failed for one person:", err instanceof Error ? err.message : err);
    }
  }
  return out;
}
