// ShapesOS — Phase 8: E2B and Daytona adapters against STUBBED fetch (no
// keys here — the live APIs are UNVERIFIED-LIVE). Pins the request shapes
// read from their published specs: URLs, auth headers, bodies (egress
// allow-lists, private previews, idle timers), the E2B Connect stream, and
// Daytona's execute / files / preview-url calls.
// Run: npx tsx --test lib/sandbox/__tests__/hosted-providers.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { connectEnvelope, ConnectReader, E2BSandboxProvider, type E2BSandbox } from "../e2b";
import { DaytonaSandboxProvider, type DaytonaSandbox } from "../daytona";
import { sandboxConfig } from "../config";
import { SandboxPathError } from "../paths";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  raw?: Buffer;
}

function stubFetch(route: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    let body: unknown = init.body;
    let raw: Buffer | undefined;
    if (init.body instanceof Uint8Array) {
      raw = Buffer.from(init.body);
      body = raw;
    } else if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const c: Call = { url, method: (init.method ?? "GET").toUpperCase(), headers, body, raw };
    calls.push(c);
    return route(c);
  };
  return { calls, fetchImpl };
}

const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function connectStream(events: unknown[]): Response {
  const frames = Buffer.concat([...events.map((e) => connectEnvelope(e)), connectEnvelope({}, 0x02)]);
  // Deliver in awkward slices.
  const parts = [frames.subarray(0, 3), frames.subarray(3, 20), frames.subarray(20)];
  const stream = new ReadableStream<Uint8Array>({
    start(ctl) {
      for (const p of parts) ctl.enqueue(new Uint8Array(p));
      ctl.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/connect+json" } });
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("E2B adapter", () => {
  const cfg = sandboxConfig({ SANDBOX_PROVIDER: "e2b", E2B_API_KEY: "e2b_test_key", SANDBOX_IDLE_MINUTES: "20" });

  function make() {
    return stubFetch((c) => {
      if (c.url === "https://api.e2b.app/v2/sandboxes" && c.method === "POST") {
        return json(201, { sandboxID: "sbx123", envdAccessToken: "envd-tok", trafficAccessToken: "traffic-tok", domain: "e2b.app", templateID: "base", clientID: "x", envdVersion: "0.4.0" });
      }
      if (c.url.endsWith("/process.Process/Start")) {
        const req = new ConnectReader().push(c.raw!)[0]!.msg as { process: { cmd: string; args: string[] } };
        const isMkdir = req.process.cmd === "mkdir";
        return connectStream([
          { event: { start: { pid: 42 } } },
          ...(isMkdir ? [] : [{ event: { data: { stdout: b64("hi ") } } }, { event: { data: { stderr: b64("careful") } } }, { event: { data: { stdout: b64("there") } } }]),
          { event: { keepalive: {} } },
          { event: { end: isMkdir ? { exited: true, status: "exit status 0" } : { exitCode: 2, exited: true, status: "exit status 2" } } },
        ]);
      }
      if (c.url.includes("/files?path=")) {
        if (c.method === "GET") return new Response("file body", { status: 200 });
        return json(200, [{ path: "/home/user/work/a.txt", name: "a.txt", type: "file" }]);
      }
      if (c.url.endsWith("/timeout")) return new Response(null, { status: 204 });
      if (c.url === "https://api.e2b.app/sandboxes/sbx123" && c.method === "DELETE") return new Response(null, { status: 204 });
      if (c.url === "https://api.e2b.app/sandboxes/sbx123") {
        return json(200, { sandboxID: "sbx123", state: "running", envdAccessToken: "envd-tok", domain: "e2b.app", metadata: { runId: "run9" } });
      }
      if (c.url === "https://api.e2b.app/sandboxes") return json(200, []);
      return json(404, { message: "nope" });
    });
  }

  it("create: v2 endpoint, X-API-Key, private traffic, egress allow-list + deny-all, idle timeout, metadata", async () => {
    const { calls, fetchImpl } = make();
    const p = new E2BSandboxProvider({ config: cfg, fetch: fetchImpl });
    const sb = (await p.create({ workspaceId: "ws1", runId: "run9" })) as E2BSandbox;
    assert.equal(sb.id, "sbx123");
    assert.equal(sb.workdir, "/home/user/work");
    const c = calls[0]!;
    assert.equal(c.url, "https://api.e2b.app/v2/sandboxes");
    assert.equal(c.headers["x-api-key"], "e2b_test_key");
    const body = c.body as Record<string, unknown>;
    assert.equal(body.templateID, "base");
    assert.equal(body.timeout, 20 * 60);
    assert.equal(body.autoPause, false);
    assert.deepEqual(body.metadata, { app: "shapesos", workspaceId: "ws1", runId: "run9" });
    const net = body.network as { allowPublicTraffic: boolean; allowOut: string[]; denyOut: string[] };
    assert.equal(net.allowPublicTraffic, false, "previews need the traffic token");
    assert.deepEqual(net.denyOut, ["0.0.0.0/0"]);
    assert.ok(net.allowOut.includes("registry.npmjs.org") && net.allowOut.includes("github.com"));
    // the workdir is created through envd
    assert.ok(calls.some((x) => x.url === "https://49983-sbx123.e2b.app/process.Process/Start"));
    assert.equal(sb.persistSecret(), JSON.stringify({ traffic: "traffic-tok" }));
  });

  it("exec: Connect server-stream with envd auth headers; output decoded and streamed; exit code", async () => {
    const { calls, fetchImpl } = make();
    const p = new E2BSandboxProvider({ config: cfg, fetch: fetchImpl });
    const sb = (await p.create({ workspaceId: "ws1", runId: "run9" })) as E2BSandbox;
    calls.length = 0;
    const seen: string[] = [];
    const r = await sb.exec("npm test", { env: { CI: "1" }, cwd: "app", onOutput: (o) => seen.push(o.stream) });
    assert.equal(r.stdout, "hi there");
    assert.equal(r.stderr, "careful");
    assert.equal(r.exitCode, 2);
    assert.deepEqual(seen, ["stdout", "stderr", "stdout"]);
    const start = calls.find((c) => c.url.endsWith("/process.Process/Start"))!;
    assert.equal(start.headers["content-type"], "application/connect+json");
    assert.equal(start.headers["x-access-token"], "envd-tok");
    assert.equal(start.headers["e2b-sandbox-id"], "sbx123");
    assert.equal(start.headers["e2b-sandbox-port"], "49983");
    assert.equal(start.headers.authorization, `Basic ${Buffer.from("user:").toString("base64")}`);
    const msg = new ConnectReader().push(start.raw!)[0]!.msg as { process: Record<string, unknown>; stdin: boolean };
    assert.deepEqual(msg.process, { cmd: "/bin/sh", args: ["-lc", "npm test"], envs: { CI: "1" }, cwd: "/home/user/work/app" });
    assert.equal(msg.stdin, false);
    // the idle timer is reset on every command
    assert.ok(calls.some((c) => c.url === "https://api.e2b.app/sandboxes/sbx123/timeout" && (c.body as { timeout: number }).timeout === 1200));
  });

  it("files: envd /files with path + user; traversal refused; preview upstream carries the traffic token", async () => {
    const { calls, fetchImpl } = make();
    const p = new E2BSandboxProvider({ config: cfg, fetch: fetchImpl });
    const sb = (await p.create({ workspaceId: "ws1", runId: "run9" })) as E2BSandbox;
    calls.length = 0;
    assert.equal((await sb.readFile("a.txt")).toString(), "file body");
    await sb.writeFile("src/b.txt", "data");
    assert.equal(calls[0]!.url, "https://49983-sbx123.e2b.app/files?path=%2Fhome%2Fuser%2Fwork%2Fa.txt&username=user");
    assert.equal(calls[1]!.method, "POST");
    assert.equal(calls[1]!.headers["content-type"], "application/octet-stream");
    assert.equal(calls[1]!.raw!.toString(), "data");
    await assert.rejects(sb.readFile("../../etc/passwd"), SandboxPathError);
    const up = await sb.previewUpstream(3000);
    assert.equal(up.origin, "https://3000-sbx123.e2b.app");
    assert.deepEqual(up.headers, { "e2b-traffic-access-token": "traffic-tok" });
    assert.ok(up.hostPattern!.test("3000-sbx123.e2b.app"));
    assert.ok(!up.hostPattern!.test("3000-sbx124.e2b.app"));
    assert.deepEqual(await sb.exposePort(3000), { url: "/api/agent-runs/run9/preview/3000/" });
  });

  it("get(id) reattaches (with the stored traffic secret), destroy DELETEs", async () => {
    const { calls, fetchImpl } = make();
    const p = new E2BSandboxProvider({ config: cfg, fetch: fetchImpl });
    const sb = (await p.getWithSecret("sbx123", JSON.stringify({ traffic: "traffic-tok" }))) as E2BSandbox;
    assert.ok(sb);
    assert.equal(sb.runId, "run9");
    assert.equal((await sb.previewUpstream(3000)).headers["e2b-traffic-access-token"], "traffic-tok");
    calls.length = 0;
    await sb.destroy();
    assert.deepEqual([calls[0]!.method, calls[0]!.url], ["DELETE", "https://api.e2b.app/sandboxes/sbx123"]);
    assert.equal(await p.get("../x"), null);
  });

  it("available() explains a missing or rejected key", async () => {
    const none = await new E2BSandboxProvider({ config: sandboxConfig({ SANDBOX_PROVIDER: "e2b" }) }).available();
    assert.match((none as { reason: string }).reason, /E2B_API_KEY/);
    const rejected = await new E2BSandboxProvider({ config: cfg, fetch: async () => new Response("", { status: 401 }) }).available();
    assert.match((rejected as { reason: string }).reason, /rejected/);
    const { fetchImpl } = make();
    assert.deepEqual(await new E2BSandboxProvider({ config: cfg, fetch: fetchImpl }).available(), { ok: true });
  });
});

describe("Daytona adapter", () => {
  const cfg = sandboxConfig({ SANDBOX_PROVIDER: "daytona", DAYTONA_API_KEY: "dtn_key", SANDBOX_IDLE_MINUTES: "15", SANDBOX_MEMORY_MB: "4096", SANDBOX_DISK_MB: "10240" });

  function make(opts: { execStatus?: number } = {}) {
    let polls = 0;
    let creating = false;
    return stubFetch((c) => {
      if (c.url === "https://app.daytona.io/api/sandbox" && c.method === "POST") {
        creating = true;
        return json(200, { id: "dt-1", state: "creating" });
      }
      if (c.url === "https://app.daytona.io/api/sandbox/dt-1" && c.method === "GET") {
        polls++;
        return json(200, { id: "dt-1", state: !creating || polls >= 2 ? "started" : "starting", toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox", labels: { "shapes.run": "run7" } });
      }
      if (c.url === "https://app.daytona.io/api/sandbox/dt-1" && c.method === "DELETE") return new Response(null, { status: 204 });
      if (c.url.endsWith("/process/execute")) {
        if (opts.execStatus) return new Response("timeout", { status: opts.execStatus });
        if (String((c.body as { command: string }).command).includes("mkdir")) return json(200, { exitCode: 0, result: "" });
        return json(200, { exitCode: 1, result: "combined output" });
      }
      if (c.url.includes("/files/download")) return new Response("content", { status: 200 });
      if (c.url.includes("/files/upload-v2")) return json(200, {});
      if (c.url.endsWith("/ports/3000/preview-url")) return json(200, { sandboxId: "dt-1", url: "https://3000-dt-1.proxy.daytona.works", token: "prev-tok" });
      if (c.url === "https://app.daytona.io/api/sandbox") return json(200, []);
      return json(404, {});
    });
  }

  it("create: Bearer key, private, resources in GB, idle stop + delete on stop, domain allow-list; waits for started", async () => {
    const { calls, fetchImpl } = make();
    const p = new DaytonaSandboxProvider({ config: cfg, fetch: fetchImpl, pollMs: 1 });
    const sb = (await p.create({ workspaceId: "ws1", runId: "run7" })) as DaytonaSandbox;
    assert.equal(sb.id, "dt-1");
    const c = calls[0]!;
    assert.equal(c.headers.authorization, "Bearer dtn_key");
    const body = c.body as Record<string, unknown>;
    assert.equal(body.public, false);
    assert.equal(body.memory, 4);
    assert.equal(body.disk, 10);
    assert.equal(body.autoStopInterval, 15);
    assert.equal(body.autoDeleteInterval, 0);
    assert.match(String(body.domainAllowList), /registry\.npmjs\.org/);
    assert.match(String(body.domainAllowList), /github\.com/);
    assert.deepEqual(body.labels, { app: "shapesos", "shapes.workspace": "ws1", "shapes.run": "run7" });
    assert.ok(calls.filter((x) => x.method === "GET").length >= 2, "polled until started");
  });

  it("exec: toolbox /process/execute with a quoted command, cwd, envs, timeout seconds", async () => {
    const { calls, fetchImpl } = make();
    const p = new DaytonaSandboxProvider({ config: cfg, fetch: fetchImpl, pollMs: 1 });
    const sb = (await p.create({ workspaceId: "ws1", runId: "run7" })) as DaytonaSandbox;
    calls.length = 0;
    const r = await sb.exec("echo 'hi' && false", { timeoutMs: 2500, env: { A: "b" } });
    assert.equal(r.exitCode, 1);
    assert.equal(r.stdout, "combined output");
    const ex = calls[0]!;
    assert.equal(ex.url, "https://proxy.app.daytona.io/toolbox/dt-1/process/execute");
    assert.equal(ex.headers.authorization, "Bearer dtn_key");
    assert.deepEqual(ex.body, { command: `'/bin/sh' '-lc' 'echo '\\''hi'\\'' && false'`, cwd: "/home/daytona/work", envs: { A: "b" }, timeout: 3 });
  });

  it("a 408 from execute is a time-out", async () => {
    const { fetchImpl } = make({ execStatus: 408 });
    const p = new DaytonaSandboxProvider({ config: cfg, fetch: fetchImpl, pollMs: 1 });
    const sb = (await p.get("dt-1")) as DaytonaSandbox;
    const r = await sb.exec("sleep 100", { timeoutMs: 1000 });
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, 124);
  });

  it("files, preview token, delete", async () => {
    const { calls, fetchImpl } = make();
    const p = new DaytonaSandboxProvider({ config: cfg, fetch: fetchImpl, pollMs: 1 });
    const sb = (await p.get("dt-1")) as DaytonaSandbox;
    assert.equal(sb.runId, "run7");
    calls.length = 0;
    assert.equal((await sb.readFile("a.txt")).toString(), "content");
    assert.equal(calls[0]!.url, "https://proxy.app.daytona.io/toolbox/dt-1/files/download?path=%2Fhome%2Fdaytona%2Fwork%2Fa.txt");
    await sb.writeFile("b/c.txt", "x");
    assert.equal(calls[1]!.url, "https://proxy.app.daytona.io/toolbox/dt-1/files/upload-v2?path=%2Fhome%2Fdaytona%2Fwork%2Fb%2Fc.txt");
    assert.ok(calls[1]!.body instanceof FormData);
    await assert.rejects(sb.writeFile("../../root/.ssh/authorized_keys", "x"), SandboxPathError);
    const up = await sb.previewUpstream(3000);
    assert.equal(up.origin, "https://3000-dt-1.proxy.daytona.works");
    assert.deepEqual(up.headers, { "x-daytona-preview-token": "prev-tok" });
    assert.ok(up.hostPattern!.test("3000-dt-1.proxy.daytona.works"));
    assert.ok(!up.hostPattern!.test("3001-dt-1.proxy.daytona.works"));
    calls.length = 0;
    await sb.destroy();
    assert.deepEqual([calls[0]!.method, calls[0]!.url], ["DELETE", "https://app.daytona.io/api/sandbox/dt-1"]);
  });

  it("available() explains a missing key", async () => {
    const a = await new DaytonaSandboxProvider({ config: sandboxConfig({ SANDBOX_PROVIDER: "daytona" }) }).available();
    assert.match((a as { reason: string }).reason, /DAYTONA_API_KEY/);
  });
});
