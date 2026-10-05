// ShapesOS — Phase 8: the Docker sandbox's gateway (egress allow-list +
// authenticated preview), as plain JavaScript run by `node -e` in a sidecar
// container. No dependency; node:http / node:net / node:dns only.
//
// Why a sidecar: Docker cannot filter egress by host name. A sandbox sits on
// its own `Internal: true` network — no route off the box at all — and the
// only other container on that network is this gateway, which is ALSO on the
// default bridge. It offers two things:
//
//   :3128  an HTTP forward proxy (CONNECT for https, absolute-URI for http)
//          that only reaches host names on the allow-list, on ports 80/443.
//          IP literals and every other name are refused (403). The sandbox
//          gets HTTP(S)_PROXY pointing here; a process that ignores the proxy
//          variables simply has no route out.
//   :8080  a preview reverse proxy to `sandbox:<port>` on the internal
//          network, published on the Docker host's loopback only and
//          answering only requests that carry the per-sandbox gateway token
//          (the app's authenticated preview route adds it).
//
// It exits on its own once the sandbox container is gone (its network alias
// stops resolving), so an idled-out sandbox leaves nothing running.
//
// What this does NOT enforce (documented in docs, not hidden): DNS lookups
// from the sandbox still reach Docker's embedded resolver, which may forward
// external names — a slow DNS side channel; and the egress port is reachable
// by other containers on the default bridge (it only ever reaches the
// allow-list, so it is not an open relay).

/** The gateway program. Reads ALLOW, GATEWAY_TOKEN, SANDBOX_HOST from env. */
export const GATEWAY_SOURCE = String.raw`
"use strict";
const http = require("http"), net = require("net"), dns = require("dns");
// Sidecar settings, set by docker.ts on the gateway container (not host config).
const env = process.env;
const ALLOW = String(env.ALLOW || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const TOKEN = String(env.GATEWAY_TOKEN || "");
const SANDBOX = String(env.SANDBOX_HOST || "sandbox");
const EGRESS_PORT = Number(env.EGRESS_PORT || 3128);
const PREVIEW_PORT = Number(env.PREVIEW_PORT || 8080);
const PORTS = String(env.ALLOW_PORTS || "80,443").split(",").map(Number);
function allowed(h) {
  h = String(h || "").toLowerCase().replace(/\.$/, "");
  if (!h || net.isIP(h)) return false;
  return ALLOW.some((a) => (a.startsWith("*.") ? h.endsWith(a.slice(1)) && h.length > a.length - 1 : h === a));
}
function target(s, def) {
  const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(String(s || ""));
  return m ? { host: m[1], port: Number(m[2] || def) } : null;
}
function deny(res, host) {
  res.writeHead(403, { "content-type": "text/plain" });
  res.end("ShapesOS sandbox: egress to " + host + " is not on the allow-list\n");
}
const egress = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
  const port = Number(u.port || 80);
  if (u.protocol !== "http:" || !allowed(u.hostname) || !PORTS.includes(port)) return deny(res, u.hostname);
  const headers = Object.assign({}, req.headers);
  delete headers["proxy-authorization"]; delete headers["proxy-connection"];
  const up = http.request({ host: u.hostname, port, path: u.pathname + u.search, method: req.method, headers }, (r) => {
    res.writeHead(r.statusCode || 502, r.headers); r.pipe(res);
  });
  up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(up);
});
egress.on("connect", (req, sock, head) => {
  const t = target(req.url, 443);
  if (!t || !allowed(t.host) || !PORTS.includes(t.port)) {
    sock.end("HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nShapesOS sandbox: egress to " + (t ? t.host : "?") + " is not on the allow-list\n");
    return;
  }
  const up = net.connect(t.port, t.host, () => {
    sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) up.write(head);
    up.pipe(sock); sock.pipe(up);
  });
  up.on("error", () => sock.destroy());
  sock.on("error", () => up.destroy());
});
egress.listen(EGRESS_PORT, "0.0.0.0");
const preview = http.createServer((req, res) => {
  if (!TOKEN || req.headers["x-shapes-gateway-token"] !== TOKEN) { res.writeHead(401); return res.end(); }
  const port = Number(req.headers["x-shapes-preview-port"]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { res.writeHead(400); return res.end(); }
  const headers = Object.assign({}, req.headers);
  delete headers["x-shapes-gateway-token"]; delete headers["x-shapes-preview-port"];
  headers.host = "localhost:" + port;
  const up = http.request({ host: SANDBOX, port, path: req.url, method: req.method, headers }, (r) => {
    res.writeHead(r.statusCode || 502, r.headers); r.pipe(res);
  });
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("Nothing is listening on port " + port + " in the sandbox yet.\n");
  });
  req.pipe(up);
});
preview.listen(PREVIEW_PORT, "0.0.0.0");
if (env.EXIT_WHEN_SANDBOX_GONE !== "0") {
  let misses = 0;
  setInterval(() => dns.lookup(SANDBOX, (err) => { misses = err ? misses + 1 : 0; if (misses >= 4) process.exit(0); }), 15000);
}
`;
