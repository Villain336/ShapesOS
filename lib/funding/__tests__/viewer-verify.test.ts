// Phase 1: funding data-room viewer email verification (magic link + session).
// Run: npx tsx --test lib/funding/__tests__/viewer-verify.test.ts
// Pure — no database.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MAGIC_LINK_TTL_MS,
  VIEWER_SESSION_TTL_MS,
  appOriginForLinks,
  mayResendMagicLink,
  resolveViewerAccess,
  signViewerToken,
  verifyViewerToken,
} from "../viewer-verify";

const SECRET = "test-secret-not-for-prod";
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const link = { id: "lnk_1", expiresAt: null as Date | null, viewerEmails: ["Investor@Fund.example"] };

function access(over: Partial<Parameters<typeof resolveViewerAccess>[0]> = {}) {
  return resolveViewerAccess({ link, query: {}, sessionCookie: null, now: NOW, secret: SECRET, ...over });
}

describe("self-asserted email no longer grants access", () => {
  it("?email=<allowlisted> only triggers a sign-in link, never access", () => {
    const r = access({ query: { email: "investor@fund.example" } });
    assert.equal(r.kind, "send-link");
    if (r.kind === "send-link") assert.ok(r.magicToken, "allowlisted address gets a magic token to email");
  });

  it("non-allowlisted address gets the same response kind, but no token is minted", () => {
    const r = access({ query: { email: "attacker@evil.example" } });
    assert.equal(r.kind, "send-link");
    if (r.kind === "send-link") assert.equal(r.magicToken, null);
  });

  it("no input → email form; links without an allowlist stay open", () => {
    assert.equal(access().kind, "email-form");
    assert.equal(access({ link: { ...link, viewerEmails: [] } }).kind, "open");
  });

  it("fails closed without a secret", () => {
    assert.equal(access({ secret: null, query: { email: "investor@fund.example" } }).kind, "unavailable");
  });
});

describe("magic link → session", () => {
  const magic = signViewerToken(
    { linkId: "lnk_1", email: "investor@fund.example", expiresAt: NOW + MAGIC_LINK_TTL_MS, purpose: "magic" },
    SECRET,
  );

  it("a valid magic link starts a session capped at 12h", () => {
    const r = access({ query: { verify: magic } });
    assert.equal(r.kind, "start-session");
    if (r.kind !== "start-session") return;
    assert.equal(r.maxAgeSeconds, VIEWER_SESSION_TTL_MS / 1000);
    const granted = access({ sessionCookie: r.cookieValue });
    assert.deepEqual(granted, { kind: "granted", email: "investor@fund.example" });
  });

  it("the session never outlives the share link's own expiry", () => {
    const soon = new Date(NOW + 60_000);
    const r = access({ link: { ...link, expiresAt: soon }, query: { verify: magic } });
    assert.equal(r.kind, "start-session");
    if (r.kind === "start-session") assert.equal(r.maxAgeSeconds, 60);
  });

  it("rejects expired, tampered, wrong-link and wrong-purpose tokens", () => {
    assert.deepEqual(access({ query: { verify: magic }, now: NOW + MAGIC_LINK_TTL_MS + 1 }), {
      kind: "email-form",
      notice: "link_invalid",
    });
    const [body, sig] = magic.split(".");
    const forged = Buffer.from(
      JSON.stringify({ l: "lnk_1", e: "investor@fund.example", x: NOW + 1e9, p: "magic" }),
    ).toString("base64url");
    assert.equal(access({ query: { verify: `${forged}.${sig}` } }).kind, "email-form");
    assert.equal(access({ query: { verify: `${body}.x${sig}` } }).kind, "email-form");
    assert.equal(access({ link: { ...link, id: "lnk_2" }, query: { verify: magic } }).kind, "email-form");
    // A magic token is not a session cookie (purpose binding).
    assert.equal(access({ sessionCookie: magic }).kind, "email-form");
    assert.equal(verifyViewerToken(magic, { linkId: "lnk_1", purpose: "magic", now: NOW }, "other-secret"), null);
  });

  it("removing the investor from the allowlist cuts an existing session", () => {
    const r = access({ query: { verify: magic } });
    assert.equal(r.kind, "start-session");
    if (r.kind !== "start-session") return;
    const after = access({ link: { ...link, viewerEmails: ["someone@else.example"] }, sessionCookie: r.cookieValue });
    assert.equal(after.kind, "email-form");
  });
});

describe("helpers", () => {
  it("throttles magic-link resends per link+address", () => {
    assert.equal(mayResendMagicLink("lnk_t", "a@b.example", NOW), true);
    assert.equal(mayResendMagicLink("lnk_t", "a@b.example", NOW + 1000), false);
    assert.equal(mayResendMagicLink("lnk_t", "a@b.example", NOW + 61_000), true);
  });

  it("emailed links use the configured origin, never a request Host", () => {
    assert.equal(appOriginForLinks({ NEXTAUTH_URL: "https://app.shapes.example/x" }), "https://app.shapes.example");
    assert.equal(appOriginForLinks({}), null);
  });

  it("the public route no longer forwards ?email= into links, and the beacon honours expiry", () => {
    const route = readFileSync(new URL("../../../app/r/funding/[token]/route.ts", import.meta.url), "utf8");
    assert.doesNotMatch(route, /&amp;email=|&email=\$\{/);
    assert.match(route, /resolveViewerAccess\(/);
    const beacon = readFileSync(
      new URL("../../../app/r/funding/[token]/views/[viewId]/route.ts", import.meta.url),
      "utf8",
    );
    assert.match(beacon, /resolveShareLink\(/);
  });
});
