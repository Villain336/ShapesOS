// Phase 21A round 2 (WS=agentweb): outbound agent traffic is honest and signed, and a
// site that says no gets a typed answer, not a workaround.
//   - every request names the agent (ShapesOS-Agent/1.0) and, with an identity
//     configured, carries Web Bot Auth headers made for THAT hop's authority;
//   - a redirect to another host is signed again for the new host (a signature never
//     travels to a host it was not made for);
//   - nothing else is added: no cookies, no browser-like headers, no retries with a
//     different identity;
//   - 401/403/429/challenge pages become `blocked_by_site` (the UI explains the manual
//     path); HTTP 402 becomes `payment_required` (a person decides; nothing is paid).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentFetch, classifyResponse, signedNavigationHeaders, type Signer } from "../agent-fetch";
import { generateKeyPair, signRequest, verifyRequest } from "../httpsig";

const keys = generateKeyPair();
const NOW = 1_800_000_000;
const signer: Signer = async ({ url, method }) => signRequest({ url, method, keys, created: NOW, expires: NOW + 60, signatureAgent: { url: "https://app.shapesos.test" } });
const resolve = async () => ["93.184.216.34"];

function fakeFetch(script: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url: String(input), headers });
    return script(String(input), init ?? {});
  }) as typeof fetch;
  return { fn, calls };
}

describe("agentFetch", () => {
  it("names the agent and signs for the authority it is calling", async () => {
    const f = fakeFetch(() => new Response("ok"));
    await agentFetch("https://a.example/page", {}, { fetchFn: f.fn, resolve, signer });
    const h = f.calls[0]!.headers;
    assert.match(h["user-agent"]!, /^ShapesOS-Agent\/1\.0 /);
    assert.equal(h["signature-agent"], '"https://app.shapesos.test"');
    const r = verifyRequest({ url: "https://a.example/page", headers: h, resolveKey: (id) => (id === keys.kid ? keys.x : null), now: NOW });
    assert.equal(r.ok, true);
    assert.equal(verifyRequest({ url: "https://b.example/page", headers: h, resolveKey: (id) => (id === keys.kid ? keys.x : null), now: NOW }).ok, false);
  });

  it("signs every redirect hop for the host it is going to, never reusing a signature across hosts", async () => {
    const f = fakeFetch((url) => (url.startsWith("https://a.example") ? new Response(null, { status: 302, headers: { location: "https://b.example/landing" } }) : new Response("landed")));
    const res = await agentFetch("https://a.example/start", {}, { fetchFn: f.fn, resolve, signer });
    assert.equal(await res.text(), "landed");
    assert.deepEqual(f.calls.map((c) => c.url), ["https://a.example/start", "https://b.example/landing"]);
    const resolveKey = (id: string) => (id === keys.kid ? keys.x : null);
    assert.equal(verifyRequest({ url: "https://b.example/landing", headers: f.calls[1]!.headers, resolveKey, now: NOW }).ok, true);
    assert.equal(verifyRequest({ url: "https://b.example/landing", headers: f.calls[0]!.headers, resolveKey, now: NOW }).ok, false, "the first hop's signature is not valid for the second host");
  });

  it("without an identity it is still honest: a user agent and no signature headers", async () => {
    const f = fakeFetch(() => new Response("ok"));
    await agentFetch("https://a.example/", {}, { fetchFn: f.fn, resolve, signer: null });
    assert.match(f.calls[0]!.headers["user-agent"]!, /ShapesOS-Agent/);
    assert.equal(f.calls[0]!.headers["signature"], undefined);
  });

  it("a failing signer never blocks the request or changes who it says it is", async () => {
    const f = fakeFetch(() => new Response("ok"));
    const res = await agentFetch("https://a.example/", {}, { fetchFn: f.fn, resolve, signer: async () => { throw new Error("db down"); } });
    assert.equal(res.status, 200);
    assert.equal(f.calls[0]!.headers["signature"], undefined);
    assert.match(f.calls[0]!.headers["user-agent"]!, /ShapesOS-Agent/);
  });

  it("adds nothing that helps it pass as a person: only user-agent, accept and the signature headers", async () => {
    const f = fakeFetch(() => new Response("ok"));
    await agentFetch("https://a.example/", {}, { fetchFn: f.fn, resolve, signer });
    const names = Object.keys(f.calls[0]!.headers).sort();
    assert.deepEqual(names, ["accept", "signature", "signature-agent", "signature-input", "user-agent"]);
  });

  it("refuses a private address like every other agent fetch", async () => {
    const f = fakeFetch(() => new Response("ok"));
    await assert.rejects(() => agentFetch("http://169.254.169.254/latest", {}, { fetchFn: f.fn, signer }), /disallowed address/i);
    assert.equal(f.calls.length, 0);
  });
});

describe("classifyResponse", () => {
  const res = (status: number, body = "", headers: Record<string, string> = {}) => ({ response: new Response(body, { status, headers }), body });
  const c = (status: number, body = "", headers: Record<string, string> = {}) => classifyResponse(new Response(body, { status, headers }), body);

  it("a normal page is ok", () => assert.deepEqual(c(200, "<html>hi</html>"), { kind: "ok" }));

  it("a bot challenge is blocked_by_site, whatever the status", () => {
    assert.deepEqual(c(403, "", { "cf-mitigated": "challenge" }), { kind: "blocked_by_site", reason: "challenge", status: 403, manualPath: true });
    assert.equal((c(403, "<title>Attention Required! | Cloudflare</title>") as { reason: string }).reason, "challenge");
    assert.equal((c(503, "Please complete the CAPTCHA to continue") as { reason: string }).reason, "challenge");
    assert.equal((c(200, "<title>Just a moment...</title><div>Verify you are human</div>") as { kind: string }).kind, "blocked_by_site");
  });

  it("403, 401 and 429 are blocked_by_site with the reason named", () => {
    assert.deepEqual(c(403, "Forbidden"), { kind: "blocked_by_site", reason: "forbidden", status: 403, manualPath: true });
    assert.deepEqual(c(401, ""), { kind: "blocked_by_site", reason: "unauthorized", status: 401, manualPath: true });
    assert.deepEqual(c(429, "", { "retry-after": "120" }), { kind: "blocked_by_site", reason: "rate_limited", status: 429, manualPath: true, retryAfterSec: 120 });
  });

  it("402 is payment_required: a price is read when the site states one, and nothing is paid", () => {
    assert.deepEqual(c(402, "", { "crawler-price": "USD 0.01" }), { kind: "payment_required", status: 402, price: "USD 0.01" });
    assert.deepEqual(c(402, "Payment required"), { kind: "payment_required", status: 402, price: null });
  });

  it("server errors are not an accusation of blocking", () => {
    assert.deepEqual(c(500, "oops"), { kind: "error", status: 500 });
  });
  void res;
});

describe("signedNavigationHeaders (the server browser's top-level navigations)", () => {
  const page = { url: "https://a.example/x", method: "GET", headers: { accept: "text/html", cookie: "kept=1" } };
  it("adds the signature for that URL and keeps the page's own headers", async () => {
    const h = await signedNavigationHeaders(signer, page);
    assert.equal(h!.accept, "text/html");
    assert.equal(h!.cookie, "kept=1");
    assert.equal(verifyRequest({ url: "https://a.example/x", headers: h!, resolveKey: (id) => (id === keys.kid ? keys.x : null), now: NOW }).ok, true);
  });
  it("is null without an identity or when signing fails", async () => {
    assert.equal(await signedNavigationHeaders(null, page), null);
    assert.equal(await signedNavigationHeaders(async () => { throw new Error("x"); }, page), null);
  });
});
