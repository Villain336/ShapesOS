// Marketr — login brute-force limiter (day-1 hardening, H1/M8).
//
// Two INDEPENDENT dimensions (the old per-(IP,email) pair key was blind to
// both attack shapes below):
//   - per-IP across accounts: an attacker rotating usernames from one IP
//     trips this (20 failures / 1h → 15-minute lockout, doubling).
//   - per-account across IPs: an attacker rotating IPs against one account
//     trips this (5 failures / 1h → 15-minute lockout, doubling).
//
// In-memory and single-instance by design (documented); front with a shared
// rate limiter (Redis etc.) if you run replicas. Bounded maps (oldest UNLOCKED
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
//   - Restarting the app clears every lockout (the state is in-memory).
//   - LOGIN_BREAK_GLASS_IPS="203.0.113.7,…": sign-ins from these client IPs
//     (resolved via TRUSTED_PROXY_HOPS, so not spoofable through
//     X-Forwarded-For) skip the per-ACCOUNT lock, so the owner can get in
//     while someone keeps re-locking the account from elsewhere. The per-IP
//     dimension still applies to them.

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
  const ipRec = ipAttempts.get(ipKey(ip));
  if (ipRec && ipRec.lockedUntil > now) return true;
  if (ip && breakGlassIps().has(ip)) return false;
  const acctRec = accountAttempts.get(accountKey(email));
  return !!acctRec && acctRec.lockedUntil > now;
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
  const live = (rec: AttemptState | undefined): number =>
    rec && (now - rec.firstAt <= LOGIN_WINDOW_MS || rec.lockedUntil > now) ? rec.failures : 0;
  return { ip: live(ipAttempts.get(ipKey(ip))), account: live(accountAttempts.get(accountKey(email))) };
}

/**
 * Test hook: clear all limiter state. Fixtures call this for deterministic
 * brute-force tests (the limiter is time-based otherwise).
 */
export function __resetLoginAttempts(): void {
  ipAttempts.clear();
  accountAttempts.clear();
}
