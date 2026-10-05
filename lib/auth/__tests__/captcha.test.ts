// ShapesOS Phase 4a — CAPTCHA step-up after repeated login failures.
// No provider → documented no-op (backoff only); with a provider, a CAPTCHA
// is due after N failures per account OR per IP, and tokens are verified
// server-side (fail closed on provider errors).
// Run: npx tsx --test lib/auth/__tests__/captcha.test.ts

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { captchaConfig, captchaRequired, publicCaptchaConfig, verifyCaptchaToken } from "../captcha";
import { __resetLoginAttempts, loginFailureCounts, recordLoginFailure, recordLoginSuccess, LOGIN_WINDOW_MS } from "../rate-limit";

const TURNSTILE = { CAPTCHA_PROVIDER: "turnstile", CAPTCHA_SITE_KEY: "site", CAPTCHA_SECRET_KEY: "secret" } as unknown as NodeJS.ProcessEnv;

beforeEach(() => __resetLoginAttempts());

describe("config", () => {
  it("off without a provider, or with an incomplete/unknown one", () => {
    assert.equal(captchaConfig({} as unknown as NodeJS.ProcessEnv), null);
    assert.equal(captchaConfig({ CAPTCHA_PROVIDER: "turnstile" } as unknown as NodeJS.ProcessEnv), null);
    assert.equal(captchaConfig({ ...TURNSTILE, CAPTCHA_PROVIDER: "recaptcha" }), null);
  });
  it("public config never carries the secret", () => {
    assert.deepEqual(publicCaptchaConfig(TURNSTILE), { provider: "turnstile", siteKey: "site" });
    assert.equal(captchaConfig({ ...TURNSTILE, LOGIN_CAPTCHA_AFTER_FAILURES: "5" })?.afterFailures, 5);
    assert.equal(captchaConfig({ ...TURNSTILE, LOGIN_CAPTCHA_AFTER_FAILURES: "nope" })?.afterFailures, 3);
  });
});

describe("step-up threshold", () => {
  it("never required without a provider (backoff only)", () => {
    for (let i = 0; i < 10; i++) recordLoginFailure("1.2.3.4", "a@x.io");
    assert.equal(captchaRequired("1.2.3.4", "a@x.io", { env: {} as unknown as NodeJS.ProcessEnv }), false);
  });

  it("required after 3 account failures, from any IP", () => {
    const t = Date.now();
    recordLoginFailure("1.1.1.1", "a@x.io", t);
    recordLoginFailure("2.2.2.2", "a@x.io", t);
    assert.equal(captchaRequired("3.3.3.3", "a@x.io", { env: TURNSTILE, now: t }), false);
    recordLoginFailure("3.3.3.3", "a@x.io", t);
    assert.equal(captchaRequired("9.9.9.9", "a@x.io", { env: TURNSTILE, now: t }), true);
    assert.equal(captchaRequired("9.9.9.9", "b@x.io", { env: TURNSTILE, now: t }), false);
  });

  it("required after 3 failures from one IP across accounts", () => {
    const t = Date.now();
    for (const e of ["a@x.io", "b@x.io", "c@x.io"]) recordLoginFailure("5.5.5.5", e, t);
    assert.equal(captchaRequired("5.5.5.5", "fresh@x.io", { env: TURNSTILE, now: t }), true);
  });

  it("success clears it; the window expiring clears it", () => {
    const t = Date.now();
    for (let i = 0; i < 3; i++) recordLoginFailure("1.1.1.1", "a@x.io", t);
    recordLoginSuccess("1.1.1.1", "a@x.io");
    assert.deepEqual(loginFailureCounts("1.1.1.1", "a@x.io", t), { ip: 0, account: 0 });
    for (let i = 0; i < 3; i++) recordLoginFailure("1.1.1.1", "b@x.io", t);
    assert.equal(captchaRequired("1.1.1.1", "b@x.io", { env: TURNSTILE, now: t + LOGIN_WINDOW_MS + 1 }), false);
  });
});

describe("server-side verification", () => {
  it("posts the secret, token and IP to the provider; only success:true passes", async () => {
    let seen: { url: string; body: string } | null = null;
    const ok = await verifyCaptchaToken("tok", "1.2.3.4", {
      env: TURNSTILE,
      fetchImpl: async (url, init) => {
        seen = { url, body: String(init.body) };
        return { ok: true, json: async () => ({ success: true }) };
      },
    });
    assert.equal(ok, true);
    assert.equal(seen!.url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const params = new URLSearchParams(seen!.body);
    assert.equal(params.get("secret"), "secret");
    assert.equal(params.get("response"), "tok");
    assert.equal(params.get("remoteip"), "1.2.3.4");

    const hc = { ...TURNSTILE, CAPTCHA_PROVIDER: "hcaptcha" };
    const denied = await verifyCaptchaToken("tok", null, {
      env: hc,
      fetchImpl: async (url) => {
        assert.equal(url, "https://api.hcaptcha.com/siteverify");
        return { ok: true, json: async () => ({ success: false }) };
      },
    });
    assert.equal(denied, false);
  });

  it("fails closed: missing token, HTTP error or network error", async () => {
    const boom = async () => {
      throw new Error("network");
    };
    assert.equal(await verifyCaptchaToken("", null, { env: TURNSTILE, fetchImpl: boom }), false);
    assert.equal(await verifyCaptchaToken("t", null, { env: TURNSTILE, fetchImpl: boom }), false);
    assert.equal(
      await verifyCaptchaToken("t", null, { env: TURNSTILE, fetchImpl: async () => ({ ok: false, json: async () => ({}) }) }),
      false,
    );
  });

  it("no provider: nothing to verify", async () => {
    assert.equal(await verifyCaptchaToken(null, null, { env: {} as unknown as NodeJS.ProcessEnv }), true);
  });
});
