// Phase 21A (WS=agentweb): origin-scoped task capabilities. A task starts with
// the origin(s) it was given; a step onto any other origin pauses and asks.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { capabilitiesFor, checkNavigation, grantOrigin, originOf } from "../capabilities";

describe("capabilitiesFor", () => {
  it("starts with the origin of the start URL and read + interact only", () => {
    const caps = capabilitiesFor("https://a.test/some/page?x=1");
    assert.deepEqual([...caps.allowedOrigins], ["https://a.test"]);
    assert.deepEqual([...caps.allowedActions].sort(), ["interact", "read"]);
  });
  it("takes extra origins and actions given by the person at task start", () => {
    const caps = capabilitiesFor("https://a.test/", { origins: ["https://api.a.test"], actions: ["send"] });
    assert.deepEqual([...caps.allowedOrigins].sort(), ["https://a.test", "https://api.a.test"]);
    assert.equal(caps.allowedActions.has("send"), true);
  });
});

describe("checkNavigation", () => {
  const caps = capabilitiesFor("https://a.test/");
  it("allows the same origin", () => assert.deepEqual(checkNavigation(caps, "https://a.test/other"), { ok: true }));
  it("pauses on a new origin and names it", () => {
    assert.deepEqual(checkNavigation(caps, "https://b.test/x"), { ok: false, reason: "new-origin", origin: "https://b.test" });
  });
  it("treats a subdomain, another port and http as different origins", () => {
    for (const u of ["https://www.a.test/", "https://a.test:8443/", "http://a.test/"]) {
      assert.equal(checkNavigation(caps, u).ok, false, u);
    }
  });
  it("sees through user-info tricks", () => {
    assert.deepEqual(checkNavigation(caps, "https://a.test@evil.test/"), { ok: false, reason: "new-origin", origin: "https://evil.test" });
  });
  it("refuses non-web schemes outright", () => {
    for (const u of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "chrome://settings", "about:blank"]) {
      assert.deepEqual(checkNavigation(caps, u), { ok: false, reason: "bad-scheme" }, u);
    }
  });
  it("refuses an address it cannot parse", () => {
    assert.deepEqual(checkNavigation(caps, "not a url"), { ok: false, reason: "invalid" });
  });
  it("allows the new origin once the person grants it", () => {
    grantOrigin(caps, "https://b.test");
    assert.deepEqual(checkNavigation(caps, "https://b.test/x"), { ok: true });
  });
});

describe("originOf", () => {
  it("is null for things that are not web addresses", () => {
    assert.equal(originOf("mailto:a@b.test"), null);
    assert.equal(originOf("https://a.test:443/x"), "https://a.test");
  });
});
