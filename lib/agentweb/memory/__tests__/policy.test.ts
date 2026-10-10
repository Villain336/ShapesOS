// Phase 21A round 2 (WS=agentweb): browsing memory rules (PURE). Off unless the member turned it
// on; never for a site on their excluded list; never with the query string or fragment (a search
// term is something typed); retention is bounded; what is stored is a short excerpt, not the page.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideMemory, excerptOf, isExcluded, normalizeSite, normalizeSites, pageKey, retentionDate, MAX_EXCLUDED_SITES, RETENTION_DEFAULT_DAYS } from "../policy";

describe("normalizeSite", () => {
  it("takes a host, an address or a wildcard and keeps the host", () => {
    assert.equal(normalizeSite("Example.com"), "example.com");
    assert.equal(normalizeSite("https://www.Bank.example/accounts?x=1"), "www.bank.example");
    assert.equal(normalizeSite("*.mail.test"), "mail.test");
    assert.equal(normalizeSite("  health.test/ "), "health.test");
  });
  it("refuses what is not a site", () => {
    for (const bad of ["", "   ", "not a site", "javascript:alert(1)", "http://", "a".repeat(300) + ".com", "localhost"]) assert.equal(normalizeSite(bad), null, bad);
  });
  it("normalizeSites dedupes, drops junk and caps the list", () => {
    assert.deepEqual(normalizeSites(["a.com", "A.COM", "junk!", "https://b.com/x"]), ["a.com", "b.com"]);
    assert.equal(normalizeSites(Array.from({ length: 500 }, (_, i) => `s${i}.com`)).length, MAX_EXCLUDED_SITES);
  });
});

describe("isExcluded", () => {
  it("matches the site and its subdomains, not look-alikes", () => {
    assert.equal(isExcluded("https://bank.example/login", ["bank.example"]), true);
    assert.equal(isExcluded("https://app.bank.example/", ["bank.example"]), true);
    assert.equal(isExcluded("https://notbank.example/", ["bank.example"]), false);
    assert.equal(isExcluded("https://bank.example.evil.test/", ["bank.example"]), false);
  });
  it("an address that cannot be read counts as excluded (fail closed)", () => {
    assert.equal(isExcluded("not a url", []), true);
  });
});

describe("pageKey", () => {
  it("drops the query, fragment and trailing slash; lowercases the host", () => {
    assert.equal(pageKey("https://Shop.test/Boots/?q=secret#top"), "https://shop.test/Boots");
    assert.equal(pageKey("https://shop.test/"), "https://shop.test");
    assert.equal(pageKey("ftp://x.test/"), null);
  });
});

describe("decideMemory", () => {
  const base = { enabled: true, excluded: [] as string[], url: "https://news.test/a?q=1", askedByPerson: true };
  it("off by default: nothing is stored", () => {
    assert.deepEqual(decideMemory({ ...base, enabled: false }), { store: false, reason: "off" });
  });
  it("only for what the person asked the agent to read", () => {
    assert.deepEqual(decideMemory({ ...base, askedByPerson: false }), { store: false, reason: "not_asked" });
  });
  it("never for an excluded site", () => {
    assert.deepEqual(decideMemory({ ...base, excluded: ["news.test"] }), { store: false, reason: "excluded" });
  });
  it("stores the page key, not the query", () => {
    const d = decideMemory(base);
    assert.equal(d.store && d.key, "https://news.test/a");
  });
  it("never for a private or internal address", () => {
    assert.equal(decideMemory({ ...base, url: "http://127.0.0.1/admin" }).store, false);
    assert.equal(decideMemory({ ...base, url: "http://192.168.1.5/" }).store, false);
    assert.equal(decideMemory({ ...base, url: "http://localhost:3000/" }).store, false);
  });
});

describe("retentionDate / excerptOf", () => {
  it("retention is bounded to 1..365 days and defaults to 30", () => {
    const now = new Date("2026-11-01T00:00:00Z");
    assert.equal(retentionDate(now, undefined).toISOString(), new Date(now.getTime() + RETENTION_DEFAULT_DAYS * 86_400_000).toISOString());
    assert.equal(retentionDate(now, 0).getTime() - now.getTime(), 86_400_000);
    assert.equal(retentionDate(now, 9999).getTime() - now.getTime(), 365 * 86_400_000);
  });
  it("an excerpt is short, single-spaced and has no control characters", () => {
    const e = excerptOf("Hello\u0000   world\n\n" + "x".repeat(2000));
    assert.ok(e.length <= 400);
    assert.ok(!/[\u0000-\u001f]/.test(e));
    assert.ok(e.startsWith("Hello world"));
  });
});
