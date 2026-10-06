// ShapesOS — Phase 18.3 (WS=trust): the notification channel matrix (pure).
//
// ONE preference store (UserPreference.notifications, lib/preferences): the
// person's channel switches + per kind × channel choices. This module decides,
// for one person, one kind and one channel, whether to deliver. Order:
//   1. a muted kind goes nowhere (and the producers write no row at all);
//   2. the channel's own switch (the bell; phone push follows the bell;
//      Web Push, the email digest and Slack are opt-in);
//   3. the person's choice for this kind on this channel, else the default
//      below (today's behaviour: every kind in the bell; phone push for the
//      approval, failure, message, reminder, ticket and meeting kinds).
// Focus / do not disturb is applied by the producers before any delivery.

import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
  type NotificationChannel,
  type NotificationKindPref,
  type NotificationPrefs,
} from "@/lib/preferences/schema";

export { NOTIFICATION_CHANNELS, type NotificationChannel };

type Row = Record<NotificationChannel, boolean>;
const all = (on: boolean): Row => ({ inApp: true, push: on, webPush: on, email: true, slack: on });

/** Default channels per kind (a person's own choices override a cell). */
export const DEFAULT_KIND_CHANNELS: Readonly<Record<NotificationKindPref, Row>> = {
  approval_needed: all(true),
  approval_decided: all(true),
  alert_fired: { ...all(false), slack: true },
  run_failed: all(true),
  invite_accepted: all(false),
  mention: all(true),
  direct_message: all(true),
  reminder_due: all(true),
  run_finished: { ...all(false), webPush: true },
  invoice_paid: all(false),
  ticket_assigned: all(true),
  meeting_starting: all(true),
};

/**
 * Cells that can't be chosen: alerts and accepted invites never go to the
 * phone (lib/push/devices.ts PUSH_KINDS) — team news, not a call to act.
 */
export const FIXED_OFF: Readonly<Partial<Record<NotificationKindPref, readonly NotificationChannel[]>>> = {
  alert_fired: ["push"],
  invite_accepted: ["push"],
};

export function cellAvailable(kind: NotificationKindPref, channel: NotificationChannel): boolean {
  return !(FIXED_OFF[kind] ?? []).includes(channel);
}

export function isNotificationKind(v: unknown): v is NotificationKindPref {
  return typeof v === "string" && (NOTIFICATION_KINDS as readonly string[]).includes(v);
}

/** The channel's own switch. PURE. */
export function channelOn(prefs: NotificationPrefs, channel: NotificationChannel): boolean {
  switch (channel) {
    case "inApp":
      return prefs.inApp;
    case "push":
      // Phone push follows the bell (Phase 18.1).
      return prefs.inApp && prefs.push;
    case "webPush":
      return prefs.webPush === true;
    case "email":
      return prefs.emailDigest === "daily";
    case "slack":
      return prefs.slack === true;
  }
}

/** The person's choice for this kind on this channel (or the default). PURE. */
export function kindChannelChoice(prefs: NotificationPrefs, kind: NotificationKindPref, channel: NotificationChannel): boolean {
  const own = prefs.channels?.[kind]?.[channel];
  return typeof own === "boolean" ? own : DEFAULT_KIND_CHANNELS[kind][channel];
}

/** Deliver this kind to this person on this channel? PURE. */
export function channelAllows(prefs: NotificationPrefs, kind: string, channel: NotificationChannel): boolean {
  if (!isNotificationKind(kind)) return channel === "inApp" ? prefs.inApp : false;
  if ((prefs.mutedKinds as string[]).includes(kind)) return false;
  if (!channelOn(prefs, channel)) return false;
  if (!cellAvailable(kind, channel)) return false;
  return kindChannelChoice(prefs, kind, channel);
}
