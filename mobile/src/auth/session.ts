// ShapesOS mobile — auth via the web app's OWN session mechanism.
//
// Every API route authenticates through `requireUser()` → Auth.js v5
// (`auth()`), which reads the session JWT cookie (12h absolute lifetime — see
// auth.ts). There is deliberately NO separate mobile auth: the app signs in
// through the same Auth.js credentials endpoints and presents the same cookie
// the web app would.
//
// React Native has no browser cookie jar the app can rely on, so cookies are
// handled explicitly (every auth fetch passes credentials: "omit" so the
// native jar never interferes):
//
//   1. GET  {base}/api/auth/csrf → { csrfToken } + Set-Cookie: authjs.csrf-token
//      (Auth.js double-submit CSRF: the credentials POST must carry BOTH the
//      body token and this cookie, or Auth.js answers MissingCSRF).
//   2. POST {base}/api/auth/callback/credentials (form: csrfToken, email,
//      password, callbackUrl) with `X-Auth-Return-Redirect: 1`, so Auth.js
//      answers JSON { url } instead of a 302, plus Set-Cookie: the session.
//      A failed sign-in answers { url: "…?error=CredentialsSignin&code=…" }.
//   3. GET  {base}/api/auth/session with that cookie:
//        { user, expires }                         → fully signed in
//        { expires, mfa: { pending, methods } }    → Phase 4a second factor due
//      A pending session is NOT signed in (the server exposes no user), it
//      just proves the password step passed for the next 10 minutes.
//   4. Second factor: POST {base}/api/auth/callback/two-factor (form:
//      csrfToken, code) with the CSRF cookie and the pending session cookie.
//      The code is a 6-digit TOTP code or a recovery code (the server tells
//      them apart). Success re-issues the session cookie as a full session.
//
// Cookie names: `authjs.session-token` over http, `__Secure-authjs.session-token`
// over https, and a large JWT may be chunked (`….0`, `….1`). The app keeps the
// exact cookie names the server set and sends them back verbatim — sending the
// http name to an https server would read as signed out.
// Rate limiting, lockout and audit are the server's (lib/auth/rate-limit.ts).

import { MemoryTokenStore, createSecureTokenStore, type TokenStore } from "./token-store";

export class AuthError extends Error {
  /** Auth.js error code when the server gave one ("credentials", "locked", "captcha_required"…). */
  readonly code: string | null;
  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

export type LoginResult = { status: "signed_in" } | { status: "two_factor"; methods: string[] };

export interface CookiePair {
  name: string;
  value: string;
}

const SESSION_NAMES = ["authjs.session-token", "__Secure-authjs.session-token"];
const CSRF_NAMES = ["authjs.csrf-token", "__Host-authjs.csrf-token"];

/** Every name=value pair in one or more Set-Cookie header values. */
export function parseSetCookies(setCookie: string | string[] | null | undefined): CookiePair[] {
  if (!setCookie) return [];
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
  const out: CookiePair[] = [];
  for (const header of headers) {
    // Joined headers ("a=1; Path=/, b=2; Path=/") split on a comma that starts
    // a new name=value pair — an Expires date's comma is not followed by one.
    for (const seg of String(header).split(/,(?=[^;,]+=)/)) {
      const pair = seg.split(";")[0]?.trim() ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      out.push({ name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() });
    }
  }
  return out;
}

function isSessionName(name: string): boolean {
  return SESSION_NAMES.some((n) => name === n || new RegExp(`^${n.replace(/[.]/g, "\\.")}\\.\\d+$`).test(name));
}

/** The session cookie(s) a response set (several when Auth.js chunked the JWT). */
export function sessionCookiePairs(setCookie: string | string[] | null | undefined): CookiePair[] {
  return parseSetCookies(setCookie).filter((c) => isSessionName(c.name) && c.value);
}

/** Back-compat helper: the (first) session cookie value, or null. */
export function parseSessionCookie(setCookie: string | string[] | null | undefined): string | null {
  const first = sessionCookiePairs(setCookie)[0];
  return first ? decodeURIComponent(first.value) : null;
}

export function csrfCookiePair(setCookie: string | string[] | null | undefined): CookiePair | null {
  return parseSetCookies(setCookie).find((c) => CSRF_NAMES.includes(c.name) && c.value) ?? null;
}

export function cookieString(pairs: CookiePair[]): string {
  return pairs.map((p) => `${p.name}=${p.value}`).join("; ");
}

/**
 * The Cookie header for a stored session. Stored values are a cookie string
 * ("name=value[; name.1=value]"); a bare token from older app versions is
 * sent under the http cookie name.
 */
export function buildCookieHeader(stored: string): Record<string, string> {
  return { Cookie: stored.includes("=") ? stored : `authjs.session-token=${stored}` };
}

function readSetCookie(res: Response): string | string[] | null {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  const list = typeof h.getSetCookie === "function" ? h.getSetCookie() : [];
  return list.length ? list : h.get("set-cookie");
}

function authErrorFrom(url: string | undefined, fallback: string): AuthError {
  const err = /[?&]error=([^&]+)/.exec(url ?? "")?.[1];
  const code = /[?&]code=([^&]+)/.exec(url ?? "")?.[1];
  const c = code ? decodeURIComponent(code) : null;
  if (c === "locked") return new AuthError("Too many attempts. Wait a few minutes and try again.", c);
  if (c === "captcha_required") {
    return new AuthError("Too many failed sign-ins. Sign in once on the web to pass the check, then try again.", c);
  }
  if (err) return new AuthError(fallback, c ?? decodeURIComponent(err));
  return new AuthError(fallback, c);
}

interface SessionJson {
  user?: { id?: string; email?: string | null } | null;
  mfa?: { pending?: boolean; methods?: string[] } | null;
}

/** Second-factor methods the app can complete (passkeys need the web). */
export const MOBILE_SECOND_FACTORS = ["totp"];

interface PendingSignIn {
  baseUrl: string;
  cookies: CookiePair[];
  csrfCookie: CookiePair;
  csrfToken: string;
  methods: string[];
}

export class SessionManager {
  private store: TokenStore;
  private token: string | null = null;
  private loaded = false;
  private pending: PendingSignIn | null = null;
  private fetchImpl: typeof fetch;

  constructor(store?: TokenStore, fetchImpl?: typeof fetch) {
    this.store = store ?? createSecureTokenStore();
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** Load any persisted session (call once at startup). */
  async restore(): Promise<boolean> {
    this.token = await this.store.get();
    this.loaded = true;
    return this.token !== null;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  get isSignedIn(): boolean {
    return this.token !== null;
  }

  /** Methods for the pending second-factor step, or null when none is due. */
  get pendingTwoFactor(): { methods: string[] } | null {
    return this.pending ? { methods: [...this.pending.methods] } : null;
  }

  private async csrf(baseUrl: string): Promise<{ token: string; cookie: CookiePair }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${baseUrl}/api/auth/csrf`, {
        headers: { accept: "application/json" },
        credentials: "omit",
      });
    } catch {
      throw new AuthError("Couldn't reach the server. Check the server address and your connection.");
    }
    if (!res.ok) throw new AuthError(`The server answered ${res.status} to the sign-in check.`);
    const { csrfToken } = (await res.json().catch(() => ({}))) as { csrfToken?: string };
    const cookie = csrfCookiePair(readSetCookie(res));
    if (!csrfToken || !cookie) throw new AuthError("The server didn't start a sign-in. Is this a ShapesOS server?");
    return { token: csrfToken, cookie };
  }

  private async post(
    baseUrl: string,
    provider: string,
    fields: Record<string, string>,
    cookies: CookiePair[],
  ): Promise<{ res: Response; url: string | undefined }> {
    const form = new URLSearchParams(fields);
    let res: Response;
    try {
      res = await this.fetchImpl(`${baseUrl}/api/auth/callback/${provider}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          "x-auth-return-redirect": "1",
          cookie: cookieString(cookies),
        },
        body: form.toString(),
        credentials: "omit",
        redirect: "manual",
      });
    } catch {
      throw new AuthError("Couldn't reach the server. Check the server address and your connection.");
    }
    const body = (await res.json().catch(() => ({}))) as { url?: string };
    return { res, url: body?.url };
  }

  private async sessionState(baseUrl: string, cookies: CookiePair[]): Promise<SessionJson> {
    const res = await this.fetchImpl(`${baseUrl}/api/auth/session`, {
      headers: { accept: "application/json", cookie: cookieString(cookies) },
      credentials: "omit",
    });
    if (!res.ok) throw new AuthError(`The server answered ${res.status} while signing in.`);
    return ((await res.json().catch(() => null)) ?? {}) as SessionJson;
  }

  private async persist(cookies: CookiePair[]): Promise<void> {
    const value = cookieString(cookies);
    this.token = value;
    this.loaded = true;
    this.pending = null;
    await this.store.set(value);
  }

  /** Step 1: email + password through the existing Credentials provider. */
  async login(baseUrl: string, email: string, password: string): Promise<LoginResult> {
    this.pending = null;
    const csrf = await this.csrf(baseUrl);
    const { res, url } = await this.post(
      baseUrl,
      "credentials",
      { csrfToken: csrf.token, email: email.trim(), password, callbackUrl: `${baseUrl}/dashboard` },
      [csrf.cookie],
    );
    const cookies = sessionCookiePairs(readSetCookie(res));
    if (cookies.length === 0 || /[?&]error=/.test(url ?? "")) {
      throw authErrorFrom(url, "Wrong email or password.");
    }
    const state = await this.sessionState(baseUrl, cookies);
    if (state.user?.id) {
      await this.persist(cookies);
      return { status: "signed_in" };
    }
    if (state.mfa?.pending) {
      const methods = Array.isArray(state.mfa.methods) ? state.mfa.methods : [];
      if (!methods.some((m) => MOBILE_SECOND_FACTORS.includes(m))) {
        throw new AuthError("This account signs in with a passkey. Use the ShapesOS web app, or add an authenticator app in your security settings.", "passkey_only");
      }
      this.pending = { baseUrl, cookies, csrfCookie: csrf.cookie, csrfToken: csrf.token, methods };
      return { status: "two_factor", methods };
    }
    throw new AuthError("Sign-in didn't complete. Try again.");
  }

  /** Step 2 (when login() returned two_factor): a TOTP code or a recovery code. */
  async completeTwoFactor(code: string): Promise<void> {
    const p = this.pending;
    if (!p) throw new AuthError("Your sign-in expired. Sign in again.", "expired");
    const clean = code.trim();
    if (!clean) throw new AuthError("Enter the code from your authenticator app or a recovery code.");
    const { res, url } = await this.post(
      p.baseUrl,
      "two-factor",
      { csrfToken: p.csrfToken, code: clean, callbackUrl: `${p.baseUrl}/dashboard` },
      [p.csrfCookie, ...p.cookies],
    );
    if (/[?&]error=/.test(url ?? "")) throw authErrorFrom(url, "That code didn't work. Check it and try again.");
    const cookies = sessionCookiePairs(readSetCookie(res));
    if (cookies.length === 0) throw new AuthError("That code didn't work. Check it and try again.");
    const state = await this.sessionState(p.baseUrl, cookies);
    if (!state.user?.id) {
      if (!state.mfa?.pending) {
        this.pending = null;
        throw new AuthError("Your sign-in expired. Sign in again.", "expired");
      }
      throw new AuthError("That code didn't work. Check it and try again.");
    }
    await this.persist(cookies);
  }

  /** Abandon a pending second-factor step. */
  cancelTwoFactor(): void {
    this.pending = null;
  }

  async logout(): Promise<void> {
    this.token = null;
    this.pending = null;
    await this.store.clear();
  }

  /** Headers to attach to every backend call — the web app's session cookie. */
  authHeaders(): Record<string, string> {
    if (!this.token) throw new AuthError("auth: not signed in");
    return buildCookieHeader(this.token);
  }

  /** Test seam: inject a token without touching the store. */
  setTokenForTests(token: string): void {
    this.token = token;
    this.loaded = true;
  }

  static withMemoryStore(fetchImpl?: typeof fetch): SessionManager {
    return new SessionManager(new MemoryTokenStore(), fetchImpl);
  }
}
