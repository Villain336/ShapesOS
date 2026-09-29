// Marketr mobile — auth/session tests.
//
// Covers the web-session reuse mechanism: Set-Cookie parsing for both
// Auth.js cookie names, Cookie-header construction, and the SessionManager
// contract (restore/login state machine is exercised via the memory store;
// the live credentials POST is intentionally NOT hit in unit tests).
import { describe, expect, it } from "vitest";
import { AuthError, SessionManager, buildCookieHeader, parseSessionCookie } from "../src/auth/session";
import { MemoryTokenStore } from "../src/auth/token-store";

describe("parseSessionCookie", () => {
  it("extracts the http cookie name", () => {
    expect(parseSessionCookie("authjs.session-token=abc123; Path=/; HttpOnly")).toBe("abc123");
  });
  it("extracts the https __Secure- cookie name", () => {
    expect(parseSessionCookie("__Secure-authjs.session-token=xyz; Path=/; Secure; HttpOnly")).toBe("xyz");
  });
  it("ignores unrelated cookies in the same header", () => {
    expect(parseSessionCookie("other=1; Path=/, authjs.session-token=tok; Path=/; HttpOnly")).toBe("tok");
  });
  it("accepts an array of Set-Cookie values", () => {
    expect(parseSessionCookie(["a=b; Path=/", "authjs.session-token=t2; Path=/"])).toBe("t2");
  });
  it("returns null when no session cookie is present", () => {
    expect(parseSessionCookie("a=b; Path=/")).toBeNull();
    expect(parseSessionCookie(null)).toBeNull();
    expect(parseSessionCookie(undefined)).toBeNull();
  });
  it("returns null for an empty cookie value", () => {
    expect(parseSessionCookie("authjs.session-token=; Path=/")).toBeNull();
  });
});

describe("buildCookieHeader", () => {
  it("builds the Cookie header the web app's routes expect", () => {
    expect(buildCookieHeader("tok")).toEqual({ Cookie: "authjs.session-token=tok" });
  });
});

describe("SessionManager", () => {
  it("restore() picks up a persisted token", async () => {
    const store = new MemoryTokenStore();
    await store.set("persisted");
    const mgr = new SessionManager(store);
    expect(await mgr.restore()).toBe(true);
    expect(mgr.isSignedIn).toBe(true);
    expect(mgr.authHeaders()).toEqual({ Cookie: "authjs.session-token=persisted" });
  });
  it("restore() is signed-out when nothing is stored", async () => {
    const mgr = SessionManager.withMemoryStore();
    expect(await mgr.restore()).toBe(false);
    expect(mgr.isSignedIn).toBe(false);
    expect(() => mgr.authHeaders()).toThrow(AuthError);
  });
  it("logout() clears the token", async () => {
    const mgr = SessionManager.withMemoryStore();
    mgr.setTokenForTests("t");
    expect(mgr.isSignedIn).toBe(true);
    await mgr.logout();
    expect(mgr.isSignedIn).toBe(false);
    expect(() => mgr.authHeaders()).toThrow(AuthError);
  });
});
