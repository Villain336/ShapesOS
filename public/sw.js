/* ShapesOS — Phase 18.3 (WS=flow): the service worker.
 *
 * Registered by components/offline/OfflineProvider.tsx (scope "/").
 * lib/offline/__tests__/service-worker.test.ts runs THIS file in a fake
 * worker (fake caches + fetch) and checks every rule below:
 *
 *   1. NEVER cache HTML. Every app page carries the per-request CSP nonce
 *      (proxy.ts) and is authenticated; a cached page would replay an old
 *      nonce and could show one person's page to the next. Navigations go to
 *      the network; when it is down the static /offline.html answers (served
 *      with its own script-src 'self' CSP), which reads the read cache below.
 *   2. Static assets (/_next/static/* hashed build files, /pwa/*, /brand/*,
 *      /offline.*): cache-first. Not in development (?dev=1): dev chunks keep
 *      their names across rebuilds.
 *   3. The offline READ cache: GET JSON from the Home, Mail, Calendar, Notes,
 *      Reminders and Files APIs (DATA_ROUTES), network-first — the app
 *      always sees fresh data online — falling back to the last copy when
 *      the network is down. Stored PER PERSON (cache "shapes-data-<key>",
 *      key = a hash of the signed-in subject posted by the app) and deleted
 *      on sign-out (the POST to /api/auth/signout is seen here) and whenever
 *      another person signs in on this browser. No key = nothing cached.
 *   4. Writes are never cached or replayed here: the app queues its few safe
 *      writes itself (lib/offline/queue.ts) and replays them when online.
 *   5. Web Push: show the notification (lib/push/web.ts payload) and open its
 *      same-origin link on click.
 */

const VERSION = "2026-10-06.1";
const STATIC_CACHE = "shapes-static-" + VERSION;
const META_CACHE = "shapes-meta";
const DATA_PREFIX = "shapes-data-";
const SESSION_URL = "/__shapes/session";
const STRINGS_URL = "/__shapes/strings";
const TOKENS_URL = "/__shapes/tokens";
const OFFLINE_URL = "/offline.html";
const PRECACHE = ["/offline.html", "/offline.js", "/pwa/icon-192.png"];
const STATIC_MAX = 300;
const DEV = new URL(self.location.href).searchParams.get("dev") === "1";

const DATA_ROUTES = [
  /^\/api\/desk\/(layout|briefing)$/,
  /^\/api\/comms\/mail\/threads$/,
  /^\/api\/comms\/mail\/thread$/,
  /^\/api\/comms\/calendar\/events$/,
  /^\/api\/notes$/,
  /^\/api\/notes\/[A-Za-z0-9_-]{1,64}$/,
  /^\/api\/comms\/reminders$/,
  /^\/api\/files$/,
];
const STATIC_ROUTES = [/^\/_next\/static\//, /^\/pwa\//, /^\/brand\//, /^\/offline\.(html|js)$/];
const OFFLINE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

let sessionKey = null; // memo of META_CACHE SESSION_URL

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("shapes-static-") && k !== STATIC_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function readMeta(url) {
  const c = await caches.open(META_CACHE);
  const r = await c.match(url);
  return r ? r.json() : null;
}

async function writeMeta(url, value) {
  const c = await caches.open(META_CACHE);
  await c.put(url, new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }));
}

async function currentKey() {
  if (sessionKey) return sessionKey;
  const s = await readMeta(SESSION_URL);
  sessionKey = s && typeof s.key === "string" ? s.key : null;
  return sessionKey;
}

/** Delete every person's data cache (sign-out), or every one but `keep`. */
async function purgeData(keep) {
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k.startsWith(DATA_PREFIX) && k !== keep).map((k) => caches.delete(k)));
}

async function signOut() {
  sessionKey = null;
  await purgeData(null);
  const c = await caches.open(META_CACHE);
  await c.delete(SESSION_URL);
}

self.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (event.origin && event.origin !== self.location.origin) return;
  if (msg.type === "session" && typeof msg.key === "string" && /^[a-f0-9]{16,64}$/.test(msg.key)) {
    event.waitUntil(
      (async () => {
        const prev = await currentKey();
        if (prev !== msg.key) await purgeData(DATA_PREFIX + msg.key);
        sessionKey = msg.key;
        await writeMeta(SESSION_URL, { key: msg.key });
        if (msg.strings && typeof msg.strings === "object") await writeMeta(STRINGS_URL, msg.strings);
        if (msg.tokens && typeof msg.tokens === "object") await writeMeta(TOKENS_URL, msg.tokens);
      })(),
    );
  } else if (msg.type === "signout") {
    event.waitUntil(signOut());
  }
});

function isDataRoute(url) {
  return DATA_ROUTES.some((re) => re.test(url.pathname));
}

function isStaticRoute(url) {
  return STATIC_ROUTES.some((re) => re.test(url.pathname));
}

function isHtml(res) {
  return (res.headers.get("content-type") || "").includes("text/html");
}

async function trimStatic() {
  const c = await caches.open(STATIC_CACHE);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - STATIC_MAX; i++) await c.delete(keys[i]);
}

async function staticFirst(req) {
  const c = await caches.open(STATIC_CACHE);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.type === "basic" && !isHtml(res)) {
    await c.put(req, res.clone());
    trimStatic();
  }
  return res;
}

async function dataNetworkFirst(req) {
  const key = await currentKey();
  if (!key) return fetch(req);
  const cache = await caches.open(DATA_PREFIX + key);
  try {
    const res = await fetch(req);
    const type = res.headers.get("content-type") || "";
    if (res.ok && res.type === "basic" && type.includes("application/json")) await cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = (await cache.match(req)) || (await cache.match(req, { ignoreSearch: true }));
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set("x-shapes-offline", "1");
      return new Response(await hit.blob(), { status: 200, headers });
    }
    throw err;
  }
}

async function offlinePage() {
  const c = await caches.open(STATIC_CACHE);
  const hit = await c.match(OFFLINE_URL);
  const body = hit ? await hit.text() : "<!doctype html><title>Offline</title><p>You're offline.</p>";
  return new Response(body, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": OFFLINE_CSP, "cache-control": "no-store" },
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Sign-out (Auth.js POSTs here): forget every person's cached data first.
  if (req.method === "POST" && url.pathname === "/api/auth/signout") {
    event.respondWith(signOut().then(() => fetch(req)));
    return;
  }
  if (req.method !== "GET") return;

  if (req.mode === "navigate") {
    // Never cached: the page carries the request's CSP nonce and the person's data.
    event.respondWith(fetch(req).catch(() => offlinePage()));
    return;
  }
  if (isDataRoute(url)) {
    event.respondWith(dataNetworkFirst(req));
    return;
  }
  if (!DEV && isStaticRoute(url)) {
    event.respondWith(staticFirst(req));
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "ShapesOS", body: event.data ? event.data.text() : "" };
  }
  const href = typeof data.href === "string" && data.href.startsWith("/") && !data.href.startsWith("//") ? data.href : "/dashboard/notifications";
  event.waitUntil(
    self.registration.showNotification(data.title || "ShapesOS", {
      body: data.body || "",
      tag: data.tag || data.kind || undefined,
      icon: "/pwa/icon-192.png",
      badge: "/pwa/icon-192.png",
      data: { href },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const href = (event.notification.data && event.notification.data.href) || "/dashboard/notifications";
  const target = new URL(href, self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (new URL(c.url).origin === self.location.origin && "focus" in c) {
          c.navigate(target.href);
          return c.focus();
        }
      }
      return self.clients.openWindow(target.href);
    }),
  );
});
