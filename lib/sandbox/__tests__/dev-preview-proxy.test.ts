// ShapesOS — dev-preview proxy security posture (in-product browser v1):
// a paused sandbox is NEVER woken by proxy traffic, ports come from the row's
// allowlist, writes need editor, redirects stay inside the preview prefix.
// DB + provider are module-mocked; upstream fetch is stubbed.
// Run: npx tsx --test --experimental-test-module-mocks lib/sandbox/__tests__/dev-preview-proxy.test.ts

import { before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { DevSandboxRow } from "../dev-sandbox";

let row: DevSandboxRow | null = null;
let providerSandbox: unknown = null;

mock.module("../dev-sandbox", {
  namedExports: {
    getDevSandboxRow: async () => row,
  },
});
mock.module("@/lib/safe-url", {
  namedExports: { assertSafeUrl: async () => undefined },
});
mock.module("../index", {
  namedExports: {
    getSandboxProvider: () => ({ name: "e2b", get: async () => providerSandbox }),
  },
});

let proxyDevPreview: typeof import("../dev-preview-proxy").proxyDevPreview;
before(async () => {
  ({ proxyDevPreview } = await import("../dev-preview-proxy"));
});

function mkRow(over: Partial<DevSandboxRow> = {}): DevSandboxRow {
  return {
    id: "pds-1", workspaceId: "ws1", projectId: "p1", provider: "e2b", sandboxId: "sb-1",
    status: "running", mode: "test", createCount: 1, ttlSeconds: 900, exposedPorts: [3000], secretEnc: null,
    createdAt: new Date(), lastResumedAt: null, pausedAt: null, destroyedAt: null, ...over,
  };
}

const req = (method: string, url = "https://app.test/api/projects/p1/dev-preview/3000/") =>
  new Request(url, { method });
const ctx = (canWrite = true) => ({ workspaceId: "ws1", canWrite });

const upstreamSandbox = {
  id: "sb-1",
  async previewUpstream() {
    return { kind: "public" as const, origin: "https://sb-1-3000.e2b.dev", headers: {}, hostPattern: /^sb-1-3000\.e2b\.dev$/ };
  },
  async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
  async readFile() { return ""; },
  async writeFile() { /* noop */ },
  async destroy() { /* noop */ },
};

describe("dev preview proxy", () => {
  it("404 on an invalid port", async () => {
    row = mkRow();
    const res = await proxyDevPreview(req("GET", "https://app.test/api/projects/p1/dev-preview/abc/"), { projectId: "p1", port: "abc" }, ctx());
    assert.equal(res.status, 404);
  });

  it("404 when the project has no dev sandbox", async () => {
    row = null;
    const res = await proxyDevPreview(req("GET"), { projectId: "p1", port: "3000" }, ctx());
    assert.equal(res.status, 404);
  });

  it("409 while paused - proxy traffic never wakes it", async () => {
    row = mkRow({ status: "paused" });
    providerSandbox = upstreamSandbox;
    const res = await proxyDevPreview(req("GET"), { projectId: "p1", port: "3000" }, ctx());
    assert.equal(res.status, 409);
    assert.match(await res.text(), /paused/);
  });

  it("404 on a port the row doesn't expose", async () => {
    row = mkRow({ exposedPorts: [3000] });
    const res = await proxyDevPreview(req("GET", "https://app.test/api/projects/p1/dev-preview/9999/"), { projectId: "p1", port: "9999" }, ctx());
    assert.equal(res.status, 404);
  });

  it("403 on writes for a viewer", async () => {
    row = mkRow();
    providerSandbox = upstreamSandbox;
    const res = await proxyDevPreview(req("POST"), { projectId: "p1", port: "3000" }, ctx(false));
    assert.equal(res.status, 403);
  });

  it("proxies a running sandbox and keeps redirects inside the prefix", async () => {
    row = mkRow();
    providerSandbox = upstreamSandbox;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) =>
      new Response("ok", { status: 200, headers: { location: "https://sb-1-3000.e2b.dev/next" } })) as typeof fetch;
    try {
      const res = await proxyDevPreview(req("GET"), { projectId: "p1", port: "3000" }, ctx());
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "ok");
      assert.equal(res.headers.get("location"), "/api/projects/p1/dev-preview/3000/next");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
