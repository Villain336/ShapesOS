// ShapesOS — Phase 18.3: Web Push delivery — THE SEAM between the two 18.3
// workstreams.
//
//   WS=flow owns this file's real implementation: the service worker, the
//   browser push subscriptions (storage + subscribe/unsubscribe routes) and
//   VAPID signing with node:crypto (ECDSA P-256 / aes128gcm, RFC 8291/8292).
//   WS=trust (lib/notifications/deliver.ts) calls sendWebPush() for every
//   notification row whose recipient's Web Push channel allows the kind
//   (lib/notifications/channels.ts), after focus / do not disturb.
//
// THIS IS A TYPED STUB written by WS=trust: it sends nothing and says so
// ({ sent: 0, skipped: "not_configured" }). The integrator replaces the body
// with WS=flow's implementation; the signature below is the contract.

export interface WebPushPayload {
  /** Notification kind (lib/preferences NOTIFICATION_KINDS). */
  kind: string;
  workspaceId: string;
  title: string;
  body?: string | null;
  /** Same-app link to open on click ("/dashboard/…"). */
  href?: string | null;
  /** Collapses repeats on the device (the notification's dedup key). */
  tag?: string | null;
}

export interface WebPushResult {
  sent: number;
  /** Why nothing was sent (no subscription, not configured, …). */
  skipped?: string | null;
}

/** Send one notification to every Web Push subscription of this person. Never throws. */
export async function sendWebPush(userId: string, payload: WebPushPayload): Promise<WebPushResult> {
  void userId;
  void payload;
  return { sent: 0, skipped: "not_configured" };
}
