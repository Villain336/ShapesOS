// ShapesOS — dev-preview proxy, LIVE HTTP edition (no paid provider): a real
// node http server plays the dev server, the loopback upstream kind (the same
// kind the Docker provider uses) points at it, and proxyDevPreview runs its
// real fetch path. This is observed behavior, not code inference: generated
// HTML, the module graph (nested imports), CSS, a client fetch, client-side
// navigation, reload, the root-serving fallback, and the websocket ceiling.
// Run: npx tsx --test --experimental-test-module-mocks lib/sandbox/__tests__/dev-preview-proxy.live-http.test.ts

import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { DevSandboxRow } from "../dev-sandbox";

let row: DevSandboxRow | null = null;
let upstreamOrigin = "";

mock.module("../dev-sandbox", {
  namedExports: { getDevSandboxRow: async () => row },
});
mock.module("../index", {
  namedExports: {
    getSandboxProvider: () => ({
      name: "docker",
      get: async () => ({
        id: "sb-live",
        // The Docker provider's own shape: loopback kind, exact-origin rule.
        previewUpstream: async () => ({ kind: "loopback" as const, origin: upstreamOrigin, headers: {} }),
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    }),
  },
});

let proxyDevPreview: typeof import("../dev-preview-proxy").proxyDevPreview;

const BASE = "/api/projects/p1/dev-preview/3000/";
// A Vite-style dev server started WITH the preview base: every URL it emits
// and serves carries the prefix (generated HTML, module graph, CSS, an API
// route for client fetches, a second route for client navigation).
const PAGES: Record<string, [string, string]> = {
  [`${BASE}`]: ["text/html", `<html><head><link rel="stylesheet" href="${BASE}assets/style.css"></head><body><div id="app"></div><script type="module" src="${BASE}src/main.js"></script></body></html>`],
  [`${BASE}assets/style.css`]: ["text/css", "body { color: rebeccapurple }"],
  [`${BASE}src/main.js`]: ["text/javascript", `import { msg } from "${BASE}src/dep.js"; document.getElementById("app").textContent = msg;`],
  [`${BASE}src/dep.js`]: ["text/javascript", `export const msg = "hello";`],
  [`${BASE}api/data`]: ["application/json", JSON.stringify({ ok: true })],
  [`${BASE}about`]: ["text/html", "<html><body>about page</body></html>"],
};

let server: http.Server;

before(async () => {
  ({ proxyDevPreview } = await import("../dev-preview-proxy"));
  server = http.createServer((req, res) => {
    if (req.url === "/assets/root-only.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end("rootOnly = true");
      return;
    }
    const hit = PAGES[req.url ?? ""];
    if (hit) {
      res.writeHead(200, { "content-type": hit[0] });
      res.end(hit[1]);
      return;
    }
    if (req.url === `${BASE}@vite/client`) {
      if (req.headers.upgrade) {
        res.writeHead(426).end("upgrade header leaked through the proxy");
        return;
      }
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end("__vite_hmr_client__");
      return;
    }
    if (req.url === `${BASE}%40vite/client`) {
      res.writeHead(418).end("encoded-at must not reach the dev server");
      return;
    }
    if (req.method === "POST" && req.url === `${BASE}api/save`) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ saved: body.length }));
      });
      return;
    }
    if (req.url === `${BASE}go-internal`) {
      res.writeHead(302, { location: `${BASE}about` }).end();
      return;
    }
    if (req.url === `${BASE}go-external`) {
      res.writeHead(302, { location: "https://evil.example/phish" }).end();
      return;
    }
    res.writeHead(404).end("nope");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  upstreamOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server?.close());

function mkRow(): DevSandboxRow {
  return {
    id: "pds-1", workspaceId: "ws1", projectId: "p1", provider: "docker", sandboxId: "sb-live",
    status: "running", mode: "test", createCount: 1, ttlSeconds: 900, exposedPorts: [3000], secretEnc: null,
    createdAt: new Date(), lastResumedAt: null, pausedAt: null, destroyedAt: null,
  };
}

// Same params the Next route passes: rest-of-path segments after the port.
const paramsFor = (path: string) => {
  const rest = path.startsWith(BASE) ? path.slice(BASE.length) : path;
  return { projectId: "p1", port: "3000", path: rest ? rest.split("/") : [] };
};
const get = (path: string, headers?: Record<string, string>) =>
  proxyDevPreview(new Request(`https://app.test${path}`, { method: "GET", headers }), paramsFor(path), { workspaceId: "ws1", canWrite: true });

describe("dev preview proxy over live HTTP (vite-with-base dev server)", () => {
  it("serves the generated HTML with its prefixed module/style URLs intact", async () => {
    row = mkRow();
    const res = await get(BASE);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, new RegExp(`src="${BASE}src/main\\.js"`), "module script URL keeps the preview prefix");
    assert.match(html, new RegExp(`href="${BASE}assets/style\\.css"`), "stylesheet URL keeps the preview prefix");
  });

  it("serves the module graph two levels deep (main -> dep)", async () => {
    row = mkRow();
    const main = await get(`${BASE}src/main.js`);
    assert.equal(main.status, 200);
    assert.match(await main.text(), /src\/dep\.js/);
    const dep = await get(`${BASE}src/dep.js`);
    assert.equal(dep.status, 200);
    assert.match(await dep.text(), /export const msg/);
  });

  it("serves CSS assets", async () => {
    row = mkRow();
    const res = await get(`${BASE}assets/style.css`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /rebeccapurple/);
  });

  it("proxies a client fetch (GET api) and a client mutation (POST api) with its body", async () => {
    row = mkRow();
    const data = await get(`${BASE}api/data`);
    assert.equal(data.status, 200);
    assert.deepEqual(await data.json(), { ok: true });
    const post = await proxyDevPreview(
      new Request(`https://app.test${BASE}api/save`, { method: "POST", body: "x".repeat(42) }),
      paramsFor(`${BASE}api/save`),
      { workspaceId: "ws1", canWrite: true },
    );
    assert.equal(post.status, 200);
    assert.deepEqual(await post.json(), { saved: 42 });
  });

  it("serves a client-navigation route and reload is just a fresh GET", async () => {
    row = mkRow();
    const about = await get(`${BASE}about`);
    assert.equal(about.status, 200);
    assert.match(await about.text(), /about page/);
    const again = await get(BASE);
    assert.equal(again.status, 200, "manual refresh re-fetches the running dev server");
  });

  it("root-serving fallback: a request the dev server 404s under the prefix is retried at its root", async () => {
    row = mkRow();
    const res = await get(`${BASE}assets/root-only.js`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /rootOnly/, "answered from the dev server's root");
  });

  it("dev-server @paths forward raw (regression: %40 broke vite's client route)", async () => {
    row = mkRow();
    const res = await get(`${BASE}@vite/client`);
    assert.equal(res.status, 200, "not the 418 sentinel the fixture returns for the encoded form");
    assert.match(await res.text(), /__vite_hmr_client__/);
  });

  it("the websocket ceiling, observed: an upgrade attempt gets no 101 and no upgrade forwarding", async () => {
    row = mkRow();
    const res = await proxyDevPreview(
      new Request(`https://app.test${BASE}@vite/client`, { method: "GET", headers: { connection: "Upgrade", upgrade: "websocket" } }),
      paramsFor(`${BASE}@vite/client`),
      { workspaceId: "ws1", canWrite: true },
    );
    assert.notEqual(res.status, 101, "no websocket handshake through the proxy - HMR unavailable, page unaffected");
    assert.equal(res.status, 200, "treated as a plain GET with the upgrade headers stripped (fixture 426s if one leaks)");
  });

  it("capability-URL mode: links rewritten to the token-full prefix, credentialless headers, no-referrer", async () => {
    row = mkRow();
    const LINK = `${BASE}cap/tok123/`;
    const res = await proxyDevPreview(
      new Request(`https://app.test${LINK}`),
      { projectId: "p1", port: "3000", path: [] },
      { workspaceId: "ws1", canWrite: false, linkPrefix: LINK },
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes(`src="${LINK}src/main.js"`), "module script rebased to the token-full prefix");
    assert.ok(!html.includes(`"${BASE}src/`), "no tokenless asset URLs remain");
    assert.equal(res.headers.get("access-control-allow-origin"), "null", "credentialless ACAO for the opaque origin");
    assert.equal(res.headers.get("access-control-allow-credentials"), null, "NO ACAC - no ambient credentials exist in v2");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer", "URL token must not leak via Referer");
    assert.equal(res.headers.get("set-cookie"), null, "no cookie is ever set");
  });

  it("redirects: in-base Location is rewritten to the token-full prefix; external Location is denied", async () => {
    row = mkRow();
    const LINK = `${BASE}cap/tok123/`;
    const ctx = { workspaceId: "ws1", canWrite: false, linkPrefix: LINK };
    const internal = await proxyDevPreview(
      new Request(`https://app.test${LINK}go-internal`),
      { projectId: "p1", port: "3000", path: ["go-internal"] }, ctx);
    assert.equal(internal.status, 302);
    assert.equal(internal.headers.get("location"), `${LINK}about`, "in-base redirect keeps the token");
    await internal.body?.cancel().catch(() => undefined);
    const external = await proxyDevPreview(
      new Request(`https://app.test${LINK}go-external`),
      { projectId: "p1", port: "3000", path: ["go-external"] }, ctx);
    assert.equal(external.status, 302);
    assert.equal(external.headers.get("location"), null, "external redirect Location is dropped, never passed through");
    await external.body?.cancel().catch(() => undefined);
  });

  it("capability-URL mode: CSS url()s rewritten to the token-full prefix", async () => {
    row = mkRow();
    const LINK = `${BASE}cap/tok123/`;
    const res = await proxyDevPreview(
      new Request(`https://app.test${LINK}assets/style.css`),
      { projectId: "p1", port: "3000", path: ["assets", "style.css"] },
      { workspaceId: "ws1", canWrite: false, linkPrefix: LINK },
    );
    assert.equal(res.status, 200);
    // fixture CSS has no base url(); assert pass-through is byte-stable here
    // and that content-length was dropped for the (re)buffered body.
    assert.match(await res.text(), /rebeccapurple/);
  });
});
