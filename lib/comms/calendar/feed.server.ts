// ShapesOS — Phase 18.2 (WS=comms): a member's private ICS subscribe feed.
//
// The URL is /api/comms/calendar/feed/<workspaceId>/<token>.ics — a random
// 32-byte token (base64url) is the capability; only its sha256 is stored
// (calendar_feed_tokens, FORCE RLS — the workspace id in the URL selects the
// tenant scope, the token hash must then match a live row of that
// workspace). Revoking stamps revoked_at and the URL answers 404 at once.
//
// The feed carries what ShapesOS itself holds for the member — bookings,
// their focus blocks, Ops events, their reminders, calls and scheduled
// social posts — 30 days back to 180 ahead. Google / Outlook events are not
// re-published (they are already in the member's own calendar app, and an
// anonymous poller must never spend the member's provider quota).

import { createHash, randomBytes } from "node:crypto";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { HttpError } from "@/lib/api/errors";
import { buildIcs, type IcsEvent } from "./ics";
import { loadCalendarEvents } from "./sources.server";

export const FEED_PAST_DAYS = 30;
export const FEED_FUTURE_DAYS = 180;
export const MAX_FEEDS_PER_MEMBER = 5;

export function hashFeedToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newFeedToken(): string {
  return randomBytes(32).toString("base64url");
}

export function feedPath(workspaceId: string, token: string): string {
  return `/api/comms/calendar/feed/${encodeURIComponent(workspaceId)}/${token}.ics`;
}

export interface FeedView {
  id: string;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export async function listFeeds(workspaceId: string, userId: string): Promise<FeedView[]> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.calendarFeedToken.findMany({ where: { workspaceId, userId }, orderBy: { createdAt: "desc" }, take: 20 }),
  );
  return rows.map((r) => ({ id: r.id, hint: r.hint, createdAt: r.createdAt.toISOString(), lastUsedAt: r.lastUsedAt?.toISOString() ?? null, revokedAt: r.revokedAt?.toISOString() ?? null }));
}

/** A new feed URL (the token is shown once). */
export async function createFeed(workspaceId: string, userId: string): Promise<{ id: string; path: string }> {
  const token = newFeedToken();
  const row = await withWorkspaceScope(workspaceId, async (tx) => {
    const live = await tx.calendarFeedToken.count({ where: { workspaceId, userId, revokedAt: null } });
    if (live >= MAX_FEEDS_PER_MEMBER) throw new HttpError(409, `You already have ${MAX_FEEDS_PER_MEMBER} calendar feeds. Revoke one first.`);
    return tx.calendarFeedToken.create({ data: { workspaceId, userId, tokenHash: hashFeedToken(token), hint: token.slice(-4) } });
  });
  return { id: row.id, path: feedPath(workspaceId, token) };
}

export async function revokeFeed(workspaceId: string, userId: string, id: string, now = new Date()): Promise<void> {
  const r = await withWorkspaceScope(workspaceId, (tx) =>
    tx.calendarFeedToken.updateMany({ where: { id, workspaceId, userId, revokedAt: null }, data: { revokedAt: now } }),
  );
  if (r.count === 0) throw new HttpError(404, "Feed not found.");
}

/** The member a feed token belongs to (null: unknown, revoked, or not a member any more). */
export async function resolveFeed(workspaceId: string, token: string, now = new Date()): Promise<{ userId: string } | null> {
  if (!/^[A-Za-z0-9_-]{30,100}$/.test(token) || !workspaceId || workspaceId.length > 64) return null;
  const hash = hashFeedToken(token);
  return withWorkspaceScope(workspaceId, async (tx) => {
    const row = await tx.calendarFeedToken.findFirst({ where: { workspaceId, tokenHash: hash, revokedAt: null } });
    if (!row) return null;
    const member = await tx.workspaceMember.findFirst({ where: { workspaceId, userId: row.userId }, select: { id: true } });
    const owner = member ? null : await tx.workspace.findFirst({ where: { id: workspaceId, ownerUserId: row.userId }, select: { id: true } });
    if (!member && !owner) return null;
    // Last used: at most once an hour (feeds poll often).
    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > 3_600_000) {
      await tx.calendarFeedToken.update({ where: { id: row.id, workspaceId }, data: { lastUsedAt: now } });
    }
    return { userId: row.userId };
  });
}

/** The feed's iCalendar text for a member. */
export async function feedIcs(workspaceId: string, userId: string, timeZone: string, now = new Date()): Promise<string> {
  const from = new Date(now.getTime() - FEED_PAST_DAYS * 86_400_000);
  const to = new Date(now.getTime() + FEED_FUTURE_DAYS * 86_400_000);
  const load = await loadCalendarEvents({ workspaceId, userId, timeZone }, from, to, { include: ["booking", "focus", "ops_event", "reminder", "meeting", "social"] });
  const events: IcsEvent[] = load.events.map((e) => ({
    uid: `${e.id}@shapesos`,
    title: e.title || "(no title)",
    start: new Date(e.start),
    end: e.end ? new Date(e.end) : null,
    allDay: e.allDay,
    location: e.location,
    url: e.externalUrl,
    attendees: e.attendees,
  }));
  return buildIcs({ name: "ShapesOS", refreshMinutes: 60, events, now });
}
