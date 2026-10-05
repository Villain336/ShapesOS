// ShapesOS — Phase 6: the Postgres rate-limit store (rate_limit_buckets).
// Runs as the least-privilege app role (npm run test:db):
//   DATABASE_URL=<app-role url> npx tsx --test lib/api/__tests__/rate-limit-store-db.test.ts

import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { __setCounterStoreForTests, postgresCounterStore, type LockoutPolicy } from "../rate-limit-store";
import { checkRateLimitAsync, TIER_LIMITS } from "../rate-limit";
import {
  __resetLoginAttempts,
  LOGIN_ACCOUNT_MAX_FAILURES,
  LOGIN_BASE_LOCKOUT_MS,
  LOGIN_MAX_LOCKOUT_MS,
  LOGIN_WINDOW_MS,
  lockoutMs,
  loginLockedOutAsync,
  recordLoginFailureAsync,
  recordLoginSuccessAsync,
} from "../../auth/rate-limit";

const store = postgresCounterStore();
const RUN = randomUUID().slice(0, 8);
const k = (name: string) => `test-${RUN}:${name}`;

const POLICY: LockoutPolicy = {
  maxFailures: LOGIN_ACCOUNT_MAX_FAILURES,
  windowMs: LOGIN_WINDOW_MS,
  baseLockoutMs: LOGIN_BASE_LOCKOUT_MS,
  maxLockoutMs: LOGIN_MAX_LOCKOUT_MS,
};

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "rate_limit_buckets" WHERE "key" LIKE ${`test-${RUN}:%`} OR "key" LIKE ${`%${RUN}%`}`;
}

before(async () => {
  await cleanup();
});

after(async () => {
  __setCounterStoreForTests(undefined);
  await cleanup();
  await prisma.$disconnect();
});

describe("postgres fixed window (DB)", () => {
  it("concurrent increments in one window give an exact count", async () => {
    const now = 1_000_000_000_000;
    const N = 60;
    const hits = await Promise.all(Array.from({ length: N }, () => store.hit(k("burst"), 60_000, now)));
    const counts = hits.map((h) => h.count).sort((a, b) => a - b);
    assert.deepEqual(counts, Array.from({ length: N }, (_, i) => i + 1), "every hit got a distinct count 1..N");
    assert.ok(hits.every((h) => h.windowStart === now));
    const [row] = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT "count" FROM "rate_limit_buckets" WHERE "key" = ${k("burst")}`;
    assert.equal(row.count, N);
  });

  it("a new window resets the count", async () => {
    const t0 = 1_000_000_100_000;
    await store.hit(k("reset"), 60_000, t0);
    await store.hit(k("reset"), 60_000, t0 + 30_000);
    const third = await store.hit(k("reset"), 60_000, t0 + 59_999);
    assert.deepEqual(third, { count: 3, windowStart: t0 });
    const fresh = await store.hit(k("reset"), 60_000, t0 + 60_000);
    assert.deepEqual(fresh, { count: 1, windowStart: t0 + 60_000 });
  });

  it("checkRateLimitAsync enforces the tier limit through the table", async () => {
    __setCounterStoreForTests(store);
    const now = Date.now();
    let allowed = 0;
    const key = `auth:ip:${RUN}`;
    for (let i = 0; i < TIER_LIMITS.auth.limit + 3; i++) if ((await checkRateLimitAsync(key, "auth", now)).allowed) allowed++;
    assert.equal(allowed, TIER_LIMITS.auth.limit);
    const denied = await checkRateLimitAsync(key, "auth", now + 10_000);
    assert.equal(denied.allowed, false);
    assert.equal(denied.retryAfterMs, 50_000);
    __setCounterStoreForTests(undefined);
  });

  it("cleanup removes only expired rows", async () => {
    const t0 = 1_000_000_200_000;
    await store.hit(k("old"), 60_000, t0);
    await store.hit(k("live"), 60_000, t0 + 120_000);
    await store.cleanup(t0 + 61_000);
    const rows = await prisma.$queryRaw<Array<{ key: string }>>`
      SELECT "key" FROM "rate_limit_buckets" WHERE "key" IN (${k("old")}, ${k("live")})`;
    assert.deepEqual(rows.map((r) => r.key), [k("live")]);
  });
});

describe("postgres login lockout (DB)", () => {
  it("bumpLockout matches the in-memory doubling, capped backoff", async () => {
    const t0 = 1_000_000_300_000;
    let rec = { failures: 0, firstAt: 0, lockedUntil: 0 };
    for (let i = 1; i <= POLICY.maxFailures + 3; i++) {
      rec = await store.bumpLockout(k("acct"), POLICY, t0 + i);
      if (i < POLICY.maxFailures) assert.equal(rec.lockedUntil, 0, `no lock after ${i}`);
      else assert.equal(rec.lockedUntil, t0 + i + lockoutMs(i - POLICY.maxFailures), `lock after ${i}`);
    }
    assert.equal(rec.failures, POLICY.maxFailures + 3);
    assert.equal(rec.firstAt, t0 + 1);
    // Cap: far past the threshold the lock never exceeds LOGIN_MAX_LOCKOUT_MS.
    for (let i = 0; i < 30; i++) rec = await store.bumpLockout(k("acct"), POLICY, t0 + 100);
    assert.equal(rec.lockedUntil, t0 + 100 + LOGIN_MAX_LOCKOUT_MS);
  });

  it("concurrent failures are counted exactly", async () => {
    const now = 1_000_000_400_000;
    await Promise.all(Array.from({ length: 25 }, () => store.bumpLockout(k("conc"), POLICY, now)));
    const recs = await store.readLockouts([k("conc")]);
    assert.equal(recs.get(k("conc"))?.failures, 25);
  });

  it("a live lock is never reset by the window rolling over; an expired one is", async () => {
    const t0 = 1_000_000_500_000;
    for (let i = 0; i < POLICY.maxFailures; i++) await store.bumpLockout(k("roll"), POLICY, t0);
    // Window over, lock (15 min) still live? No — 1h window > 15 min lock, so
    // use a short-window policy to land inside "window over, lock live".
    const shortWindow = { ...POLICY, windowMs: 60_000 };
    const live = await store.bumpLockout(k("roll"), shortWindow, t0 + 120_000);
    assert.equal(live.failures, POLICY.maxFailures + 1, "kept counting under the live lock");
    assert.equal(live.firstAt, t0);
    const expiredAt = live.lockedUntil + 1;
    const reset = await store.bumpLockout(k("roll"), shortWindow, expiredAt);
    assert.deepEqual(reset, { failures: 1, firstAt: expiredAt, lockedUntil: 0 });
  });

  it("the async lockout API locks across 'replicas' via the table and clears on success", async () => {
    __setCounterStoreForTests(store);
    const ip = `ip-a-${RUN}`;
    const email = `owner-${RUN}@example.com`;
    const now = Date.now();
    for (let i = 0; i < LOGIN_ACCOUNT_MAX_FAILURES; i++) await recordLoginFailureAsync(ip, email, now);
    // Another replica: empty memory, same table.
    __resetLoginAttempts();
    assert.equal(await loginLockedOutAsync(`ip-b-${RUN}`, email, now + 1), true);
    await recordLoginSuccessAsync(ip, email);
    assert.equal(await loginLockedOutAsync(ip, email, now + 2), false);
    const left = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM "rate_limit_buckets" WHERE "key" IN (${`login:ip:${ip}`}, ${`login:acct:${email}`})`;
    assert.equal(Number(left[0].n), 0);
    __setCounterStoreForTests(undefined);
  });
});
