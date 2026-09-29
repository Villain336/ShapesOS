// Marketr mobile — auth via the web app's OWN session mechanism.
//
// /api/agents/chat, the autopilot gate routes, and /api/missions all
// authenticate through `requireUser()` → NextAuth v5 (`auth()`), which reads
// the session from the `authjs.session-token` cookie (JWT, httpOnly, 12h
// absolute lifetime — see auth.ts). There is deliberately NO new mobile auth
// infrastructure: the app signs in through the existing Credentials provider
// endpoint and then presents the same cookie the web app would.
//
// Flow (standard Auth.js, no server changes):
//   1. GET  {base}/api/auth/csrf                    → { csrfToken }
//   2. POST {base}/api/auth/callback/credentials    (form body, json=true)
//      with { csrfToken, email, password, callbackUrl, json }
//      → 200 {"url": ...} + Set-Cookie: authjs.session-token=<jwt>
//        401 {"url": "...?error=CredentialsSignin"} on bad credentials
//   3. The cookie value is persisted (token-store.ts) and sent back as a
//      `Cookie` header on every subsequent API call.
//
// Cookie name: `authjs.session-token` over http, `__Secure-authjs.session-token`
// over https (Auth.js prefixes secure cookies). Both are accepted.
// Rate limiting, lockout, and audit on the credentials endpoint are the
// server's existing lib/auth/rate-limit.ts behavior — unchanged.

import { MemoryTokenStore, createSecureTokenStore, type TokenStore } from "./token-store";

export class AuthError extends Error {}

/** Pull the session-token cookie value out of a Set-Cookie header value. */
export function parseSessionCookie(setCookie: string | string[] | null | undefined): string | null {
  if (!setCookie) return null;
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const header of headers) {
    // A Set-Cookie header can carry several cookies comma-joined only when
    // the server joins them; Auth.js sends one header per cookie. Split on
    // the first ";" of each cookie segment and match the name.
    const segments = String(header).split(/,(?=[^;]+=)/);
    for (const seg of segments) {
      const pair = seg.split(";")[0]?.trim() ?? "";
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (
        (name === "authjs.session-token" || name === "__Secure-authjs.session-token") &&
        value
      ) {
        return decodeURIComponent(value);
      }
    }
  }
  return null;
}

export function buildCookieHeader(sessionToken: string): Record<string, string> {
  return { Cookie: `authjs.session-token=${sessionToken}` };
}

export class SessionManager {
  private store: TokenStore;
  private token: string | null = null;
  private loaded = false;

  constructor(store?: TokenStore) {
    this.store = store ?? createSecureTokenStore();
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

  /** Sign in with email + password through the existing Credentials provider. */
  async login(baseUrl: string, email: string, password: string): Promise<void> {
    const csrfRes = await fetch(`${baseUrl}/api/auth/csrf`, {
      headers: { accept: "application/json" },
    });
    if (!csrfRes.ok) throw new AuthError(`auth: csrf request failed (${csrfRes.status})`);
    const { csrfToken } = (await csrfRes.json()) as { csrfToken?: string };
    if (!csrfToken) throw new AuthError("auth: no csrf token issued");

    const form = new URLSearchParams();
    form.set("csrfToken", csrfToken);
    form.set("email", email.trim());
    form.set("password", password);
    form.set("callbackUrl", `${baseUrl}/`);
    form.set("json", "true");

    const res = await fetch(`${baseUrl}/api/auth/callback/credentials`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      // React Native fetch does not follow the Set-Cookie contract of a
      // browser; read it manually instead.
    });
    // Auth.js json mode: 200 + {"url"} on success, 401 + {"url": "...error=…"}
    // on bad credentials. Either way the session cookie arrives via Set-Cookie.
    const rawSetCookie =
      res.headers.get("set-cookie") ?? (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? null;
    const token = parseSessionCookie(rawSetCookie);
    if (!token) {
      let detail = "invalid email or password";
      try {
        const body = (await res.json()) as { url?: string };
        const m = /[?&]error=([^&]+)/.exec(body?.url ?? "");
        if (m?.[1]) detail = decodeURIComponent(m[1]);
      } catch {
        // keep the generic detail
      }
      throw new AuthError(`auth: sign-in failed (${detail})`);
    }
    this.token = token;
    this.loaded = true;
    await this.store.set(token);
  }

  async logout(): Promise<void> {
    this.token = null;
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

  static withMemoryStore(): SessionManager {
    return new SessionManager(new MemoryTokenStore());
  }
}
