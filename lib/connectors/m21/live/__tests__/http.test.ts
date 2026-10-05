// Phase 4b: shared live HTTP layer — refresh-on-401, 429/5xx backoff,
// Retry-After, network retry, closed error codes, secret scrubbing.
// Run: npx tsx --test lib/connectors/m21/live/__tests__/http.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  liveRequest,
  ConnectorApiError,
  scrubMessage,
  defaultClassify,
  tokenSourceFrom,
  liveFailure,
  backoffMs,
} from "../http";
import { jsonResponse, scriptedFetch, liveDeps, oauthCred } from "./fixtures";

const URL_ = "https://api.example.test/v1/thing";

describe("liveRequest", () => {
  it("sends Bearer auth, query params and a JSON body", async () => {
    const f = scriptedFetch([jsonResponse(200, { ok: 1 })]);
    const { deps } = liveDeps(f.fetchImpl);
    const out = await liveRequest(
      { provider: "X", url: URL_, method: "POST", query: { a: 1, b: undefined, c: "z" }, json: { q: "hi" }, auth: { token: "t1" } },
      deps,
    );
    assert.deepEqual(out, { ok: 1 });
    const call = f.calls[0];
    assert.equal(call.method, "POST");
    assert.equal(call.headers.authorization, "Bearer t1");
    assert.equal(call.headers["content-type"], "application/json");
    assert.equal(call.url.searchParams.get("a"), "1");
    assert.equal(call.url.searchParams.has("b"), false);
    assert.deepEqual(call.body, { q: "hi" });
  });

  it("refreshes once on 401 and retries with the new token", async () => {
    const f = scriptedFetch([jsonResponse(401, { error: { message: "expired" } }), jsonResponse(200, { ok: true })]);
    const { deps } = liveDeps(f.fetchImpl);
    let refreshes = 0;
    const out = await liveRequest(
      { provider: "X", url: URL_, auth: { token: "old", refresh: async () => (refreshes++, "new") } },
      deps,
    );
    assert.deepEqual(out, { ok: true });
    assert.equal(refreshes, 1);
    assert.equal(f.calls[0].headers.authorization, "Bearer old");
    assert.equal(f.calls[1].headers.authorization, "Bearer new");
  });

  it("a failed refresh is auth_rejected and does not loop", async () => {
    const f = scriptedFetch([jsonResponse(401, {})]);
    const { deps } = liveDeps(f.fetchImpl);
    await assert.rejects(
      liveRequest({ provider: "X", url: URL_, auth: { token: "old", refresh: async () => null } }, deps),
      (e: unknown) => e instanceof ConnectorApiError && e.code === "auth_rejected",
    );
    assert.equal(f.calls.length, 1);
  });

  it("a second 401 after refresh is auth_rejected (refresh only once)", async () => {
    const f = scriptedFetch([jsonResponse(401, {}), jsonResponse(401, {})]);
    const { deps } = liveDeps(f.fetchImpl);
    let refreshes = 0;
    await assert.rejects(
      liveRequest({ provider: "X", url: URL_, auth: { token: "a", refresh: async () => (refreshes++, "b") } }, deps),
      (e: unknown) => e instanceof ConnectorApiError && e.code === "auth_rejected",
    );
    assert.equal(refreshes, 1);
  });

  it("backs off on 429 honouring Retry-After seconds, then succeeds", async () => {
    const f = scriptedFetch([
      jsonResponse(429, { message: "slow down" }, { "retry-after": "3" }),
      jsonResponse(503, {}),
      jsonResponse(200, { done: true }),
    ]);
    const { deps, sleeps } = liveDeps(f.fetchImpl);
    const out = await liveRequest({ provider: "X", url: URL_, auth: { token: "t" } }, deps);
    assert.deepEqual(out, { done: true });
    assert.equal(sleeps[0], 3000);
    assert.ok(sleeps[1] >= 200 && sleeps[1] <= 250, `exponential step 2 was ${sleeps[1]}`);
  });

  it("caps Retry-After at 60s and accepts HTTP dates", async () => {
    const future = new Date(Date.now() + 10 * 60_000).toUTCString();
    const f = scriptedFetch([jsonResponse(429, {}, { "retry-after": future }), jsonResponse(200, {})]);
    const { deps, sleeps } = liveDeps(f.fetchImpl);
    await liveRequest({ provider: "X", url: URL_ }, deps);
    assert.equal(sleeps[0], 60_000);
  });

  it("gives up after maxRetries with rate_limited", async () => {
    const f = scriptedFetch([jsonResponse(429, {}), jsonResponse(429, {}), jsonResponse(429, {})]);
    const { deps } = liveDeps(f.fetchImpl);
    await assert.rejects(
      liveRequest({ provider: "X", url: URL_ }, { ...deps, maxRetries: 2 }),
      (e: unknown) => e instanceof ConnectorApiError && e.code === "rate_limited" && e.status === 429,
    );
    assert.equal(f.calls.length, 3);
  });

  it("retries network failures then maps to provider_unreachable", async () => {
    const f = scriptedFetch([new TypeError("fetch failed"), new TypeError("fetch failed")]);
    const { deps } = liveDeps(f.fetchImpl);
    await assert.rejects(
      liveRequest({ provider: "X", url: URL_ }, { ...deps, maxRetries: 1 }),
      (e: unknown) => e instanceof ConnectorApiError && e.code === "provider_unreachable",
    );
  });

  it("maps statuses to closed codes without retrying client errors", async () => {
    for (const [status, code] of [
      [400, "bad_request"],
      [403, "forbidden"],
      [404, "not_found"],
      [422, "bad_request"],
    ] as const) {
      const f = scriptedFetch([jsonResponse(status, { error: { message: "nope" } })]);
      const { deps } = liveDeps(f.fetchImpl);
      await assert.rejects(
        liveRequest({ provider: "X", url: URL_ }, deps),
        (e: unknown) => e instanceof ConnectorApiError && e.code === code && /nope/.test(e.message),
      );
      assert.equal(f.calls.length, 1);
    }
  });

  it("treats Google quota 403s as rate limits", () => {
    const c = defaultClassify(403, { error: { errors: [{ reason: "userRateLimitExceeded" }], message: "quota" } });
    assert.equal(c.code, "rate_limited");
    assert.equal(c.retryable, true);
  });

  it("returns text for responseType text and caps it", async () => {
    const f = scriptedFetch([new Response("abcdef", { status: 200 })]);
    const { deps } = liveDeps(f.fetchImpl);
    const out = await liveRequest<string>({ provider: "X", url: URL_, responseType: "text", maxTextBytes: 3 }, deps);
    assert.equal(out, "abc");
  });
});

describe("scrubbing + helpers", () => {
  it("scrubs token-shaped text from provider messages", () => {
    const out = scrubMessage("bad Bearer ya29.abcDEF access_token=xyz secret_ABCDEFGHIJKLMN and EAAB" + "x".repeat(30));
    assert.ok(!/ya29\.abc|xyz|secret_ABC|EAABxxxx/.test(out), out);
    assert.ok(scrubMessage("x".repeat(1000)).length <= 301);
  });

  it("error messages never contain the bearer token", async () => {
    const f = scriptedFetch([jsonResponse(400, { error: { message: "token Bearer sekret-123 invalid" } })]);
    const { deps } = liveDeps(f.fetchImpl);
    await assert.rejects(liveRequest({ provider: "X", url: URL_, auth: { token: "sekret-123" } }, deps), (e: unknown) => {
      return e instanceof Error && !e.message.includes("sekret-123");
    });
  });

  it("tokenSourceFrom: null without an access token (→ mock mode)", () => {
    assert.equal(tokenSourceFrom(null), null);
    assert.equal(tokenSourceFrom({ kind: "api_key", payload: { apiKey: "k" } }), null);
    const src = tokenSourceFrom(oauthCred("abc"));
    assert.equal(src?.token, "abc");
    assert.equal(src?.refresh, undefined);
  });

  it("liveFailure maps ConnectorApiError to a closed errorCode", () => {
    const r = liveFailure(new ConnectorApiError("X", "forbidden", "X request failed (HTTP 403)"), "X");
    assert.deepEqual(r, { ok: false, error: "X request failed (HTTP 403)", errorCode: "forbidden", mock: false });
    assert.equal(liveFailure(new Error("boom"), "X").errorCode, "provider_error");
  });

  it("backoff doubles with bounded jitter", () => {
    for (let i = 0; i < 4; i++) {
      const ms = backoffMs(i, 100);
      assert.ok(ms >= 100 * 2 ** i && ms <= 125 * 2 ** i);
    }
  });
});

describe("transport: safeFetch + literal secret redaction", () => {
  it("refuses a provider host that resolves to a private address (no request sent)", async () => {
    const f = scriptedFetch([]);
    const { deps } = liveDeps(f.fetchImpl);
    await assert.rejects(
      liveRequest({ provider: "X", url: URL_, auth: { token: "t" } }, { ...deps, resolve: async () => ["169.254.169.254"], maxRetries: 0 }),
      (e: unknown) => e instanceof ConnectorApiError && e.code === "provider_unreachable",
    );
    assert.equal(f.calls.length, 0);
  });

  it("follows a cross-origin redirect manually and drops the bearer token", async () => {
    const f = scriptedFetch([
      new Response(null, { status: 302, headers: { location: "https://cdn.example.test/file" } }),
      jsonResponse(200, { ok: true }),
    ]);
    const { deps } = liveDeps(f.fetchImpl);
    const out = await liveRequest<{ ok: boolean }>({ provider: "X", url: URL_, auth: { token: "tok-secret" } }, deps);
    assert.deepEqual(out, { ok: true });
    assert.equal(f.calls[0].headers.authorization, "Bearer tok-secret");
    assert.equal(f.calls[1].url.host, "cdn.example.test");
    assert.equal(f.calls[1].headers.authorization, undefined);
  });

  it("redacts the literal token and credential headers even when echoed bare", async () => {
    const f = scriptedFetch([
      jsonResponse(400, { error: { message: "token plain-token-value and dev devtok-12345 are invalid" } }),
    ]);
    const { deps } = liveDeps(f.fetchImpl);
    await assert.rejects(
      liveRequest(
        { provider: "X", url: URL_, auth: { token: "plain-token-value" }, headers: { "developer-token": "devtok-12345" } },
        deps,
      ),
      (e: unknown) =>
        e instanceof ConnectorApiError &&
        !e.message.includes("plain-token-value") &&
        !e.message.includes("devtok-12345") &&
        /\[redacted\]/.test(e.message),
    );
  });
});
