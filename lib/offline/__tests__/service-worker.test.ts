// ShapesOS — Phase 18.3 (WS=flow): public/sw.js, run in a FAKE service
// worker (node:vm with fake caches, clients and fetch; real WHATWG
// Request/Response from Node). Checks the cache rules:
//   - HTML is never cached; an offline navigation gets /offline.html with
//     its own script-src 'self' CSP (never a cached app page / old nonce)
//   - the read cache is per person, network-first, served when offline
//     (marked x-shapes-offline), never without a session key, never for a
//     non-JSON (HTML) response, never for writes or other paths
//   - sign-out (POST /api/auth/signout) and a different person's session
//     purge the data caches
//   - static assets are cache-first except in dev (?dev=1)
//   - push shows a notification with a same-origin link only

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const SW_SOURCE = readFileSync(join(process.cwd(), "public/sw.js"), "utf8");
const ORIGIN = "https://app.shapes.test";

class FakeCache {
  store = new Map<string, Response>();
  async match(req: Request | string, opts?: { ignoreSearch?: boolean }) {
    const url = typeof req === "string" ? new URL(req, ORIGIN).href : req.url;
    const hit = this.store.get(url);
    if (hit) return hit.clone();
    if (opts?.ignoreSearch) {
      const bare = url.split("?")[0];
      for (const [k, v] of this.store) if (k.split("?")[0] === bare) return v.clone();
    }
    return undefined;
  }
  async put(req: Request | string, res: Response) {
    this.store.set(typeof req === "string" ? new URL(req, ORIGIN).href : req.url, res.clone());
  }
  async delete(req: Request | string) {
    return this.store.delete(typeof req === "string" ? new URL(req, ORIGIN).href : req.url);
  }
  async keys() {
    return [...this.store.keys()].map((u) => new Request(u));
  }
  async addAll(urls: string[]) {
    for (const u of urls) await this.put(u, new Response(u.endsWith(".html") ? "<!doctype html><title>Offline</title>" : "x", { headers: { "content-type": u.endsWith(".html") ? "text/html" : "text/javascript" } }));
  }
}

class FakeCacheStorage {
  caches = new Map<string, FakeCache>();
  async open(name: string) {
    if (!this.caches.has(name)) this.caches.set(name, new FakeCache());
    return this.caches.get(name)!;
  }
  async keys() {
    return [...this.caches.keys()];
  }
  async delete(name: string) {
    return this.caches.delete(name);
  }
}

type Handler = (e: unknown) => void;

function boot(opts: { dev?: boolean } = {}) {
  const listeners = new Map<string, Handler>();
  const storage = new FakeCacheStorage();
  const network = { online: true, calls: [] as string[], respond: (req: Request): Response => new Response(JSON.stringify({ url: req.url }), { headers: { "content-type": "application/json" } }) };
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const self = {
    location: new URL(`${ORIGIN}/sw.js${opts.dev ? "?dev=1" : ""}`),
    addEventListener: (type: string, fn: Handler) => listeners.set(type, fn),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined, matchAll: async () => [], openWindow: async () => undefined },
    registration: { showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }) },
  };
  const fetchImpl = async (req: Request) => {
    network.calls.push(`${req.method} ${new URL(req.url).pathname}`);
    if (!network.online) throw new TypeError("Failed to fetch");
    const res = network.respond(req);
    // A same-origin fetch is a "basic" response in a real worker.
    Object.defineProperty(res, "type", { value: "basic" });
    return res;
  };
  const ctx = vm.createContext({ self, caches: storage, fetch: fetchImpl, Response, Request, Headers, URL, console, Promise, JSON });
  vm.runInContext(SW_SOURCE, ctx);
  async function dispatch(type: string, init: Record<string, unknown>) {
    const waits: Promise<unknown>[] = [];
    let responded: Promise<Response> | null = null;
    const ev = { ...init, waitUntil: (p: Promise<unknown>) => void waits.push(p), respondWith: (p: Promise<Response>) => void (responded = Promise.resolve(p)) };
    listeners.get(type)!(ev);
    await Promise.all(waits);
    return responded as Promise<Response> | null;
  }
  const req = (path: string, init: RequestInit & { mode?: string } = {}) => {
    const { mode, ...rest } = init;
    const r = new Request(`${ORIGIN}${path}`, rest);
    if (mode) Object.defineProperty(r, "mode", { value: mode });
    return r;
  };
  async function fetchVia(path: string, init: RequestInit & { mode?: string } = {}): Promise<Response | null> {
    const p = await dispatch("fetch", { request: req(path, init) });
    return p ? await p : null;
  }
  return { storage, network, shown, dispatch, fetchVia };
}

const KEY_A = "a".repeat(32);
const KEY_B = "b".repeat(32);

describe("service worker (public/sw.js)", () => {
  let w: ReturnType<typeof boot>;
  beforeEach(async () => {
    w = boot();
    await w.dispatch("install", {});
    await w.dispatch("activate", {});
  });

  it("never caches HTML: navigations go to the network; offline they get /offline.html with its own CSP", async () => {
    w.network.respond = () => new Response("<html>nonce-abc</html>", { headers: { "content-type": "text/html" } });
    const online = await w.fetchVia("/dashboard/notes", { mode: "navigate" });
    assert.equal(await online!.text(), "<html>nonce-abc</html>");
    for (const [, c] of w.storage.caches) for (const k of c.store.keys()) assert.ok(!k.includes("/dashboard"), `no app page cached (${k})`);
    w.network.online = false;
    const offline = await w.fetchVia("/dashboard/notes", { mode: "navigate" });
    assert.equal(offline!.status, 503);
    assert.match(offline!.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.doesNotMatch(await offline!.text(), /nonce-abc/);
  });

  it("does not cache data without a session key", async () => {
    await w.fetchVia("/api/notes");
    assert.equal([...w.storage.caches.keys()].filter((k) => k.startsWith("shapes-data-")).length, 0);
  });

  it("read cache: per person, network-first online, the last copy offline (marked)", async () => {
    await w.dispatch("message", { data: { type: "session", key: KEY_A, strings: { title: "Offline" } }, origin: ORIGIN });
    let n = 0;
    w.network.respond = () => new Response(JSON.stringify({ notes: [`v${++n}`] }), { headers: { "content-type": "application/json" } });
    assert.deepEqual(await (await w.fetchVia("/api/notes?q="))!.json(), { notes: ["v1"] });
    assert.deepEqual(await (await w.fetchVia("/api/notes?q="))!.json(), { notes: ["v2"] }, "online always fresh (network-first)");
    w.network.online = false;
    const cached = (await w.fetchVia("/api/notes?q="))!;
    assert.deepEqual(await cached.json(), { notes: ["v2"] });
    assert.equal(cached.headers.get("x-shapes-offline"), "1");
    const other = (await w.fetchVia("/api/notes?scope=mine"))!;
    assert.deepEqual(await other.json(), { notes: ["v2"] }, "a list view falls back to the same path's copy");
    assert.ok(w.storage.caches.has(`shapes-data-${KEY_A}`));
    assert.equal(await w.fetchVia("/api/comms/meet"), null, "paths outside the read cache are not intercepted (the browser's own offline error)");
  });

  it("caches only JSON from the listed GET routes — never HTML, writes or other APIs", async () => {
    await w.dispatch("message", { data: { type: "session", key: KEY_A }, origin: ORIGIN });
    w.network.respond = () => new Response("<html>login</html>", { headers: { "content-type": "text/html" } });
    await w.fetchVia("/api/notes");
    w.network.respond = () => new Response("{}", { headers: { "content-type": "application/json" } });
    assert.equal(await w.fetchVia("/api/notes", { method: "POST", body: "{}" }), null, "writes are not intercepted");
    await w.fetchVia("/api/approvals/inbox");
    await w.fetchVia("/api/notes/abc/versions");
    const data = w.storage.caches.get(`shapes-data-${KEY_A}`);
    assert.equal(data?.store.size ?? 0, 0, "nothing cached");
    await w.fetchVia("/api/comms/calendar/events?from=1");
    await w.fetchVia("/api/comms/mail/threads");
    await w.fetchVia("/api/files");
    await w.fetchVia("/api/desk/layout");
    assert.equal(w.storage.caches.get(`shapes-data-${KEY_A}`)!.store.size, 4);
  });

  it("sign-out (POST /api/auth/signout) and another person's session purge the data caches", async () => {
    await w.dispatch("message", { data: { type: "session", key: KEY_A }, origin: ORIGIN });
    await w.fetchVia("/api/notes");
    assert.equal(w.storage.caches.get(`shapes-data-${KEY_A}`)!.store.size, 1);
    await w.dispatch("message", { data: { type: "session", key: KEY_B }, origin: ORIGIN });
    assert.equal(w.storage.caches.has(`shapes-data-${KEY_A}`), false, "Ana's copies are gone when Ben signs in");
    await w.fetchVia("/api/notes");
    const res = await w.fetchVia("/api/auth/signout", { method: "POST", body: "csrfToken=x" });
    assert.ok(res);
    assert.equal([...w.storage.caches.keys()].filter((k) => k.startsWith("shapes-data-")).length, 0, "sign-out deletes every data cache");
    assert.equal(await (await w.storage.open("shapes-meta")).match("/__shapes/session"), undefined, "and forgets the session key");
    await w.fetchVia("/api/notes");
    assert.equal([...w.storage.caches.keys()].filter((k) => k.startsWith("shapes-data-")).length, 0, "nothing cached until the app posts a new key");
    await w.dispatch("message", { data: { type: "session", key: "not a key" }, origin: ORIGIN });
    await w.dispatch("message", { data: { type: "session", key: KEY_A }, origin: "https://evil.test" });
    assert.equal(await (await w.storage.open("shapes-meta")).match("/__shapes/session"), undefined, "malformed / foreign messages ignored");
  });

  it("a 401 from a data route (session revoked elsewhere) purges the data caches and the key", async () => {
    await w.dispatch("message", { data: { type: "session", key: KEY_A }, origin: ORIGIN });
    await w.fetchVia("/api/notes");
    assert.equal(w.storage.caches.get(`shapes-data-${KEY_A}`)!.store.size, 1);
    w.network.respond = () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
    const res = (await w.fetchVia("/api/notes"))!;
    assert.equal(res.status, 401, "the app still sees the 401");
    assert.equal([...w.storage.caches.keys()].filter((k) => k.startsWith("shapes-data-")).length, 0, "no copy outlives the session");
    assert.equal(await (await w.storage.open("shapes-meta")).match("/__shapes/session"), undefined);
    w.network.online = false;
    await assert.rejects(() => w.fetchVia("/api/notes") as Promise<unknown>, "offline: nothing to serve");
  });

  it("static assets are cache-first (not in dev); HTML on a static path is never stored", async () => {
    w.network.respond = () => new Response("js", { headers: { "content-type": "text/javascript" } });
    await w.fetchVia("/_next/static/chunks/app.js");
    w.network.online = false;
    assert.equal(await (await w.fetchVia("/_next/static/chunks/app.js"))!.text(), "js");
    const dev = boot({ dev: true });
    await dev.dispatch("install", {});
    assert.equal(await dev.fetchVia("/_next/static/chunks/app.js"), null, "dev: not intercepted");
    await dev.dispatch("install", {});
    dev.network.online = false;
    const js = await dev.fetchVia("/offline.js");
    assert.ok(js && js.ok, "dev: the offline page's own script is still served from the precache");
  });

  it("push shows the notification with a same-origin link only", async () => {
    await w.dispatch("push", { data: { json: () => ({ title: "Approval needed", body: "Refund", href: "/dashboard/approvals", tag: "a1" }) } });
    await w.dispatch("push", { data: { json: () => ({ title: "x", href: "//evil.test/phish" }) } });
    assert.equal(w.shown.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(w.shown[0])), { title: "Approval needed", options: { body: "Refund", tag: "a1", icon: "/pwa/icon-192.png", badge: "/pwa/icon-192.png", data: { href: "/dashboard/approvals" } } });
    assert.equal((w.shown[1]!.options.data as { href: string }).href, "/dashboard/notifications");
  });
});
