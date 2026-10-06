// ShapesOS — Phase 18.3 (WS=trust): delivering notification rows that were
// just written (or just released from focus) to the person's channels.
//
// The bell row IS the in-app channel. For rows delivered NOW (not held by
// focus / do not disturb), each other channel gets the rows its recipients
// allow (lib/notifications/channels.ts via filterByNotificationPrefs):
//   push     the mobile app (Expo, lib/push/notify.ts — unchanged path)
//   webPush  this browser (lib/push/web.ts sendWebPush — WS=flow's seam)
//   slack    a Slack DM (lib/notifications/slack.ts)
// The email digest is not sent here: it collects unread rows once a day
// (lib/notifications/digest.ts). Fire-and-forget like push: the action that
// produced the notification never waits on, or fails because of, a channel.

import { filterByNotificationPrefs } from "@/lib/preferences";
import { queuePushForNotifications } from "@/lib/push/notify";
// Phase 18.3 integration: WS=flow's real Web Push sender (VAPID + aes128gcm,
// push_subscriptions) — the typed stub WS=trust left is gone. Static import so
// a test that mocks lib/push/web reaches it (Node 22.23 mock.module rule).
import { sendWebPush } from "@/lib/push/web";
import type { NotificationInput } from "./store";

export interface DeliverDeps {
  push?: (inputs: NotificationInput[]) => void;
  webPush?: (userId: string, n: NotificationInput) => Promise<unknown>;
  slack?: (inputs: NotificationInput[]) => Promise<unknown>;
  filter?: typeof filterByNotificationPrefs;
}

/** Deliveries in flight (tests await them; each removes itself when done). */
const pending = new Set<Promise<unknown>>();
function track(p: Promise<unknown>): void {
  const tracked = p.catch(() => undefined).finally(() => pending.delete(tracked));
  pending.add(tracked);
}
export async function settleDeliveries(): Promise<void> {
  await Promise.allSettled([...pending]);
}

export async function deliverNow(inputs: readonly NotificationInput[], deps: DeliverDeps = {}): Promise<void> {
  if (inputs.length === 0) return;
  const filter = deps.filter ?? filterByNotificationPrefs;
  const [pushable, webPushable, slackable] = await Promise.all([
    filter(inputs, "push"),
    filter(inputs, "webPush"),
    filter(inputs, "slack"),
  ]);
  if (pushable.length) (deps.push ?? queuePushForNotifications)(pushable);
  if (webPushable.length) {
    const send =
      deps.webPush ??
      ((userId: string, n: NotificationInput) =>
        sendWebPush(userId, { kind: n.kind, title: n.title, body: n.body ?? null, href: n.href ?? null, tag: n.dedupKey ?? null }));
    for (const n of webPushable) track(send(n.userId, n));
  }
  if (slackable.length) {
    const send =
      deps.slack ??
      (async (list: NotificationInput[]) => {
        const { deliverSlack } = await import("./slack");
        return deliverSlack(list);
      });
    track(send(slackable));
  }
}
