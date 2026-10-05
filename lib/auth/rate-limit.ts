// Marketr — login brute-force limiter (day-1 hardening, H1/M8).
//
// Two INDEPENDENT dimensions (the old per-(IP,email) pair key was blind to
// both attack shapes below):
//   - per-IP across accounts: an attacker rotating usernames from one IP
//     trips this (20 failures / 1h → 15-minute lockout, doubling).
//   - per-account across IPs: an attacker rotating IPs against one account
//     trips this (5 failures / 1h → 15-minute lockout, doubling).
//
// Phase 6: the *Async variants (what auth.ts and the MFA paths call) keep the
// lockout in the shared Postgres table (lib/api/rate-limit-store.ts,
// RATE_LIMIT_STORE) so it holds across replicas. The in-memory maps below are
// ALWAYS written too and are the fallback: if the shared store errors or
// times out, the in-memory lockout decides. The lockout never fails open.
// The sync functions are the in-memory lockout alone (per process; scripts,
// tests, RATE_LIMIT_STORE=memory). Bounded maps (oldest UNLOCKED
// entry evicted past 10k keys) so the tracker itself can't be used as a memory
// exhaustion vector — and flooding it with junk emails can't evict (= reset)
// a locked account. When every tracked key is locked the map grows past the
// soft cap; locks expire within LOGIN_MAX_LOCKOUT_MS, so that is bounded.
//
// Phase 1 (H9): the doubling backoff is capped at 1 hour. Uncapped, a burst
// of concurrent failures (they all pass the lockout check before any is
// recorded) pushed the owner's lockout out to years — a permanent admin DoS.
//
// Break-glass (also documented in .env.example):
//   - Restarting the app clears the in-memory lockouts. With the shared store,
//     clear a lockout with: DELETE FROM rate_limit_buckets WHERE key LIKE 'login:%';
//   - LOGIN_BREAK_GLASS_IPS="203.0.113.7,…": sign-ins from these client IPs
//     (resolved via TRUSTED_PROXY_HOPS, so not spoofable through
//     X-Forwarded-For) skip the per-ACCOUNT lock, so the owner can get in
//     while someone keeps re-locking the account from elsewhere. The per-IP
//     dimension still applies to them.

import {
  maybeCleanup,
  sharedCounterStore,
  storeWarn,
  withStoreTimeout,
  type LockoutPolicy,
} from "../api/rate-limit-store";

export const LOGIN_IP_MAX_FAILURES = 20;
export const LOGIN_ACCOUNT_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MS = 60 * 60 * 1000;
export const LOGIN_BASE_LOCKOUT_MS = 15 * 60 * 1000;
/** Ceiling on the doubling backoff (H9): never a permanent lockout. */
export const LOGIN_MAX_LOCKOUT_MS = 60 * 60 * 1000;
export const LOGIN_MAX_TRACKED = 10_000;

interface AttemptState {
  failures: number;
  firstAt: number;
  lockedUntil: number;
}

/** 15 min × 2^overLimit, capped at LOGIN_MAX_LOCKOUT_MS. */
export function lockoutMs(overLimit: number): number {
  // Clamp the exponent first so a huge failure count can't reach Infinity.
  const n = Math.min(Math.max(0, overLimit), 16);
  return Math.min(LOGIN_BASE_LOCKOUT_MS * 2 ** n, LOGIN_MAX_LOCKOUT_MS);
}

/** Evict the oldest entry that is NOT currently locked (none → evict nothing). */
function evictOneUnlocked(map: Map<string, AttemptState>, now: number): void {
  for (const [k, v] of map) {
    if (v.lockedUntil <= now) {
      map.delete(k);
      return;
    }
  }
}

function bump(
  map: Map<string, AttemptState>,
  key: string,
  maxFailures: number,
  now: number,
): void {
  let rec = map.get(key);
  // A live lock is never reset by the window rolling over.
  if (!rec || (now - rec.firstAt > LOGIN_WINDOW_MS && rec.lockedUntil <= now)) {
    rec = { failures: 0, firstAt: now, lockedUntil: 0 };
  }
  rec.failures += 1;
  if (rec.failures >= maxFailures) {
    rec.lockedUntil = now + lockoutMs(rec.failures - maxFailures);
  }
  if (map.size >= LOGIN_MAX_TRACKED && !map.has(key)) evictOneUnlocked(map, now);
  map.set(key, rec);
}

const ipAttempts = new Map<string, AttemptState>();
const accountAttempts = new Map<string, AttemptState>();

function ipKey(ip: string | null): string {
  return ip ?? "no-ip";
}

function accountKey(email: string): string {
  return email.trim().toLowerCase() || "unknown";
}

/** LOGIN_BREAK_GLASS_IPS as a set (comma- or space-separated). */
function breakGlassIps(): Set<string> {
  return new Set(
    (process.env.LOGIN_BREAK_GLASS_IPS ?? "")
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Record a failed login against both dimensions. */
export function recordLoginFailure(ip: string | null, email: string, now: number = Date.now()): void {
  bump(ipAttempts, ipKey(ip), LOGIN_IP_MAX_FAILURES, now);
  bump(accountAttempts, accountKey(email), LOGIN_ACCOUNT_MAX_FAILURES, now);
}

/** A successful login clears both dimensions for that IP + account. */
export function recordLoginSuccess(ip: string | null, email: string): void {
  ipAttempts.delete(ipKey(ip));
  accountAttempts.delete(accountKey(email));
}

/**
 * True when either dimension is currently locked out. A break-glass IP
 * (LOGIN_BREAK_GLASS_IPS) is exempt from the per-account lock only.
 */
export function loginLockedOut(ip: string | null, email: string, now: number = Date.now()): boolean {
  return lockedFrom(ipAttempts.get(ipKey(ip)), accountAttempts.get(accountKey(email)), ip, now);
}

/** The lock decision for one IP record + one account record (both stores). */
function lockedFrom(
  ipRec: AttemptState | undefined,
  acctRec: AttemptState | undefined,
  ip: string | null,
  now: number,
): boolean {
  if (ipRec && ipRec.lockedUntil > now) return true;
  if (ip && breakGlassIps().has(ip)) return false;
  return !!acctRec && acctRec.lockedUntil > now;
}

/** Failures that still count: inside the window, or while the lock holds. */
function liveFailures(rec: AttemptState | undefined, now: number): number {
  return rec && (now - rec.firstAt <= LOGIN_WINDOW_MS || rec.lockedUntil > now) ? rec.failures : 0;
}

/**
 * Phase 4a step-up: failures recorded in the current window for this IP and
 * account (a locked or expired record counts as its live failures only while
 * its window or lock is still running). lib/auth/captcha.ts asks for a
 * CAPTCHA once either reaches LOGIN_CAPTCHA_AFTER_FAILURES.
 */
export function loginFailureCounts(
  ip: string | null,
  email: string,
  now: number = Date.now(),
): { ip: number; account: number } {
  return {
    ip: liveFailures(ipAttempts.get(ipKey(ip)), now),
    account: liveFailures(accountAttempts.get(accountKey(email)), now),
  };
}

// ---------------------------------------------------------------------------
// Shared (multi-replica) lockout — Phase 6. Same two dimensions, thresholds
// and doubling/capped backoff, kept in rate_limit_buckets under
// "login:ip:<ip>" and "login:acct:<email-or-factor-key>".
// ---------------------------------------------------------------------------

const IP_POLICY: LockoutPolicy = {
  maxFailures: LOGIN_IP_MAX_FAILURES,
  windowMs: LOGIN_WINDOW_MS,
  baseLockoutMs: LOGIN_BASE_LOCKOUT_MS,
  maxLockoutMs: LOGIN_MAX_LOCKOUT_MS,
};
const ACCOUNT_POLICY: LockoutPolicy = { ...IP_POLICY, maxFailures: LOGIN_ACCOUNT_MAX_FAILURES };

function sharedKeys(ip: string | null, email: string): { ip: string; account: string } {
  return { ip: `login:ip:${ipKey(ip)}`, account: `login:acct:${accountKey(email)}` };
}

/** Record a failed login: in memory always (the fallback), and in the shared store. */
export async function recordLoginFailureAsync(
  ip: string | null,
  email: string,
  now: number = Date.now(),
): Promise<void> {
  recordLoginFailure(ip, email, now);
  const store = sharedCounterStore();
  if (!store) return;
  const keys = sharedKeys(ip, email);
  try {
    await withStoreTimeout(
      Promise.all([store.bumpLockout(keys.ip, IP_POLICY, now), store.bumpLockout(keys.account, ACCOUNT_POLICY, now)]),
    );
    maybeCleanup(store, now);
  } catch (err) {
    storeWarn("login failure", err);
  }
}

/** A successful login clears both dimensions in both stores. */
export async function recordLoginSuccessAsync(ip: string | null, email: string): Promise<void> {
  recordLoginSuccess(ip, email);
  const store = sharedCounterStore();
  if (!store) return;
  const keys = sharedKeys(ip, email);
  try {
    await withStoreTimeout(store.clear([keys.ip, keys.account]));
  } catch (err) {
    storeWarn("login success", err);
  }
}

/**
 * Locked out? The shared store decides when it answers; if it errors or
 * times out, the in-memory lockout decides (NEVER fail open).
 */
export async function loginLockedOutAsync(
  ip: string | null,
  email: string,
  now: number = Date.now(),
): Promise<boolean> {
  const store = sharedCounterStore();
  if (!store) return loginLockedOut(ip, email, now);
  const keys = sharedKeys(ip, email);
  try {
    const recs = await withStoreTimeout(store.readLockouts([keys.ip, keys.account]));
    return lockedFrom(recs.get(keys.ip), recs.get(keys.account), ip, now);
  } catch (err) {
    storeWarn("login lockout check", err);
    return loginLockedOut(ip, email, now);
  }
}

/** Failure counts for the CAPTCHA step-up, shared store first, memory on failure. */
export async function loginFailureCountsAsync(
  ip: string | null,
  email: string,
  now: number = Date.now(),
): Promise<{ ip: number; account: number }> {
  const store = sharedCounterStore();
  if (!store) return loginFailureCounts(ip, email, now);
  const keys = sharedKeys(ip, email);
  try {
    const recs = await withStoreTimeout(store.readLockouts([keys.ip, keys.account]));
    return { ip: liveFailures(recs.get(keys.ip), now), account: liveFailures(recs.get(keys.account), now) };
  } catch (err) {
    storeWarn("login failure counts", err);
    return loginFailureCounts(ip, email, now);
  }
}

/**
 * Test hook: clear all limiter state. Fixtures call this for deterministic
 * brute-force tests (the limiter is time-based otherwise).
 */
export function __resetLoginAttempts(): void {
  ipAttempts.clear();
  accountAttempts.clear();
}
