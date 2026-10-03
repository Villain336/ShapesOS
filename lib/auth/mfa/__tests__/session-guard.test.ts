// ShapesOS Phase 4a — guard enforcement for the second factor:
//   - a sign-in with a second factor outstanding produces a PENDING token
//     whose session exposes no user (every guard reads "signed out");
//   - the two-factor / passkey providers complete it;
//   - the proxy bounces pending sessions off the app shell and keys rate
//     limits by IP for them;
//   - the workspace "require 2FA" policy decision.
// Run: npx tsx --test lib/auth/mfa/__tests__/session-guard.test.ts

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { encode } from "next-auth/jwt";
import { NextRequest } from "next/server";
import {
  PENDING_TTL_SECONDS,
  applySignIn,
  pendingSubject,
  recentlyVerified,
  sessionHasSecondFactor,
  sessionView,
} from "../session-token";
import { policyDenies } from "../policy";

const NOW = 1_800_000_000;
const NO_FACTORS = { totp: false, passkeys: 0 };

describe("applySignIn / sessionView", () => {
  it("no second factor: fully signed in from the first factor", () => {
    const t = applySignIn({ sub: "u1", name: "Ada" }, { userId: "u1", provider: "credentials", factors: NO_FACTORS, nowSec: NOW });
    assert.equal(t.sub, "u1");
    assert.deepEqual(t.amr, ["pwd"]);
    assert.equal(t.mfaPendingSub, undefined);
    const v = sessionView(t, NOW);
    assert.deepEqual(v.user, { id: "u1", twoFactor: false, mfaAt: null });
    assert.equal(v.mfa, null);
  });

  it("TOTP enrolled: the first factor leaves the token PENDING with no sub and no session user", () => {
    for (const provider of ["credentials", "google", "oidc", "boxyhq-saml"]) {
      const t = applySignIn({ sub: "u1" }, { userId: "u1", provider, factors: { totp: true, passkeys: 0 }, nowSec: NOW });
      assert.equal(t.sub, undefined, provider);
      assert.equal(t.mfaPendingSub, "u1");
      assert.equal(t.mfaPendingExp, NOW + PENDING_TTL_SECONDS);
      assert.deepEqual(t.mfaMethods, ["totp"]);
      const v = sessionView(t, NOW);
      assert.equal(v.user, null, "a pending session must expose no user to guards");
      assert.deepEqual(v.mfa, { pending: true, methods: ["totp"] });
      assert.equal(sessionHasSecondFactor(t), false);
    }
  });

  it("passkeys only: pending, offering the passkey method", () => {
    const t = applySignIn({ sub: "u1" }, { userId: "u1", provider: "google", factors: { totp: false, passkeys: 2 }, nowSec: NOW });
    assert.deepEqual(t.mfaMethods, ["passkey"]);
    assert.deepEqual(t.amr, ["sso"]);
  });

  it("pending expires after 10 minutes", () => {
    const t = applySignIn({}, { userId: "u1", provider: "credentials", factors: { totp: true, passkeys: 1 }, nowSec: NOW });
    assert.equal(pendingSubject(t, NOW + PENDING_TTL_SECONDS - 1), "u1");
    assert.equal(pendingSubject(t, NOW + PENDING_TTL_SECONDS), null);
    assert.deepEqual(sessionView(t, NOW + PENDING_TTL_SECONDS), { user: null, mfa: null });
  });

  it("the two-factor provider completes it and records the second factor", () => {
    const t = applySignIn(
      { sub: "u1", mfaPendingSub: "stale" },
      { userId: "u1", provider: "two-factor", factors: NO_FACTORS, nowSec: NOW, secondFactor: "otp", firstFactor: "pwd" },
    );
    assert.equal(t.sub, "u1");
    assert.equal(t.mfaPendingSub, undefined);
    assert.deepEqual(t.amr, ["pwd", "otp"]);
    assert.equal(t.mfaAt, NOW);
    assert.deepEqual(sessionView(t, NOW).user, { id: "u1", twoFactor: true, mfaAt: NOW });
  });

  it("a passkey sign-in is complete and counts as a second factor", () => {
    const t = applySignIn({ sub: "u9" }, { userId: "u9", provider: "passkey", factors: { totp: true, passkeys: 1 }, nowSec: NOW });
    assert.equal(t.sub, "u9");
    assert.deepEqual(t.amr, ["passkey"]);
    assert.equal(sessionHasSecondFactor(t), true);
  });

  it("re-auth window is 10 minutes", () => {
    assert.equal(recentlyVerified(NOW - 600, NOW), true);
    assert.equal(recentlyVerified(NOW - 601, NOW), false);
    assert.equal(recentlyVerified(null, NOW), false);
  });
});

describe("workspace require-2FA policy decision", () => {
  it("denies the member's own session without a second factor", () => {
    assert.equal(policyDenies(true, "u1", { userId: "u1", twoFactor: false }), true);
    assert.equal(policyDenies(true, "u1", { userId: "u1", twoFactor: true }), false);
  });
  it("off, or not this person's browser session (MCP key, cron): not applied", () => {
    assert.equal(policyDenies(false, "u1", { userId: "u1", twoFactor: false }), false);
    assert.equal(policyDenies(true, "u1", null), false);
    assert.equal(policyDenies(true, "u1", { userId: "u2", twoFactor: false }), false);
  });
});

describe("proxy honours a pending second factor", () => {
  const SECRET = "test-secret-for-mfa-proxy-0123456789abcdef";
  let proxy: (req: NextRequest) => Promise<Response>;
  before(async () => {
    process.env.AUTH_SECRET = SECRET;
    ({ proxy } = await import("../../../../proxy"));
  });

  const cookieFor = async (token: Record<string, unknown>, name = "authjs.session-token") =>
    `${name}=${await encode({ token, secret: SECRET, salt: name })}`;
  const req = (path: string, cookie?: string) =>
    new NextRequest(new URL(path, "http://localhost:3000"), cookie ? { headers: { cookie } } : undefined);
  const now = () => Math.floor(Date.now() / 1000);

  it("redirects a pending session from the dashboard to /login (keeping next)", async () => {
    for (const name of ["authjs.session-token", "__Secure-authjs.session-token"]) {
      const cookie = await cookieFor({ mfaPendingSub: "u1", mfaPendingExp: now() + 300 }, name);
      const res = await proxy(req("/dashboard/settings?tab=x", cookie));
      assert.equal(res.status, 307, name);
      const loc = new URL(res.headers.get("location")!);
      assert.equal(loc.pathname, "/login");
      assert.equal(loc.searchParams.get("next"), "/dashboard/settings?tab=x");
    }
  });

  it("lets a fully signed-in session and anonymous visitors through", async () => {
    const full = await cookieFor({ sub: "u1", mfaAt: now() });
    assert.equal((await proxy(req("/dashboard", full))).status, 200);
    assert.equal((await proxy(req("/dashboard"))).status, 200);
    // An expired pending token is just signed out (the layout redirects to /login itself).
    const expired = await cookieFor({ mfaPendingSub: "u1", mfaPendingExp: now() - 1 });
    assert.equal((await proxy(req("/dashboard", expired))).status, 200);
  });

  it("does not bounce /login itself (no loop)", async () => {
    const cookie = await cookieFor({ mfaPendingSub: "u1", mfaPendingExp: now() + 300 });
    assert.equal((await proxy(req("/login", cookie))).status, 200);
  });
});
