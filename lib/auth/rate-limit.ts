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
// rate limiter (Redis etc.) if you run replicas. Bounded maps (oldest entry
// evicted past 10k keys) so the tracker itself can't be used as a memory
// exhaustion vector.

export const LOGIN_IP_MAX_FAILURES = 20;
export const LOGIN_ACCOUNT_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MS = 60 * 60 * 1000;
export const LOGIN_BASE_LOCKOUT_MS = 15 * 60 * 1000;
const MAX_TRACKED = 10_000;

interface AttemptState {
  failures: number;
  firstAt: number;
  lockedUntil: number;
}

function bump(
  map: Map<string, AttemptState>,
  key: string,
  maxFailures: number,
  now: number,
): void {
  let rec = map.get(key);
  if (!rec || now - rec.firstAt > LOGIN_WINDOW_MS) {
    rec = { failures: 0, firstAt: now, lockedUntil: 0 };
  }
  rec.failures += 1;
  if (rec.failures >= maxFailures) {
    rec.lockedUntil = now + LOGIN_BASE_LOCKOUT_MS * 2 ** (rec.failures - maxFailures);
  }
  if (map.size >= MAX_TRACKED && !map.has(key)) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest) map.delete(oldest);
  }
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

/** Record a failed login against both dimensions. */
export function recordLoginFailure(ip: string | null, email: string): void {
  const now = Date.now();
  bump(ipAttempts, ipKey(ip), LOGIN_IP_MAX_FAILURES, now);
  bump(accountAttempts, accountKey(email), LOGIN_ACCOUNT_MAX_FAILURES, now);
}

/** A successful login clears both dimensions for that IP + account. */
export function recordLoginSuccess(ip: string | null, email: string): void {
  ipAttempts.delete(ipKey(ip));
  accountAttempts.delete(accountKey(email));
}

/** True when either dimension is currently locked out. */
export function loginLockedOut(ip: string | null, email: string): boolean {
  const now = Date.now();
  const ipRec = ipAttempts.get(ipKey(ip));
  if (ipRec && ipRec.lockedUntil > now) return true;
  const acctRec = accountAttempts.get(accountKey(email));
  return !!acctRec && acctRec.lockedUntil > now;
}

/**
 * Test hook: clear all limiter state. Fixtures call this for deterministic
 * brute-force tests (the limiter is time-based otherwise).
 */
export function __resetLoginAttempts(): void {
  ipAttempts.clear();
  accountAttempts.clear();
}
