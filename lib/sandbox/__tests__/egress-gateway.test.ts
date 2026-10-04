// ShapesOS — Phase 8: the Docker sandbox gateway program, run for real with
// node on this machine (it is plain node:http/net — the same source the
// sidecar container runs). Egress: only allow-listed names on allowed ports,
// never IP literals. Preview: only with the gateway token, forwarded to the
// sandbox host without the token headers.
// Run: npx tsx --test lib/sandbox/__tests__/egress-gateway.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { GATEWAY_SOURCE } from "../egress-gateway";

let upstream: Server;
let upPort = 0;
let gw: ChildProcess;
const EGRESS = 31000 + Math.floor(Math.random() * 1000);
const PREVIEW = EGRESS + 1000;
const TOKEN = "t".repeat(48);
const seen: Array<{ url: string; headers: Record<string, unknown> }> = [];

function waitPort(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const tryOnce = () => {
      const s = connect(port, "127.0.0.1");
      s.on("connect", () => (s.destroy(), resolve()));
      s.on("error", () => (Date.now() > deadline ? reject(new Error("gateway did not start")) : setTimeout(tryOnce, 100)));
    };
    tryOnce();
  });
}

function httpGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function connectVia(target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(EGRESS, "127.0.0.1", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\r\n\r\n")) {
        const status = buf.split("\r\n")[0]!;
        if (status.includes(" 200 ")) {
          // Tunnel is open: speak HTTP to the upstream through it.
          s.write(`GET /tunnel HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
          let rest = "";
          s.removeAllListeners("data");
          s.on("data", (x) => (rest += x.toString()));
          s.on("end", () => resolve(`${status}|${rest.includes("upstream ok") ? "tunnel ok" : "tunnel broken"}`));
        } else {
          s.destroy();
          resolve(status);
        }
      }
    });
    s.on("error", reject);
  });
}

before(async () => {
  upstream = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("upstream ok");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  upPort = (upstream.address() as AddressInfo).port;
  gw = spawn(process.execPath, ["-e", GATEWAY_SOURCE], {
    env: {
      ...process.env,
      ALLOW: "localhost,*.allowed.test",
      ALLOW_PORTS: `80,443,${upPort}`,
      GATEWAY_TOKEN: TOKEN,
      SANDBOX_HOST: "localhost",
      EGRESS_PORT: String(EGRESS),
      PREVIEW_PORT: String(PREVIEW),
      EXIT_WHEN_SANDBOX_GONE: "0",
    } as unknown as NodeJS.ProcessEnv,
    stdio: "ignore",
  });
  await waitPort(EGRESS);
  await waitPort(PREVIEW);
});

after(async () => {
  gw.kill("SIGKILL");
  upstream.closeAllConnections?.();
  await new Promise<void>((r) => upstream.close(() => r()));
});

describe("egress gateway (HTTP forward proxy)", () => {
  it("CONNECT to an allow-listed name on an allowed port opens a tunnel", async () => {
    assert.equal(await connectVia(`localhost:${upPort}`), "HTTP/1.1 200 Connection Established|tunnel ok");
  });

  it("CONNECT to any other name, an IP literal or a disallowed port is refused (403)", async () => {
    assert.match(await connectVia(`example.com:443`), / 403 /);
    assert.match(await connectVia(`127.0.0.1:${upPort}`), / 403 /);
    assert.match(await connectVia(`localhost:22`), / 403 /);
    assert.match(await connectVia(`evil-localhost:443`), / 403 /);
  });

  it("plain-http absolute-URI requests follow the same allow-list", async () => {
    const ok = await httpGet(EGRESS, `http://localhost:${upPort}/plain`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body, "upstream ok");
    const no = await httpGet(EGRESS, `http://example.com/`);
    assert.equal(no.status, 403);
    assert.match(no.body, /not on the allow-list/);
  });
});

describe("preview gateway", () => {
  it("answers only with the gateway token", async () => {
    assert.equal((await httpGet(PREVIEW, "/", { "x-shapes-preview-port": String(upPort) })).status, 401);
    assert.equal((await httpGet(PREVIEW, "/", { "x-shapes-gateway-token": "wrong", "x-shapes-preview-port": String(upPort) })).status, 401);
  });

  it("forwards to the sandbox port without the token headers", async () => {
    seen.length = 0;
    const r = await httpGet(PREVIEW, "/app/index.html?x=1", { "x-shapes-gateway-token": TOKEN, "x-shapes-preview-port": String(upPort) });
    assert.equal(r.status, 200);
    assert.equal(r.body, "upstream ok");
    assert.equal(seen[0]!.url, "/app/index.html?x=1");
    assert.equal(seen[0]!.headers["x-shapes-gateway-token"], undefined);
    assert.equal(seen[0]!.headers["x-shapes-preview-port"], undefined);
  });

  it("says so when nothing listens on the port", async () => {
    const r = await httpGet(PREVIEW, "/", { "x-shapes-gateway-token": TOKEN, "x-shapes-preview-port": "1" });
    assert.equal(r.status, 502);
    assert.match(r.body, /Nothing is listening on port 1/);
  });
});
