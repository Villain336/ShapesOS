// ShapesOS — sandbox persistence (pause/resume/auto-pause) against STUBBED
// fetch (no keys here — the live API is UNVERIFIED-LIVE). Pins the request
// shapes read from E2B's published spec (spec/openapi.yml, fetched
// 2026-10-25): POST /sandboxes/{id}/pause (204) and the non-deprecated
// wake path POST /v2/sandboxes/{id}/connect (resumes if paused, TTL only
// ever extends). autoResume on inbound traffic is never requested.
// Run: npx tsx --test lib/sandbox/__tests__/persistence.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { connectEnvelope, ConnectReader, E2BError, E2BSandboxProvider, type E2BSandbox } from "../e2b";
import { asPauseCapable, asPersistentProvider } from "../persistence";
import { sandboxConfig } from "../config";
import type { Sandbox } from "../types";

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

const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function connectStream(events: unknown[]): Response {
  const frames = Buffer.concat([...events.map((e) => connectEnvelope(e)), connectEnvelope({}, 0x02)]);
  return new Response(frames as unknown as BodyInit, { status: 200, headers: { "content-type": "application/connect+json" } });
}

const cfg = sandboxConfig({ SANDBOX_PROVIDER: "e2b", E2B_API_KEY: "e2b_test_key", SANDBOX_IDLE_MINUTES: "20" });

function make(pauseStatus = 204, connectStatus = 200) {
  return stubFetch((c) => {
    if (c.url === "https://api.e2b.app/v2/sandboxes" && c.method === "POST") {
      return json(201, { sandboxID: "sbx123", envdAccessToken: "envd-tok", trafficAccessToken: "traffic-tok", domain: "e2b.app" });
    }
    if (c.url.endsWith("/process.Process/Start")) {
      return connectStream([{ event: { start: { pid: 42 } } }, { event: { end: { exited: true, status: "exit status 0" } } }]);
    }
    if (c.url === "https://api.e2b.app/sandboxes/sbx123/pause" && c.method === "POST") {
      return pauseStatus === 204 ? new Response(null, { status: 204 }) : json(pauseStatus, { message: "gone" });
    }
    if (c.url === "https://api.e2b.app/v2/sandboxes/sbx123/connect" && c.method === "POST") {
      return connectStatus === 200
        ? json(200, { sandboxID: "sbx123", state: "running", envdAccessToken: "envd-tok", domain: "e2b.app" })
        : json(connectStatus, { message: "gone" });
    }
    return json(404, { message: "nope" });
  });
}

describe("E2B persistence (pause/resume/auto-pause)", () => {
  it("plain create stays non-persistent: autoPause false + provider idle timeout", async () => {
    const { calls, fetchImpl } = make();
    const p = new E2BSandboxProvider({ config: cfg, fetch: fetchImpl });
    await p.create({ workspaceId: "ws1", runId: "run9" });
    const create = calls.find((c) => c.url.endsWith("/v2/sandboxes"))!;
    const body = create.body as { timeout: number; autoPause: boolean };
    assert.equal(body.autoPause, false);
    assert.equal(body.timeout, 20 * 60);
  });

  it("createPersistent sends autoPause true + the caller's running TTL", async () => {
    const { calls, fetchImpl } = make();
    const p = new E2BSandboxProvider({ config: cfg, fetch: fetchImpl });
    const sb = await p.createPersistent({ workspaceId: "ws1", runId: "run9" }, { autoPause: true, timeoutSeconds: 900 });
    const create = calls.find((c) => c.url.endsWith("/v2/sandboxes"))!;
    const body = create.body as { timeout: number; autoPause: boolean };
    assert.equal(body.autoPause, true);
    assert.equal(body.timeout, 900);
    assert.ok(asPauseCapable(sb), "persistent sandbox exposes pause/resume");
  });

  it("pause: POST /sandboxes/{id}/pause with the API key, 204 succeeds", async () => {
    const { calls, fetchImpl } = make();
    const p = new E2BSandboxProvider({ config: cfg, fetch: fetchImpl });
    const sb = (await p.create({ workspaceId: "ws1", runId: "run9" })) as E2BSandbox;
    await sb.pause();
    const pause = calls.find((c) => c.url.endsWith("/pause"))!;
    assert.equal(pause.method, "POST");
    assert.equal(pause.url, "https://api.e2b.app/sandboxes/sbx123/pause");
    assert.equal(pause.headers["x-api-key"], "e2b_test_key");
  });

  it("pause on a gone sandbox says so (404)", async () => {
    const { fetchImpl } = make(404);
    const p = new E2BSandboxProvider({ config: cfg, fetch: fetchImpl });
    const sb = (await p.create({ workspaceId: "ws1", runId: "run9" })) as E2BSandbox;
    await assert.rejects(() => sb.pause(), (e: unknown) => e instanceof E2BError && /gone/.test((e as Error).message));
  });

  it("resume: POST /v2/sandboxes/{id}/connect (non-deprecated wake), timeout in body", async () => {
    const { calls, fetchImpl } = make();
    const p = new E2BSandboxProvider({ config: cfg, fetch: fetchImpl });
    const sb = (await p.create({ workspaceId: "ws1", runId: "run9" })) as E2BSandbox;
    await sb.resume({ timeoutSeconds: 1200 });
    const connect = calls.find((c) => c.url.endsWith("/connect"))!;
    assert.equal(connect.method, "POST");
    assert.equal(connect.url, "https://api.e2b.app/v2/sandboxes/sbx123/connect");
    assert.deepEqual(connect.body, { timeout: 1200 });
  });

  it("resume without a timeout sends an empty body (provider default TTL)", async () => {
    const { calls, fetchImpl } = make();
    const p = new E2BSandboxProvider({ config: cfg, fetch: fetchImpl });
    const sb = (await p.create({ workspaceId: "ws1", runId: "run9" })) as E2BSandbox;
    await sb.resume();
    const connect = calls.find((c) => c.url.endsWith("/connect"))!;
    assert.deepEqual(connect.body, {});
  });

  it("resume on a gone sandbox says so (404)", async () => {
    const { fetchImpl } = make(204, 404);
    const p = new E2BSandboxProvider({ config: cfg, fetch: fetchImpl });
    const sb = (await p.create({ workspaceId: "ws1", runId: "run9" })) as E2BSandbox;
    await assert.rejects(() => sb.resume(), (e: unknown) => e instanceof E2BError && /gone/.test((e as Error).message));
  });

  it("capability guards: E2B sandboxes are pause-capable; a bare object is not", async () => {
    const { fetchImpl } = make();
    const p = new E2BSandboxProvider({ config: cfg, fetch: fetchImpl });
    assert.ok(asPersistentProvider(p), "E2B provider exposes createPersistent");
    const sb = await p.create({ workspaceId: "ws1", runId: "run9" });
    assert.ok(asPauseCapable(sb));
    const notSandbox = { id: "x", provider: "e2b" } as unknown as Sandbox;
    assert.equal(asPauseCapable(notSandbox), null);
  });
});
