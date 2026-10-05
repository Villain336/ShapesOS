// ShapesOS — Phase 4a: proxy.ts gives every request an x-request-id and lets
// the public health endpoints through (no session, API CSP, read tier).
// Run: npx tsx --test lib/observability/__tests__/proxy-request-id.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { proxy } from "../../../proxy";
import { API_CONTENT_SECURITY_POLICY } from "../../security/headers";
import { classifyTier } from "../../api/rate-limit";

const req = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
  new NextRequest(new URL(path, "http://localhost:3000"), init);
const forwarded = (res: Response, name: string) => res.headers.get(`x-middleware-request-${name}`);

describe("proxy request id", () => {
  it("mints one per request, forwards it and returns it", async () => {
    const a = await proxy(req("/api/projects"));
    const b = await proxy(req("/dashboard"));
    const idA = a.headers.get("x-request-id");
    assert.match(idA ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(forwarded(a, "x-request-id"), idA);
    assert.notEqual(b.headers.get("x-request-id"), idA);
  });

  it("keeps a well-formed upstream id and replaces a malformed one", async () => {
    const kept = await proxy(req("/api/projects", { headers: { "x-request-id": "lb-0123456789" } }));
    assert.equal(kept.headers.get("x-request-id"), "lb-0123456789");
    const replaced = await proxy(req("/api/projects", { headers: { "x-request-id": 'x"}{"evil":1' } }));
    assert.match(replaced.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
  });

  it("rejected requests carry the id too", async () => {
    const big = await proxy(req("/api/projects", { method: "POST", headers: { "content-length": String(11 * 1024 * 1024) } }));
    assert.equal(big.status, 400);
    assert.ok(big.headers.get("x-request-id"));
  });
});

describe("health endpoints through the proxy", () => {
  for (const path of ["/api/health", "/api/health/live"]) {
    it(`${path} passes without a session, with the API policy`, async () => {
      const res = await proxy(req(path));
      assert.equal(res.status, 200, "passed through (NextResponse.next)");
      assert.equal(res.headers.get("x-middleware-next"), "1");
      assert.equal(res.headers.get("content-security-policy"), API_CONTENT_SECURITY_POLICY);
      assert.equal(classifyTier(path, "GET"), "read");
    });
  }
});
