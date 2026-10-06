// ShapesOS — Phase 18.3 (WS=trust): the session registry's pure rules (unit).
// Run: npx tsx --test lib/auth/__tests__/session-registry.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_TOUCH_MS,
  deviceLabel,
  ipPrefix,
  legacyRowId,
  sessionClaimDecision,
  shouldTouch,
} from "../session-registry";

const NOW = new Date("2026-10-06T12:00:00Z");
const LATER = new Date("2026-10-06T20:00:00Z");
const row = (revokedAt: Date | null = null, expiresAt: Date = LATER) => ({ kind: "row" as const, revokedAt, expiresAt });

describe("session claim check (token.sid)", () => {
  it("a live row is honoured", () => {
    assert.equal(sessionClaimDecision({ sub: "u1", sid: "s1" }, row(), NOW), "allow");
  });

  it("a revoked row ends the token", () => {
    assert.equal(sessionClaimDecision({ sub: "u1", sid: "s1" }, row(new Date("2026-10-06T11:00:00Z")), NOW), "reject");
  });

  it("an expired or missing row ends the token", () => {
    assert.equal(sessionClaimDecision({ sub: "u1", sid: "s1" }, row(null, new Date("2026-10-06T11:59:59Z")), NOW), "reject");
    assert.equal(sessionClaimDecision({ sub: "u1", sid: "s1" }, { kind: "missing" }, NOW), "reject");
    assert.equal(sessionClaimDecision({ sub: "u1", sid: "s1" }, { kind: "legacy", cutoff: null }, NOW), "reject", "a sid never falls back to legacy rules");
  });

  it("no subject (signed out, or pending a second factor) is not the registry's business", () => {
    assert.equal(sessionClaimDecision({}, { kind: "missing" }, NOW), "allow");
    assert.equal(sessionClaimDecision({ sid: "s1" }, { kind: "missing" }, NOW), "allow");
  });

  it("tokens from before the registry: allowed until 'sign out other sessions' moves the cutoff past them", () => {
    const authAt = Math.floor(new Date("2026-10-06T08:00:00Z").getTime() / 1000);
    assert.equal(sessionClaimDecision({ sub: "u1", authAt }, { kind: "legacy", cutoff: null }, NOW), "allow");
    assert.equal(sessionClaimDecision({ sub: "u1", authAt }, { kind: "legacy", cutoff: new Date("2026-10-06T07:00:00Z") }, NOW), "allow");
    assert.equal(sessionClaimDecision({ sub: "u1", authAt }, { kind: "legacy", cutoff: new Date("2026-10-06T09:00:00Z") }, NOW), "reject");
    assert.equal(sessionClaimDecision({ sub: "u1" }, { kind: "legacy", cutoff: new Date("2026-10-06T09:00:00Z") }, NOW), "reject", "no authAt = before any cutoff");
    assert.equal(legacyRowId("u1"), "legacy:u1");
  });

  it("touches last_seen at most every few minutes", () => {
    assert.equal(shouldTouch(new Date(NOW.getTime() - SESSION_TOUCH_MS + 1000), NOW), false);
    assert.equal(shouldTouch(new Date(NOW.getTime() - SESSION_TOUCH_MS), NOW), true);
  });
});

describe("what a session row stores about the device", () => {
  it("IP prefix only, never the full address", () => {
    assert.equal(ipPrefix("203.0.113.77"), "203.0.113.0/24");
    assert.equal(ipPrefix("::ffff:198.51.100.9"), "198.51.100.0/24");
    assert.equal(ipPrefix("2001:db8:1:2:3:4:5:6"), "2001:db8:1::/48");
    assert.equal(ipPrefix("2001:db8::1"), "2001:db8:0::/48");
    assert.equal(ipPrefix("999.1.1.1"), null);
    assert.equal(ipPrefix("not an ip"), null);
    assert.equal(ipPrefix(null), null);
  });

  it("a readable device label from the user agent", () => {
    assert.equal(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36"), "Chrome on macOS");
    assert.equal(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"), "Safari on iPhone");
    assert.equal(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0"), "Edge on Windows");
    assert.equal(deviceLabel("Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0"), "Firefox on Linux");
    assert.equal(deviceLabel("okhttp/4.12.0"), "ShapesOS app");
    assert.equal(deviceLabel(""), null);
  });
});
