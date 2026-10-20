// ShapesOS — Phase 18.1 (WS=desk): focus / do not disturb rules (PURE).
//
// Focus is a person's state (user_desk_state.focus_until), always with an end
// time. While it is on:
//   - every new notification for that person is QUEUED, never dropped: the
//     row is written with held_at set, so it is hidden from the bell and its
//     unread count and no push goes out (lib/notifications/store.ts);
//   - agent proposals still land in Needs you (the approvals inbox reads its
//     sources, not notifications) — only the interruption (the bell/push for
//     "approval needed") waits;
//   - when focus ends — switched off, or its end time passes — the queued rows
//     are released: held_at cleared (they appear in the bell, newest first)
//     and their pushes sent then (lib/desktop/focus.server.ts).

import type { NotificationKind } from "@prisma/client";

export interface FocusState {
  focusUntil: Date | null;
  focusStartedAt?: Date | null;
}

/** Durations offered in the Control Center, in minutes. */
export const FOCUS_PRESETS: readonly { minutes: number; label: string }[] = [
  { minutes: 30, label: "30 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 120, label: "2 hours" },
  { minutes: 240, label: "4 hours" },
  { minutes: 480, label: "8 hours" },
];

/** The longest focus session one switch can start (it always ends). */
export const FOCUS_MAX_MINUTES = 24 * 60;

export function isFocusActive(state: FocusState | null | undefined, now: Date = new Date()): boolean {
  return !!state?.focusUntil && state.focusUntil.getTime() > now.getTime();
}

/** When a focus session of `minutes` started `now` ends; throws on a bad duration. */
export function focusEndsAt(minutes: number, now: Date = new Date()): Date {
  if (!Number.isFinite(minutes) || !Number.isInteger(minutes) || minutes < 5 || minutes > FOCUS_MAX_MINUTES) {
    throw new RangeError(`Focus lasts between 5 minutes and ${FOCUS_MAX_MINUTES / 60} hours.`);
  }
  return new Date(now.getTime() + minutes * 60_000);
}

/** Validate an explicit end time ("until 3:30 pm"): in the future and within the maximum. */
export function validFocusEnd(until: Date, now: Date = new Date()): boolean {
  const ms = until.getTime() - now.getTime();
  return Number.isFinite(ms) && ms >= 60_000 && ms <= FOCUS_MAX_MINUTES * 60_000;
}

export type HoldDecision = { hold: true; until: Date; reason: "focus" } | { hold: false; reason: "not_in_focus" };

/**
 * Should a notification of `kind` for this person wait? Every kind waits
 * while focus is on: approvals still show in Needs you (the proposal is not
 * held, only the interruption), failures still show on the run and in the
 * sidebar's Running now. Nothing is dropped — held rows are released later.
 */
export function holdDecision(_kind: NotificationKind | string, state: FocusState | null | undefined, now: Date = new Date()): HoldDecision {
  if (!isFocusActive(state, now)) return { hold: false, reason: "not_in_focus" };
  return { hold: true, until: state!.focusUntil!, reason: "focus" };
}

/** Held rows must be released when focus is not (or no longer) on. */
export function shouldRelease(state: FocusState | null | undefined, now: Date = new Date()): boolean {
  return !isFocusActive(state, now);
}

/** "Until 3:30 PM" style label (the caller passes the viewer's locale/time zone formatter). */
export function focusLabel(state: FocusState | null | undefined, now: Date, fmt: (d: Date) => string): string {
  if (!isFocusActive(state, now)) return "Off";
  return `On until ${fmt(state!.focusUntil!)}`;
}
