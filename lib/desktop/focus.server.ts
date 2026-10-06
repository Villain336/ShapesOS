// ShapesOS — Phase 18.1 (WS=desk): focus / do not disturb, server side.
//
// The rules are in ./focus.ts (pure). Here: the person's focus state
// (user_desk_state), the recipients-in-focus lookup the notification
// producers use to QUEUE rows (notifications.held_at), and the release that
// delivers what was queued when focus ends — on switch-off, on the bell's
// next poll after the end time, and on the /api/cron/desk sweep.

import { prisma } from "@/lib/prisma";
import type { NotificationKind } from "@prisma/client";
import { queuePushForNotifications } from "@/lib/push/notify";
import { filterByNotificationPrefs } from "@/lib/preferences";
import { focusEndsAt, isFocusActive, validFocusEnd, type FocusState } from "./focus";

export interface FocusView {
  on: boolean;
  until: string | null;
  startedAt: string | null;
  /** Notifications waiting for focus to end (all workspaces). */
  queued: number;
}

export async function getFocusState(userId: string): Promise<FocusState> {
  const row = await prisma.userDeskState.findUnique({
    where: { userId },
    select: { focusUntil: true, focusStartedAt: true },
  });
  return { focusUntil: row?.focusUntil ?? null, focusStartedAt: row?.focusStartedAt ?? null };
}

export async function focusView(userId: string, now: Date = new Date()): Promise<FocusView> {
  const [state, queued] = await Promise.all([
    getFocusState(userId),
    prisma.notification.count({ where: { userId, heldAt: { not: null } } }),
  ]);
  const on = isFocusActive(state, now);
  return {
    on,
    until: on ? state.focusUntil!.toISOString() : null,
    startedAt: on && state.focusStartedAt ? state.focusStartedAt.toISOString() : null,
    queued,
  };
}

/** Of `userIds`, the ones in focus right now (their new notifications wait). */
export async function usersInFocus(userIds: readonly string[], now: Date = new Date()): Promise<Set<string>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Set();
  const rows = await prisma.userDeskState.findMany({
    where: { userId: { in: ids }, focusUntil: { gt: now } },
    select: { userId: true },
  });
  return new Set(rows.map((r) => r.userId));
}

/** Turn focus on until an end time (by minutes or an explicit instant). */
export async function startFocus(
  userId: string,
  input: { minutes: number } | { until: Date },
  now: Date = new Date(),
): Promise<FocusView> {
  const until = "minutes" in input ? focusEndsAt(input.minutes, now) : input.until;
  if (!validFocusEnd(until, now)) throw new RangeError("Pick an end time between one minute and 24 hours from now.");
  await prisma.userDeskState.upsert({
    where: { userId },
    create: { userId, focusUntil: until, focusStartedAt: now },
    update: { focusUntil: until, focusStartedAt: now },
  });
  return focusView(userId, now);
}

/** Turn focus off now and deliver everything it queued. */
export async function endFocus(userId: string, now: Date = new Date()): Promise<FocusView & { released: number }> {
  await prisma.userDeskState.upsert({
    where: { userId },
    create: { userId, focusUntil: null, focusStartedAt: null },
    update: { focusUntil: null, focusStartedAt: null },
  });
  const released = await releaseHeldNotifications(userId);
  return { ...(await focusView(userId, now)), released };
}

/**
 * Deliver what focus queued: clear held_at on the person's held rows (they
 * appear in the bell, at their original time) and send their pushes now.
 * Only when focus is NOT on — a no-op otherwise. Idempotent: the conditional
 * update claims each row once, so two concurrent releases never push twice.
 */
export async function releaseHeldNotifications(userId: string, now: Date = new Date()): Promise<number> {
  if (isFocusActive(await getFocusState(userId), now)) return 0;
  const held = await prisma.notification.findMany({
    where: { userId, heldAt: { not: null } },
    orderBy: { createdAt: "asc" },
    take: 500,
    select: { id: true, workspaceId: true, userId: true, kind: true, title: true, body: true, href: true, sourceType: true, sourceId: true, dedupKey: true },
  });
  if (held.length === 0) return 0;
  const claimed: typeof held = [];
  for (const row of held) {
    const res = await prisma.notification.updateMany({ where: { id: row.id, heldAt: { not: null } }, data: { heldAt: null } });
    if (res.count === 1) claimed.push(row);
  }
  if (claimed.length) {
    try {
      // Phase 18.1 integration: the person's push channel (lib/preferences)
      // decides what a released row pushes, exactly as when it was written.
      const pushable = await filterByNotificationPrefs(claimed, "push");
      if (pushable.length === 0) return claimed.length;
      queuePushForNotifications(
        pushable.map((r) => ({
          workspaceId: r.workspaceId,
          userId: r.userId,
          kind: r.kind as NotificationKind,
          title: r.title,
          body: r.body,
          href: r.href,
          sourceType: r.sourceType,
          sourceId: r.sourceId,
          dedupKey: r.dedupKey,
        })),
      );
    } catch {
      // push is best-effort; the rows are in the bell either way
    }
  }
  return claimed.length;
}

/** Sweep: release the held rows of everyone whose focus has ended (cron). */
export async function releaseEndedFocus(now: Date = new Date(), limit = 500): Promise<{ users: number; released: number }> {
  const rows = await prisma.notification.findMany({
    where: { heldAt: { not: null } },
    distinct: ["userId"],
    select: { userId: true },
    take: limit,
  });
  let users = 0;
  let released = 0;
  for (const r of rows) {
    const n = await releaseHeldNotifications(r.userId, now);
    if (n > 0) {
      users++;
      released += n;
    }
  }
  return { users, released };
}
