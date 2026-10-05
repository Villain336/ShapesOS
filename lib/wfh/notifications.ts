// Marketr — Wave 2 WFH mode slice 2: async-first notification routing.
//
// While WFH mode is effectively on and the notification profile is batched,
// non-urgent notifications are held for digest windows (default 2x/day,
// configurable). Urgent notifications — approval gates, money movement,
// customer-facing — always break through immediately. Realtime profile or
// office mode = deliver now. Everything here is pure; persistence lives in
// WfhDigestItem and the /api/wfh/notifications + /api/wfh/digest routes.

import type { WorkModeState } from "./mode";
import { isWfhEffectiveOn } from "./mode";
import { DEFAULT_TIME_ZONE, resolveTimeZone, zonedParts, zonedTimeToUtc } from "@/lib/time/zoned";

export type NotificationUrgency = "urgent" | "routine";

/** Notification kinds that always break through, no matter the mode. */
const URGENT_KINDS = new Set([
  "approval_requested", // approval gates (proposals, sign-offs, spend)
  "approval_decided",
  "money_moved", // ledger postings, payouts, billing events
  "payment_failed",
  "customer_message", // customer-facing inbound
  "customer_escalation",
  "security_alert",
]);

/** Kinds that are routine by default; callers may override per event. */
const ROUTINE_KINDS = new Set([
  "standup_reminder",
  "ritual_occurrence",
  "report_ready",
  "digest_available",
  "comment",
  "reaction",
  "mention",
  "system_update",
]);

export interface RoutableNotification {
  kind: string;
  /** Explicit override: true forces urgent, false forces routine. */
  urgentOverride?: boolean;
  title: string;
  body?: string;
  link?: string;
}

/**
 * Classify a notification's urgency. Explicit override wins; known urgent
 * kinds break through; unknown kinds default to routine (batched) — a
 * fail-open-toward-quiet choice, since senders can always override to urgent.
 */
export function classifyUrgency(n: RoutableNotification): NotificationUrgency {
  if (n.urgentOverride === true) return "urgent";
  if (n.urgentOverride === false) return "routine";
  if (URGENT_KINDS.has(n.kind)) return "urgent";
  return "routine";
}

export interface DigestWindowConfig {
  /** Minutes since midnight local, sorted ascending. Default 2x/day. */
  timesMin: number[];
}

export const DEFAULT_DIGEST_TIMES_MIN = [540, 960]; // 09:00 + 16:00

export function resolveDigestWindows(input?: number[] | null): DigestWindowConfig {
  const times = (input ?? [])
    .filter((t) => Number.isInteger(t) && t >= 0 && t < 1440)
    .sort((a, b) => a - b);
  const deduped = [...new Set(times)];
  return { timesMin: deduped.length > 0 ? deduped : [...DEFAULT_DIGEST_TIMES_MIN] };
}

export type DeliveryDecision =
  | { deliver: "now"; reason: string }
  | { deliver: "digest"; reason: string; windowMin: number };

export interface RoutingContext {
  mode: WorkModeState | null;
  notificationProfile: "realtime" | "batched";
  at: Date;
  digestTimesMin?: number[] | null;
}

/**
 * Decide whether a notification delivers now or waits for a digest window.
 * Pure — the caller persists the decision (WfhDigestItem) and flushes due
 * windows via dueWindowsFor().
 */
export function routeNotification(
  n: RoutableNotification,
  ctx: RoutingContext,
): DeliveryDecision {
  const urgency = classifyUrgency(n);
  if (urgency === "urgent") {
    return { deliver: "now", reason: "urgent_breakthrough" };
  }
  if (ctx.notificationProfile === "realtime") {
    return { deliver: "now", reason: "realtime_profile" };
  }
  if (!isWfhEffectiveOn(ctx.mode, ctx.at)) {
    return { deliver: "now", reason: "wfh_not_effective" };
  }
  const windows = resolveDigestWindows(ctx.digestTimesMin);
  const windowMin = nextWindowMin(windows.timesMin, ctx.at, ctx.mode?.timezone ?? DEFAULT_TIME_ZONE);
  return { deliver: "digest", reason: "batched_digest", windowMin };
}

/**
 * Next digest window at or after `at` (minutes since midnight in the user's
 * IANA timezone — never the server's).
 */
export function nextWindowMin(timesMin: number[], at: Date, timeZone: string = DEFAULT_TIME_ZONE): number {
  const nowMin = zonedParts(at, resolveTimeZone(timeZone)).minutes;
  for (const t of timesMin) {
    if (t >= nowMin) return t;
  }
  return timesMin[0]; // wraps to tomorrow's first window
}

/**
 * Which digest windows are due at `at`, given the last flush per window?
 * `lastFlushedAt` maps windowMin -> ISO timestamp of the last flush. A window
 * is due when its local time today has passed and it hasn't been flushed
 * since that moment. Local day and times are read in `timeZone`.
 */
export function dueWindowsFor(
  timesMin: number[],
  at: Date,
  lastFlushedAt: Record<number, string | null>,
  timeZone: string = DEFAULT_TIME_ZONE,
): number[] {
  const tz = resolveTimeZone(timeZone);
  const today = zonedParts(at, tz);
  return timesMin.filter((t) => {
    if (t > today.minutes) return false;
    const last = lastFlushedAt[t];
    if (!last) return true;
    // The instant this window opened today (DST-safe: converted on its own).
    const windowOpened = zonedTimeToUtc(today.year, today.month, today.day, t, tz).date;
    return new Date(last).getTime() < windowOpened.getTime();
  });
}

export interface DigestItem {
  kind: string;
  title: string;
  body?: string;
  link?: string;
  queuedAt: string;
}

export interface AssembledDigest {
  windowMin: number;
  itemCount: number;
  groups: { kind: string; count: number; titles: string[] }[];
  headline: string;
}

/**
 * Assemble queued items into a digest summary. Groups by kind with counts;
 * the headline reads like a human wrote it ("3 updates while you were focused").
 */
export function assembleDigest(windowMin: number, items: DigestItem[]): AssembledDigest {
  const byKind = new Map<string, DigestItem[]>();
  for (const item of items) {
    const list = byKind.get(item.kind) ?? [];
    list.push(item);
    byKind.set(item.kind, list);
  }
  const groups = [...byKind.entries()].map(([kind, list]) => ({
    kind,
    count: list.length,
    titles: list.slice(0, 5).map((i) => i.title),
  }));
  const n = items.length;
  const hh = String(Math.floor(windowMin / 60)).padStart(2, "0");
  const mm = String(windowMin % 60).padStart(2, "0");
  return {
    windowMin,
    itemCount: n,
    groups,
    headline:
      n === 0
        ? `Nothing queued for the ${hh}:${mm} digest.`
        : `${n} update${n === 1 ? "" : "s"} while you were focused — ${hh}:${mm} digest.`,
  };
}
