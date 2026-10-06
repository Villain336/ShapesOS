// ShapesOS — Phase 18.3 (WS=flow): Web Push delivery.
//
// THE SEAM for WS=trust's notification channel: `sendWebPush(userId, payload)`
// sends one push to every browser the person subscribed (Settings → You →
// Notifications, or the Notifications page's "This browser" switch) and
// cleans up dead subscriptions. lib/notifications decides WHETHER a person
// gets a push (their channels, muted kinds, focus); this file only delivers.
//
//   - VAPID (RFC 8292) + aes128gcm (RFC 8291) with node:crypto (lib/push/vapid.ts);
//     no web-push package.
//   - Without VAPID keys Web Push is OFF: sendWebPush returns
//     { skipped: "not_configured", reason } and the UI hides the option and
//     says why. Nothing is faked.
//   - push_subscriptions is owner-only FORCE RLS on app.user_id: every read
//     and write here runs inside withPushUserScope(userId).
//   - The push service's answer drives hygiene: 201/202 = sent (failure count
//     reset); 404/410 = the subscription is gone → row deleted at once; any
//     other error bumps failure_count, and MAX_FAILURES in a row deletes it.
//   - SSRF guard: endpoints are https URLs on the known browser push
//     services only (PUSH_SERVICE_HOSTS; WEB_PUSH_EXTRA_HOSTS adds more for a
//     self-hosted push service). A subscription naming any other host is
//     refused at subscribe time and never contacted.
//   - Never throws; best-effort like every notification producer.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { USER_GUC } from "@/lib/desktop/scope";
import { log } from "@/lib/observability/log";
import { audienceFor, encryptAes128gcm, fromB64url, signVapidJwt, vapidAuthorization, vapidConfigFromEnv, MAX_PLAINTEXT } from "./vapid";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: Uint8Array; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

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

export const MAX_FAILURES = 5;
export const MAX_SUBSCRIPTIONS_PER_USER = 20;

/** Browser push services (Chrome/Edge via FCM, Firefox, Windows, Safari). */
export const PUSH_SERVICE_HOSTS: readonly string[] = [
  "fcm.googleapis.com",
  "android.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.services.mozilla.com",
  "notify.windows.com",
  "push.apple.com",
];

function extraHosts(env: NodeJS.ProcessEnv): string[] {
  return (env.WEB_PUSH_EXTRA_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[a-z0-9.-]+$/.test(h));
}

/** Is this a push endpoint we may POST to? https + a known push-service host (or a subdomain of one). */
export function isAllowedPushEndpoint(endpoint: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof endpoint !== "string" || endpoint.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
  const host = url.hostname.toLowerCase();
  return [...PUSH_SERVICE_HOSTS, ...extraHosts(env)].some((h) => host === h || host.endsWith(`.${h}`));
}

export interface SubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string | null;
  /** Phase 18.3 integration: the sign-in session that subscribed (token.sid). */
  sessionId?: string | null;
}

/** Validate a browser PushSubscription.toJSON(); null = refused (with why). */
export function parseSubscription(raw: unknown, env: NodeJS.ProcessEnv = process.env): { ok: true; value: SubscriptionInput } | { ok: false; error: string } {
  const r = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const endpoint = typeof r?.endpoint === "string" ? r.endpoint.trim() : "";
  const p256dh = typeof r?.keys?.p256dh === "string" ? r.keys.p256dh.trim() : "";
  const auth = typeof r?.keys?.auth === "string" ? r.keys.auth.trim() : "";
  if (!endpoint || !p256dh || !auth) return { ok: false, error: "A subscription needs endpoint, keys.p256dh and keys.auth." };
  if (!isAllowedPushEndpoint(endpoint, env)) return { ok: false, error: "That push service is not supported." };
  try {
    const pk = fromB64url(p256dh);
    if (pk.length !== 65 || pk[0] !== 0x04) return { ok: false, error: "keys.p256dh is not a P-256 public key." };
    if (fromB64url(auth).length !== 16) return { ok: false, error: "keys.auth must be 16 bytes." };
  } catch {
    return { ok: false, error: "The subscription keys are not base64url." };
  }
  return { ok: true, value: { endpoint, keys: { p256dh, auth } } };
}

/** The JSON the service worker receives (lib/push/web.ts ↔ public/sw.js). */
export function pushJson(payload: WebPushPayload): string {
  const href = typeof payload.href === "string" && payload.href.startsWith("/") && !payload.href.startsWith("//") ? payload.href.slice(0, 500) : "/dashboard/notifications";
  const msg = {
    title: (payload.title || "ShapesOS").slice(0, 120),
    body: (payload.body ?? "").slice(0, 300) || undefined,
    href,
    kind: payload.kind ?? undefined,
    tag: payload.tag ? payload.tag.slice(0, 64) : undefined,
  };
  const json = JSON.stringify(msg);
  return Buffer.byteLength(json) <= MAX_PLAINTEXT ? json : JSON.stringify({ ...msg, body: undefined });
}

type Tx = Prisma.TransactionClient;

/** Run fn with app.user_id = userId (push_subscriptions is owner-only FORCE RLS). */
export async function withPushUserScope<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!userId) throw new Error("withPushUserScope: userId is required");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config(${USER_GUC}, ${userId}, true)`;
    return fn(tx);
  });
}

export interface SubscriptionView {
  id: string;
  endpointHost: string;
  userAgent: string | null;
  createdAt: string;
  lastSentAt: string | null;
}

export async function listWebPushSubscriptions(userId: string): Promise<SubscriptionView[]> {
  const rows = await withPushUserScope(userId, (tx) => tx.pushSubscription.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }));
  return rows.map((r) => ({
    id: r.id,
    endpointHost: new URL(r.endpoint).hostname,
    userAgent: r.userAgent,
    createdAt: r.createdAt.toISOString(),
    lastSentAt: r.lastSentAt?.toISOString() ?? null,
  }));
}

/** Save (or refresh the keys of) this browser's subscription for this person. */
export async function saveWebPushSubscription(userId: string, sub: SubscriptionInput): Promise<{ id: string }> {
  return withPushUserScope(userId, async (tx) => {
    const existing = await tx.pushSubscription.findUnique({ where: { userId_endpoint: { userId, endpoint: sub.endpoint } }, select: { id: true } });
    if (!existing) {
      const n = await tx.pushSubscription.count({ where: { userId } });
      if (n >= MAX_SUBSCRIPTIONS_PER_USER) {
        // Keep the newest: the oldest browser falls off.
        const oldest = await tx.pushSubscription.findFirst({ where: { userId }, orderBy: { createdAt: "asc" }, select: { id: true } });
        if (oldest) await tx.pushSubscription.delete({ where: { id: oldest.id } });
      }
    }
    const row = await tx.pushSubscription.upsert({
      where: { userId_endpoint: { userId, endpoint: sub.endpoint } },
      create: { userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, authSecret: sub.keys.auth, userAgent: sub.userAgent?.slice(0, 300) ?? null, sessionId: sub.sessionId?.slice(0, 64) ?? null },
      // A re-subscribe from a new sign-in moves the browser to that session.
      update: { p256dh: sub.keys.p256dh, authSecret: sub.keys.auth, failureCount: 0, lastError: null, userAgent: sub.userAgent?.slice(0, 300) ?? undefined, sessionId: sub.sessionId?.slice(0, 64) ?? null },
      select: { id: true },
    });
    return row;
  });
}

/**
 * Phase 18.3 integration: a sign-in session ended (WS=trust's revoke) — remove
 * the subscriptions that session made, inside the caller's owner-scoped
 * transaction (app.user_id already set to `userId`).
 *   { only: sid }    one revoked session's browsers;
 *   { except: sid }  "sign out other sessions": every browser but the current
 *                    session's (subscriptions from pre-registry tokens too —
 *                    those tokens are cut off as well). except null = all.
 */
export async function removeSessionSubscriptions(tx: Tx, userId: string, by: { only: string } | { except: string | null }): Promise<number> {
  const where: Prisma.PushSubscriptionWhereInput =
    "only" in by
      ? { userId, sessionId: by.only }
      : by.except
        ? { userId, OR: [{ sessionId: null }, { sessionId: { not: by.except } }] }
        : { userId };
  const res = await tx.pushSubscription.deleteMany({ where });
  return res.count;
}

/** Remove one of this person's subscriptions (by endpoint or id). */
export async function removeWebPushSubscription(userId: string, by: { endpoint?: string; id?: string }): Promise<number> {
  if (!by.endpoint && !by.id) return 0;
  return withPushUserScope(userId, async (tx) => {
    const res = await tx.pushSubscription.deleteMany({ where: { userId, ...(by.endpoint ? { endpoint: by.endpoint } : {}), ...(by.id ? { id: by.id } : {}) } });
    return res.count;
  });
}

export interface WebPushDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Seconds the push service keeps an undelivered message (default 1 day). */
  ttl?: number;
}

const defaultFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body as unknown as BodyInit, signal: init.signal, redirect: "manual" });
  return { status: res.status, text: () => res.text() };
};

/**
 * Send one push to every browser `userId` subscribed. Awaitable; never throws.
 * The caller (lib/notifications, WS=trust) has already decided this person
 * wants a Web Push for this notification.
 */
export async function sendWebPush(userId: string, payload: WebPushPayload, deps: WebPushDeps = {}): Promise<WebPushResult> {
  const env = deps.env ?? process.env;
  const result: WebPushResult = { sent: 0, failed: 0, removed: 0, skipped: null };
  const vapid = vapidConfigFromEnv(env);
  if (!vapid.configured) return { ...result, skipped: "not_configured", reason: vapid.reason };
  if (!userId) return { ...result, skipped: "no_subscriptions" };
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const now = deps.now ?? Date.now;
  try {
    const subs = await withPushUserScope(userId, (tx) => tx.pushSubscription.findMany({ where: { userId } }));
    if (subs.length === 0) return { ...result, skipped: "no_subscriptions" };
    const json = pushJson(payload);
    const jwtByAudience = new Map<string, string>();
    const outcomes: Array<{ id: string; status: "sent" | "gone" | "failed"; error?: string }> = [];
    for (const s of subs) {
      if (!isAllowedPushEndpoint(s.endpoint, env)) {
        outcomes.push({ id: s.id, status: "gone", error: "endpoint host not allowed" });
        continue;
      }
      try {
        const aud = audienceFor(s.endpoint);
        let jwt = jwtByAudience.get(aud);
        if (!jwt) {
          jwt = signVapidJwt({ audience: aud, subject: vapid.config.subject, publicKey: vapid.config.publicKey, privateKey: vapid.config.privateKey, now: now() });
          jwtByAudience.set(aud, jwt);
        }
        const { body } = encryptAes128gcm({ p256dh: s.p256dh, auth: s.authSecret, plaintext: json });
        const res = await fetchImpl(s.endpoint, {
          method: "POST",
          headers: {
            Authorization: vapidAuthorization(jwt, vapid.config.publicKey),
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            TTL: String(deps.ttl ?? 86_400),
            Urgency: payload.kind === "approval_needed" || payload.kind === "run_failed" ? "high" : "normal",
            ...(payload.tag ? { Topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "shapes" } : {}),
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status >= 200 && res.status < 300) outcomes.push({ id: s.id, status: "sent" });
        else if (res.status === 404 || res.status === 410) outcomes.push({ id: s.id, status: "gone", error: `push service ${res.status}` });
        else outcomes.push({ id: s.id, status: "failed", error: `push service ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}` });
      } catch (err) {
        outcomes.push({ id: s.id, status: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
      }
    }
    await withPushUserScope(userId, async (tx) => {
      for (const o of outcomes) {
        if (o.status === "sent") {
          await tx.pushSubscription.update({ where: { id: o.id }, data: { failureCount: 0, lastError: null, lastSentAt: new Date(now()) } });
          result.sent++;
        } else if (o.status === "gone") {
          await tx.pushSubscription.deleteMany({ where: { id: o.id } });
          result.removed++;
          result.failed++;
        } else {
          const row = await tx.pushSubscription.update({ where: { id: o.id }, data: { failureCount: { increment: 1 }, lastError: o.error?.slice(0, 300) ?? null } });
          result.failed++;
          if (row.failureCount >= MAX_FAILURES) {
            await tx.pushSubscription.deleteMany({ where: { id: o.id } });
            result.removed++;
          }
        }
      }
    });
  } catch (err) {
    log.warn("web push failed", { userId, err });
  }
  return result;
}
