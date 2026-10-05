// ShapesOS mobile — sign-in against the Auth.js endpoints, incl. the Phase 4a
// second factor. fetch is mocked with the server's documented behavior:
//   - /api/auth/csrf sets the double-submit CSRF cookie
//   - credentials / two-factor callbacks need that cookie + X-Auth-Return-Redirect
//   - /api/auth/session tells a full session from a pending one
import { describe, expect, it } from "vitest";
import { AuthError, SessionManager, csrfCookiePair, parseSetCookies, sessionCookiePairs } from "../src/auth/session";
import { MemoryTokenStore } from "../src/auth/token-store";

const BASE = "https://shapes.example.com";

interface FakeServer {
  secure?: boolean;
  /** "none" | "totp" | "passkey" second factor on the account. */
  factor?: "none" | "totp" | "passkey";
  validCode?: string;
  lockAfter?: number;
  chunked?: boolean;
}

function fakeServer(opts: FakeServer = {}) {
  const sessionName = opts.secure ? "__Secure-authjs.session-token" : "authjs.session-token";
  const csrfName = opts.secure ? "__Host-authjs.csrf-token" : "authjs.csrf-token";
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let failures = 0;
  const sessions = new Map<string, "full" | "pending">();
  let n = 0;

  const cookiesOf = (init: RequestInit | undefined): Record<string, string> => {
    const raw = ((init?.headers ?? {}) as Record<string, string>).cookie ?? "";
    return Object.fromEntries(
      raw
        .split(";")
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]),
    );
  };
  const sessionOf = (c: Record<string, string>) =>
    c[sessionName] ?? (c[`${sessionName}.0`] ? `${c[`${sessionName}.0`]}${c[`${sessionName}.1`] ?? ""}` : undefined);

  const issue = (state: "full" | "pending") => {
    const token = `jwt${++n}${state}`;
    sessions.set(token, state);
    const headers = new Headers({ "content-type": "application/json" });
    if (opts.chunked) {
      headers.append("set-cookie", `${sessionName}.0=${token.slice(0, 3)}; Path=/; HttpOnly; Secure`);
      headers.append("set-cookie", `${sessionName}.1=${token.slice(3)}; Path=/; HttpOnly; Secure`);
    } else {
      headers.append("set-cookie", `${sessionName}=${token}; Path=/; HttpOnly; Expires=Thu, 01 Jan 2099 00:00:00 GMT`);
    }
    return headers;
  };

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const path = url.slice(BASE.length);
    const cookies = cookiesOf(init);
    if (path === "/api/auth/csrf") {
      const headers = new Headers({ "content-type": "application/json" });
      headers.append("set-cookie", `${csrfName}=csrf123%7Chash; Path=/; HttpOnly; SameSite=Lax`);
      return new Response(JSON.stringify({ csrfToken: "csrf123" }), { status: 200, headers });
    }
    if (path === "/api/auth/session") {
      const state = sessions.get(sessionOf(cookies) ?? "");
      if (state === "full") return Response.json({ user: { id: "u1", email: "a@b.c" }, expires: "x" });
      if (state === "pending") return Response.json({ expires: "x", mfa: { pending: true, methods: [opts.factor === "passkey" ? "passkey" : "totp"] } });
      return Response.json(null);
    }
    const form = new URLSearchParams(String(init?.body ?? ""));
    const json = ((init?.headers ?? {}) as Record<string, string>)["x-auth-return-redirect"] === "1";
    if (!json) return new Response(null, { status: 302, headers: { location: `${BASE}/dashboard` } });
    if (cookies[csrfName] !== "csrf123%7Chash" || form.get("csrfToken") !== "csrf123") {
      return Response.json({ url: `${BASE}/login?error=MissingCSRF` });
    }
    if (path === "/api/auth/callback/credentials") {
      if (form.get("email") !== "a@b.c" || form.get("password") !== "pw") {
        return Response.json({ url: `${BASE}/login?error=CredentialsSignin&code=credentials` });
      }
      return new Response(JSON.stringify({ url: `${BASE}/dashboard` }), {
        status: 200,
        headers: issue(!opts.factor || opts.factor === "none" ? "full" : "pending"),
      });
    }
    if (path === "/api/auth/callback/two-factor") {
      if (sessions.get(sessionOf(cookies) ?? "") !== "pending") return Response.json({ url: `${BASE}/login?error=CredentialsSignin&code=credentials` });
      if (opts.lockAfter !== undefined && failures >= opts.lockAfter) {
        return Response.json({ url: `${BASE}/login?error=CredentialsSignin&code=locked` });
      }
      if (form.get("code") !== (opts.validCode ?? "123456")) {
        failures++;
        return Response.json({ url: `${BASE}/login?error=CredentialsSignin&code=credentials` });
      }
      return new Response(JSON.stringify({ url: `${BASE}/dashboard` }), { status: 200, headers: issue("full") });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return { fetchImpl, calls, sessionName };
}

describe("cookie parsing", () => {
  it("handles joined Set-Cookie headers with Expires commas", () => {
    const joined = "a=1; Path=/; Expires=Thu, 01 Jan 2099 00:00:00 GMT, authjs.session-token=tok; Path=/";
    expect(parseSetCookies(joined).map((c) => c.name)).toEqual(["a", "authjs.session-token"]);
    expect(sessionCookiePairs(joined)).toEqual([{ name: "authjs.session-token", value: "tok" }]);
  });
  it("finds chunked session cookies and the https CSRF cookie", () => {
    const list = ["__Secure-authjs.session-token.0=ab; Path=/", "__Secure-authjs.session-token.1=cd; Path=/", "__Host-authjs.csrf-token=x%7Cy; Path=/"];
    expect(sessionCookiePairs(list).map((c) => c.name)).toEqual(["__Secure-authjs.session-token.0", "__Secure-authjs.session-token.1"]);
    expect(csrfCookiePair(list)).toEqual({ name: "__Host-authjs.csrf-token", value: "x%7Cy" });
  });
});

describe("password sign-in", () => {
  it("signs in an account without a second factor, sending the CSRF cookie and JSON-redirect header", async () => {
    const srv = fakeServer();
    const store = new MemoryTokenStore();
    const mgr = new SessionManager(store, srv.fetchImpl);
    expect(await mgr.login(BASE, " a@b.c ", "pw")).toEqual({ status: "signed_in" });
    expect(mgr.isSignedIn).toBe(true);
    expect(await store.get()).toMatch(/^authjs\.session-token=jwt\d+full$/);
    const post = srv.calls.find((c) => c.url.endsWith("/callback/credentials"))!;
    expect(post.init?.credentials).toBe("omit");
    expect(post.init?.redirect).toBe("manual");
    expect((post.init?.headers as Record<string, string>)["x-auth-return-redirect"]).toBe("1");
  });

  it("keeps the https cookie names (and chunks) the server set", async () => {
    const srv = fakeServer({ secure: true, chunked: true });
    const mgr = SessionManager.withMemoryStore(srv.fetchImpl);
    await mgr.login(BASE, "a@b.c", "pw");
    expect(mgr.authHeaders().Cookie).toMatch(/^__Secure-authjs\.session-token\.0=jwt; __Secure-authjs\.session-token\.1=\d+full$/);
  });

  it("reports wrong credentials without storing anything", async () => {
    const srv = fakeServer();
    const store = new MemoryTokenStore();
    const mgr = new SessionManager(store, srv.fetchImpl);
    await expect(mgr.login(BASE, "a@b.c", "nope")).rejects.toThrow("Wrong email or password.");
    expect(await store.get()).toBeNull();
    expect(mgr.isSignedIn).toBe(false);
  });

  it("explains an unreachable server", async () => {
    const mgr = SessionManager.withMemoryStore((async () => {
      throw new TypeError("Network request failed");
    }) as typeof fetch);
    await expect(mgr.login(BASE, "a@b.c", "pw")).rejects.toThrow(/Couldn't reach the server/);
  });
});

describe("two-step sign-in", () => {
  it("a pending session is not signed in until the TOTP code passes", async () => {
    const srv = fakeServer({ factor: "totp" });
    const store = new MemoryTokenStore();
    const mgr = new SessionManager(store, srv.fetchImpl);
    expect(await mgr.login(BASE, "a@b.c", "pw")).toEqual({ status: "two_factor", methods: ["totp"] });
    expect(mgr.isSignedIn).toBe(false);
    expect(await store.get()).toBeNull();
    expect(mgr.pendingTwoFactor).toEqual({ methods: ["totp"] });

    await expect(mgr.completeTwoFactor("000000")).rejects.toThrow(/didn't work/);
    expect(mgr.isSignedIn).toBe(false);

    await mgr.completeTwoFactor(" 123456 ");
    expect(mgr.isSignedIn).toBe(true);
    expect(mgr.pendingTwoFactor).toBeNull();
    expect(await store.get()).toMatch(/full$/);
    // The second step carried the CSRF cookie AND the pending session cookie.
    const step2 = srv.calls.find((c) => c.url.endsWith("/callback/two-factor"))!;
    const cookie = (step2.init?.headers as Record<string, string>).cookie;
    expect(cookie).toContain("authjs.csrf-token=csrf123%7Chash");
    expect(cookie).toMatch(/authjs\.session-token=jwt\d+pending/);
  });

  it("accepts a recovery code through the same field", async () => {
    const srv = fakeServer({ factor: "totp", validCode: "abcde-12345" });
    const mgr = SessionManager.withMemoryStore(srv.fetchImpl);
    await mgr.login(BASE, "a@b.c", "pw");
    await mgr.completeTwoFactor("abcde-12345");
    expect(mgr.isSignedIn).toBe(true);
  });

  it("surfaces the server's lockout", async () => {
    const srv = fakeServer({ factor: "totp", lockAfter: 1 });
    const mgr = SessionManager.withMemoryStore(srv.fetchImpl);
    await mgr.login(BASE, "a@b.c", "pw");
    await expect(mgr.completeTwoFactor("111111")).rejects.toThrow(/didn't work/);
    const err = await mgr.completeTwoFactor("123456").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe("locked");
  });

  it("passkey-only accounts are sent to the web app", async () => {
    const srv = fakeServer({ factor: "passkey" });
    const mgr = SessionManager.withMemoryStore(srv.fetchImpl);
    const err = await mgr.login(BASE, "a@b.c", "pw").catch((e: unknown) => e);
    expect((err as AuthError).code).toBe("passkey_only");
    expect(mgr.pendingTwoFactor).toBeNull();
  });

  it("refuses a code without a pending sign-in", async () => {
    const mgr = SessionManager.withMemoryStore(fakeServer().fetchImpl);
    const err = await mgr.completeTwoFactor("123456").catch((e: unknown) => e);
    expect((err as AuthError).code).toBe("expired");
  });

  it("cancel drops the pending step", async () => {
    const srv = fakeServer({ factor: "totp" });
    const mgr = SessionManager.withMemoryStore(srv.fetchImpl);
    await mgr.login(BASE, "a@b.c", "pw");
    mgr.cancelTwoFactor();
    expect(mgr.pendingTwoFactor).toBeNull();
  });
});
