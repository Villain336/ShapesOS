// ShapesOS — Phase 6: rate-limit store selection and fallback (no database).
// The Postgres store itself is exercised in rate-limit-store-db.test.ts.
// Run: npx tsx --test lib/api/__tests__/rate-limit-store.test.ts

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  __setCounterStoreForTests,
  rateLimitStoreKind,
  sharedCounterStore,
  withStoreTimeout,
  type CounterStore,
  type LockoutRecord,
} from "../rate-limit-store";
import { __resetRateLimits, checkRateLimit, checkRateLimitAsync, TIER_LIMITS } from "../rate-limit";
import {
  __resetLoginAttempts,
  LOGIN_ACCOUNT_MAX_FAILURES,
  loginFailureCountsAsync,
  loginLockedOut,
  loginLockedOutAsync,
  recordLoginFailureAsync,
  recordLoginSuccessAsync,
} from "../../auth/rate-limit";
import { captchaRequiredAsync } from "../../auth/captcha";

const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;

/** A store whose every call rejects (database down). */
function failingStore(): CounterStore & { calls: number } {
  const s = {
    kind: "test" as const,
    calls: 0,
    async hit(): Promise<never> {
      s.calls++;
      throw new Error("connection refused");
    },
    async bumpLockout(): Promise<never> {
      s.calls++;
      throw new Error("connection refused");
    },
    async readLockouts(): Promise<never> {
      s.calls++;
      throw new Error("connection refused");
    },
    async clear(): Promise<never> {
      s.calls++;
      throw new Error("connection refused");
    },
    async cleanup(): Promise<number> {
      return 0;
    },
  };
  return s;
}

/** A working in-process stand-in for the shared table (mock — labelled as such). */
function fakeSharedStore(): CounterStore & { lockouts: Map<string, LockoutRecord>; cleared: string[][] } {
  const windows = new Map<string, { count: number; windowStart: number }>();
  const lockouts = new Map<string, LockoutRecord>();
  const cleared: string[][] = [];
  return {
    kind: "test",
    lockouts,
    cleared,
    async hit(key, windowMs, now) {
      let w = windows.get(key);
      if (!w || now - w.windowStart >= windowMs) w = { count: 0, windowStart: now };
      w.count += 1;
      windows.set(key, w);
      return { ...w };
    },
    async bumpLockout(key, _policy, now) {
      const r = lockouts.get(key) ?? { failures: 0, firstAt: now, lockedUntil: 0 };
      r.failures += 1;
      lockouts.set(key, r);
      return { ...r };
    },
    async readLockouts(keys) {
      return new Map(keys.filter((k) => lockouts.has(k)).map((k) => [k, lockouts.get(k)!]));
    },
    async clear(keys) {
      cleared.push(keys);
      for (const k of keys) lockouts.delete(k);
    },
    async cleanup() {
      return 0;
    },
  };
}

afterEach(() => {
  __setCounterStoreForTests(undefined);
  __resetRateLimits();
  __resetLoginAttempts();
});

describe("RATE_LIMIT_STORE selection", () => {
  it("defaults to postgres when DATABASE_URL is set on Node", () => {
    assert.equal(rateLimitStoreKind(env({ DATABASE_URL: "postgresql://x" })), "postgres");
  });
  it("defaults to memory without DATABASE_URL", () => {
    assert.equal(rateLimitStoreKind(env({})), "memory");
    assert.equal(rateLimitStoreKind(env({ DATABASE_URL: "  " })), "memory");
  });
  it("an explicit value wins", () => {
    assert.equal(rateLimitStoreKind(env({ RATE_LIMIT_STORE: "memory", DATABASE_URL: "postgresql://x" })), "memory");
    assert.equal(rateLimitStoreKind(env({ RATE_LIMIT_STORE: " Postgres " })), "postgres");
  });
  it("the edge runtime is always memory", () => {
    assert.equal(
      rateLimitStoreKind(env({ NEXT_RUNTIME: "edge", RATE_LIMIT_STORE: "postgres", DATABASE_URL: "postgresql://x" })),
      "memory",
    );
  });
  it("an unknown value falls back to the default", () => {
    assert.equal(rateLimitStoreKind(env({ RATE_LIMIT_STORE: "redis", DATABASE_URL: "postgresql://x" })), "postgres");
    assert.equal(rateLimitStoreKind(env({ RATE_LIMIT_STORE: "redis" })), "memory");
  });
  it("sharedCounterStore follows the selection", () => {
    assert.equal(sharedCounterStore(env({ RATE_LIMIT_STORE: "memory", DATABASE_URL: "postgresql://x" })), null);
    assert.equal(sharedCounterStore(env({ RATE_LIMIT_STORE: "postgres" }))?.kind, "postgres");
  });
});

describe("checkRateLimitAsync", () => {
  it("memory selected: identical to the in-memory limiter", async () => {
    __setCounterStoreForTests(null);
    const now = 1_000_000;
    let allowed = 0;
    for (let i = 0; i < 15; i++) if ((await checkRateLimitAsync("auth:ip:1.1.1.1", "auth", now)).allowed) allowed++;
    assert.equal(allowed, TIER_LIMITS.auth.limit);
  });

  it("shared store: counts come from the store, Retry-After from its window", async () => {
    const store = fakeSharedStore();
    __setCounterStoreForTests(store);
    const now = 2_000_000;
    let allowed = 0;
    for (let i = 0; i < 12; i++) if ((await checkRateLimitAsync("auth:ip:2.2.2.2", "auth", now)).allowed) allowed++;
    assert.equal(allowed, 10);
    const denied = await checkRateLimitAsync("auth:ip:2.2.2.2", "auth", now + 15_000);
    assert.equal(denied.allowed, false);
    assert.equal(denied.retryAfterMs, 45_000);
    // The in-memory limiter was not consulted, so its budget is untouched.
    assert.equal(checkRateLimit("auth:ip:2.2.2.2", "auth", now).allowed, true);
  });

  it("store failure fails OPEN to the in-memory limiter (still limited)", async () => {
    const store = failingStore();
    __setCounterStoreForTests(store);
    const now = 3_000_000;
    let allowed = 0;
    for (let i = 0; i < 15; i++) if ((await checkRateLimitAsync("auth:ip:3.3.3.3", "auth", now)).allowed) allowed++;
    assert.equal(store.calls, 15, "the store is tried every time");
    assert.equal(allowed, TIER_LIMITS.auth.limit, "the per-process limit still applies");
  });

  it("a hung store times out and falls back", async () => {
    const hung: CounterStore = { ...failingStore(), hit: () => new Promise(() => {}) };
    __setCounterStoreForTests(hung);
    const t0 = Date.now();
    const r = await checkRateLimitAsync("write:user:hung", "write", 4_000_000);
    assert.equal(r.allowed, true);
    assert.ok(Date.now() - t0 < 5_000);
  });

  it("Phase 17: the read tier is counted per process (no store round trip); auth / write / ai stay shared", async () => {
    const store = failingStore();
    __setCounterStoreForTests(store);
    const now = 5_000_000;
    let allowed = 0;
    for (let i = 0; i < TIER_LIMITS.read.limit + 5; i++) if ((await checkRateLimitAsync("read:user:p17", "read", now)).allowed) allowed++;
    assert.equal(store.calls, 0, "a read never touches the shared store");
    assert.equal(allowed, TIER_LIMITS.read.limit, "still limited, per process");
    for (const tier of ["auth", "write", "ai"] as const) await checkRateLimitAsync(`${tier}:user:p17`, tier, now);
    assert.equal(store.calls, 3, "the correctness / money tiers still go to the shared store");
  });

  it("withStoreTimeout rejects past the bound and passes values through", async () => {
    await assert.rejects(() => withStoreTimeout(new Promise(() => {}), 20), /timed out/);
    assert.equal(await withStoreTimeout(Promise.resolve(7), 20), 7);
  });
});

describe("login lockout over the shared store", () => {
  it("store failure falls back to the in-memory lockout — never fails open", async () => {
    __setCounterStoreForTests(failingStore());
    const now = 5_000_000;
    for (let i = 0; i < LOGIN_ACCOUNT_MAX_FAILURES; i++) await recordLoginFailureAsync("4.4.4.4", "owner@x.io", now);
    assert.equal(await loginLockedOutAsync("4.4.4.4", "owner@x.io", now + 1), true);
    assert.equal(await loginLockedOutAsync("5.5.5.5", "owner@x.io", now + 1), true, "per-account across IPs");
    const counts = await loginFailureCountsAsync("4.4.4.4", "owner@x.io", now + 1);
    assert.deepEqual(counts, { ip: LOGIN_ACCOUNT_MAX_FAILURES, account: LOGIN_ACCOUNT_MAX_FAILURES });
  });

  it("failures are always recorded in memory too (the fallback has state)", async () => {
    const store = fakeSharedStore();
    __setCounterStoreForTests(store);
    const now = 6_000_000;
    for (let i = 0; i < LOGIN_ACCOUNT_MAX_FAILURES; i++) await recordLoginFailureAsync("6.6.6.6", "a@x.io", now);
    assert.equal(loginLockedOut("6.6.6.6", "a@x.io", now + 1), true);
    assert.equal(store.lockouts.get("login:acct:a@x.io")?.failures, LOGIN_ACCOUNT_MAX_FAILURES);
    assert.equal(store.lockouts.get("login:ip:6.6.6.6")?.failures, LOGIN_ACCOUNT_MAX_FAILURES);
  });

  it("the shared store decides when it answers (a lock set by another replica)", async () => {
    const store = fakeSharedStore();
    __setCounterStoreForTests(store);
    const now = 7_000_000;
    store.lockouts.set("login:acct:b@x.io", { failures: 5, firstAt: now - 1000, lockedUntil: now + 60_000 });
    assert.equal(loginLockedOut("7.7.7.7", "B@x.io", now), false, "this replica's memory knows nothing");
    assert.equal(await loginLockedOutAsync("7.7.7.7", "B@x.io", now), true);
    assert.equal(await loginLockedOutAsync("7.7.7.7", "B@x.io", now + 60_001), false, "lock expired");
  });

  it("break-glass IPs skip only the per-account lock, in the shared store too", async () => {
    const store = fakeSharedStore();
    __setCounterStoreForTests(store);
    const now = 8_000_000;
    const prev = process.env.LOGIN_BREAK_GLASS_IPS;
    process.env.LOGIN_BREAK_GLASS_IPS = "8.8.8.8";
    try {
      store.lockouts.set("login:acct:c@x.io", { failures: 5, firstAt: now, lockedUntil: now + 60_000 });
      assert.equal(await loginLockedOutAsync("8.8.8.8", "c@x.io", now + 1), false);
      store.lockouts.set("login:ip:8.8.8.8", { failures: 20, firstAt: now, lockedUntil: now + 60_000 });
      assert.equal(await loginLockedOutAsync("8.8.8.8", "c@x.io", now + 1), true);
    } finally {
      if (prev === undefined) delete process.env.LOGIN_BREAK_GLASS_IPS;
      else process.env.LOGIN_BREAK_GLASS_IPS = prev;
    }
  });

  it("success clears both dimensions in both stores", async () => {
    const store = fakeSharedStore();
    __setCounterStoreForTests(store);
    const now = 9_000_000;
    for (let i = 0; i < 3; i++) await recordLoginFailureAsync("9.9.9.9", "d@x.io", now);
    await recordLoginSuccessAsync("9.9.9.9", "D@x.io");
    assert.deepEqual(store.cleared, [["login:ip:9.9.9.9", "login:acct:d@x.io"]]);
    assert.deepEqual(await loginFailureCountsAsync("9.9.9.9", "d@x.io", now), { ip: 0, account: 0 });
  });

  it("CAPTCHA step-up reads the shared counts, memory on failure", async () => {
    const TURNSTILE = env({ CAPTCHA_PROVIDER: "turnstile", CAPTCHA_SITE_KEY: "s", CAPTCHA_SECRET_KEY: "k" });
    const store = fakeSharedStore();
    __setCounterStoreForTests(store);
    const now = 10_000_000;
    store.lockouts.set("login:acct:e@x.io", { failures: 3, firstAt: now, lockedUntil: 0 });
    assert.equal(await captchaRequiredAsync("1.0.0.1", "e@x.io", { env: TURNSTILE, now }), true);
    assert.equal(await captchaRequiredAsync("1.0.0.1", "f@x.io", { env: TURNSTILE, now }), false);

    __setCounterStoreForTests(failingStore());
    for (let i = 0; i < 3; i++) await recordLoginFailureAsync("1.0.0.2", "g@x.io", now);
    assert.equal(await captchaRequiredAsync("1.0.0.2", "g@x.io", { env: TURNSTILE, now }), true);
  });
});
