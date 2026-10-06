// ShapesOS — Phase 18.3: Web Push delivery — THE SEAM between the two 18.3
// workstreams.
//
//   WS=flow owns this file's real implementation (branch claude/p18-3-flow:
//   the service worker, push_subscriptions, VAPID + aes128gcm with
//   node:crypto). WS=trust (lib/notifications/deliver.ts) calls
//   sendWebPush(userId, payload) for every notification row whose
//   recipient's Web Push channel allows the kind (lib/notifications/
//   channels.ts), after focus / do not disturb.
//
// THIS IS A TYPED STUB written by WS=trust so this branch builds on its own:
// it sends nothing and says so ({ skipped: "not_configured" }). The types and
// the signature below are copied from WS=flow's branch, so at integration
// WS=flow's file simply replaces this one.

/** What a push shows. Kept small: one 4 KB encrypted message carries it all. */
export interface WebPushPayload {
  title: string;
  body?: string | null;
  /** Where a click goes (same-origin path only). */
  href?: string | null;
  /** Notification kind (for the service worker's tag / grouping). */
  kind?: string | null;
  /** Replaces an earlier push with the same tag on the device. */
  tag?: string | null;
}

export interface WebPushResult {
  sent: number;
  failed: number;
  removed: number;
  skipped: "not_configured" | "no_subscriptions" | null;
  reason?: string;
}

/** Send one push to every browser this person subscribed. Never throws. STUB: sends nothing. */
export async function sendWebPush(userId: string, payload: WebPushPayload): Promise<WebPushResult> {
  void userId;
  void payload;
  return { sent: 0, failed: 0, removed: 0, skipped: "not_configured", reason: "Web Push is delivered by WS=flow's lib/push/web.ts (stub in this branch)." };
}
