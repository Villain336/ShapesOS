// Phase 3: proxy.ts attaches the per-request nonce CSP.
// Run: npx tsx --test lib/security/__tests__/proxy-csp.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { getScriptNonceFromHeader } from "next/dist/server/app-render/get-script-nonce-from-header";

import { proxy, config } from "../../../proxy";
import { API_CONTENT_SECURITY_POLICY, USER_FILE_VIEW_CSP } from "../headers";

const req = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
  new NextRequest(new URL(path, "http://localhost:3000"), init);

/** NextResponse.next({ request: { headers } }) encodes the forwarded request headers like this. */
const forwarded = (res: Response, name: string) => res.headers.get(`x-middleware-request-${name}`);

describe("proxy CSP", () => {
  it("page request: fresh nonce on the response policy, the forwarded request policy and x-nonce", async () => {
    const res = await proxy(req("/dashboard", { headers: { "content-security-policy": "script-src 'unsafe-inline'" } }));
    const csp = res.headers.get("content-security-policy")!;
    const nonce = getScriptNonceFromHeader(csp);
    assert.ok(nonce, "response policy carries a nonce");
    assert.doesNotMatch(csp.split(";")[0]!, /'unsafe-inline'/, "script-src has no 'unsafe-inline'");
    assert.equal(forwarded(res, "x-nonce"), nonce);
    // A client-supplied CSP request header is replaced, never trusted.
    assert.equal(forwarded(res, "content-security-policy"), csp);

    const again = await proxy(req("/dashboard"));
    assert.notEqual(getScriptNonceFromHeader(again.headers.get("content-security-policy")!), nonce);
  });

  it("API request: scriptless API policy, rate limiting still applies", async () => {
    const res = await proxy(req("/api/projects"));
    assert.equal(res.headers.get("content-security-policy"), API_CONTENT_SECURITY_POLICY);
    const big = await proxy(req("/api/projects", { method: "POST", headers: { "content-length": String(11 * 1024 * 1024) } }));
    assert.equal(big.status, 400);
    assert.equal(big.headers.get("content-security-policy"), API_CONTENT_SECURITY_POLICY);
  });

  // Phase 4a follow-up: the data-room file stream (/r/funding/<token>?dl=1)
  // used to get the PAGE policy — the route's own sandbox CSP was dropped in
  // favour of the proxy's header. It now gets the sandboxed file policy here.
  it("data-room file stream gets the sandboxed file policy; the viewer page keeps its nonce policy", async () => {
    for (const path of ["/r/funding/tok123?dl=1", "/r/funding/tok123?v=ver_1&dl=1", "/r/funding/tok123/?dl"]) {
      const res = await proxy(req(path));
      assert.equal(res.headers.get("content-security-policy"), USER_FILE_VIEW_CSP, path);
      assert.equal(getScriptNonceFromHeader(res.headers.get("content-security-policy")!), undefined, path);
    }
    for (const path of ["/r/funding/tok123", "/r/funding/tok123?v=ver_1", "/r/funding/tok123/views/v1?dl=1"]) {
      const res = await proxy(req(path));
      assert.ok(getScriptNonceFromHeader(res.headers.get("content-security-policy")!), path);
    }
  });

  it("matcher covers every API route and pages, skips build output and public assets", () => {
    const [api, pages] = config.matcher;
    assert.equal(api, "/api/:path*");
    const re = new RegExp(`^${pages.replace(/^\//, "\\/")}$`);
    for (const p of ["/", "/dashboard", "/admin", "/s/tok", "/r/funding/x", "/login"]) assert.ok(re.test(p), p);
    for (const p of ["/_next/static/chunks/a.js", "/_next/image", "/favicon.ico", "/studio/x.png", "/globe.svg"]) {
      assert.ok(!re.test(p), p);
    }
  });
});
