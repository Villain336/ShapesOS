// ShapesOS — Phase 1 (H9): login lockout is capped, can't be reset by
// flooding the tracker, and has a break-glass IP list.
// Run: npx tsx --test lib/auth/__tests__/rate-limit.test.ts

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  LOGIN_ACCOUNT_MAX_FAILURES,
  LOGIN_BASE_LOCKOUT_MS,
  LOGIN_IP_MAX_FAILURES,
  LOGIN_MAX_LOCKOUT_MS,
  LOGIN_MAX_TRACKED,
  __resetLoginAttempts,
  lockoutMs,
  loginLockedOut,
  recordLoginFailure,
} from "../rate-limit";

const ADMIN = "owner@example.com";
const T0 = 1_700_000_000_000;

describe("login lockout (H9)", () => {
  beforeEach(() => {
    __resetLoginAttempts();
    delete process.env.LOGIN_BREAK_GLASS_IPS;
  });
  afterEach(() => {
    __resetLoginAttempts();
    delete process.env.LOGIN_BREAK_GLASS_IPS;
  });

  it("backoff doubles from 15 min and is capped at 1 hour", () => {
    assert.equal(lockoutMs(0), LOGIN_BASE_LOCKOUT_MS);
    assert.equal(lockoutMs(1), 2 * LOGIN_BASE_LOCKOUT_MS);
    assert.equal(lockoutMs(2), LOGIN_MAX_LOCKOUT_MS);
    assert.equal(lockoutMs(35), LOGIN_MAX_LOCKOUT_MS);
    assert.equal(lockoutMs(10_000), LOGIN_MAX_LOCKOUT_MS);
    assert.equal(LOGIN_MAX_LOCKOUT_MS, 60 * 60 * 1000);
  });

  it("40 burst failures (live repro) lock the owner for at most 1 hour", () => {
    for (let i = 0; i < 40; i++) recordLoginFailure(`198.51.100.${i}`, ADMIN, T0);
    assert.equal(loginLockedOut("203.0.113.1", ADMIN, T0), true);
    assert.equal(loginLockedOut("203.0.113.1", ADMIN, T0 + LOGIN_MAX_LOCKOUT_MS - 1), true);
    assert.equal(loginLockedOut("203.0.113.1", ADMIN, T0 + LOGIN_MAX_LOCKOUT_MS + 1), false);
  });

  it("a live lock survives the failure window rolling over", () => {
    const min = 60 * 1000;
    // Window opens at T0; the lock lands at T0+59min (until T0+74min).
    recordLoginFailure("198.51.100.1", ADMIN, T0);
    for (let i = 1; i < LOGIN_ACCOUNT_MAX_FAILURES; i++) recordLoginFailure(`198.51.100.${i}`, ADMIN, T0 + 59 * min);
    // A failure recorded after the 1h window but while still locked (e.g. a
    // concurrent request) must not reset the record to unlocked.
    recordLoginFailure("198.51.100.99", ADMIN, T0 + 65 * min);
    assert.equal(loginLockedOut("203.0.113.1", ADMIN, T0 + 65 * min), true);
    assert.equal(loginLockedOut("203.0.113.1", ADMIN, T0 + 80 * min), true);
  });

  it("flooding the tracker with junk emails does not evict a locked account", () => {
    for (let i = 0; i < LOGIN_ACCOUNT_MAX_FAILURES; i++) recordLoginFailure(`198.51.100.${i}`, ADMIN, T0);
    assert.equal(loginLockedOut("203.0.113.1", ADMIN, T0), true);
    // One failure per junk email, spread over many IPs: > the 10k soft cap.
    for (let i = 0; i < LOGIN_MAX_TRACKED + 500; i++) {
      recordLoginFailure(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, `junk${i}@x.test`, T0 + 1);
    }
    assert.equal(loginLockedOut("203.0.113.1", ADMIN, T0 + 2), true);
  });

  it("per-IP dimension still locks a rotating-username attacker", () => {
    for (let i = 0; i < LOGIN_IP_MAX_FAILURES; i++) recordLoginFailure("203.0.113.9", `u${i}@x.test`, T0);
    assert.equal(loginLockedOut("203.0.113.9", "fresh@x.test", T0), true);
    assert.equal(loginLockedOut("203.0.113.10", "fresh@x.test", T0), false);
  });

  it("break-glass IPs skip the per-account lock, not the per-IP lock", () => {
    for (let i = 0; i < LOGIN_ACCOUNT_MAX_FAILURES; i++) recordLoginFailure(`198.51.100.${i}`, ADMIN, T0);
    process.env.LOGIN_BREAK_GLASS_IPS = "192.0.2.10, 192.0.2.11";
    assert.equal(loginLockedOut("192.0.2.10", ADMIN, T0), false);
    assert.equal(loginLockedOut("192.0.2.11", ADMIN, T0), false);
    assert.equal(loginLockedOut("192.0.2.12", ADMIN, T0), true);
    assert.equal(loginLockedOut(null, ADMIN, T0), true);
    for (let i = 0; i < LOGIN_IP_MAX_FAILURES; i++) recordLoginFailure("192.0.2.10", `x${i}@x.test`, T0);
    assert.equal(loginLockedOut("192.0.2.10", ADMIN, T0), true);
  });
});
