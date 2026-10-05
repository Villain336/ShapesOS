// Phase 1 (untrusted content): SSRF guard address classification + safeFetch
// redirect handling. No network: DNS and fetch are injected.
// Run: npx tsx --test lib/security/__tests__/safe-url.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assertSafeUrl,
  embeddedIPv4,
  isBlockedAddress,
  parseIPv6,
  UnsafeUrlError,
} from "../../safe-url";
import { safeFetch } from "../../connectors/safe-fetch";

const publicDns = async () => ["93.184.216.34"];

describe("isBlockedAddress", () => {
  const blocked = [
    // IPv4 special-purpose ranges
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "100.127.255.254", "127.0.0.1",
    "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.192",
    "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.19.255.255",
    "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.255", "240.0.0.1",
    "255.255.255.255",
    // IPv6 special-purpose ranges
    "::", "::1", "fe80::1", "febf::1", "fe80::1%eth0", "fc00::1", "fd12:3456::1",
    "fec0::1", "ff02::1", "2001:db8::1", "2001::1", "100::1", "64:ff9b:1::1",
    "3fff::1",
    // IPv6 embedding a blocked IPv4 address
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:10.0.0.1",
    "::7f00:1", "::127.0.0.1", "::ffff:0:7f00:1", "64:ff9b::a9fe:a9fe",
    "64:ff9b::10.0.0.1", "2002:7f00:1::", "2002:a9fe:a9fe::1", "2002:c0a8:101::",
    "[::ffff:7f00:1]",
    // garbage fails closed
    "", "localhost", "999.1.1.1", "1.2.3", "::ffff:zzzz",
  ];
  for (const a of blocked) {
    it(`blocks ${JSON.stringify(a)}`, () => assert.equal(isBlockedAddress(a), true));
  }
  const allowed = [
    "93.184.216.34", "8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.1",
    "172.32.0.1", "198.20.0.1", "2606:4700::6810:84e5", "2a00:1450:4001::200e",
    "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1",
  ];
  for (const a of allowed) {
    it(`allows ${a}`, () => assert.equal(isBlockedAddress(a), false));
  }
});

describe("parseIPv6 / embeddedIPv4", () => {
  it("expands compressed and dotted-quad forms", () => {
    assert.deepEqual(parseIPv6("::ffff:127.0.0.1"), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    assert.deepEqual(parseIPv6("[2001:db8::1]"), [0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    assert.equal(parseIPv6("not-an-ip"), null);
  });
  it("unwraps mapped, NAT64 and 6to4", () => {
    assert.equal(embeddedIPv4("::ffff:a9fe:a9fe"), "169.254.169.254");
    assert.equal(embeddedIPv4("64:ff9b::a00:1"), "10.0.0.1");
    assert.equal(embeddedIPv4("2002:c0a8:0101::1"), "192.168.1.1");
    assert.equal(embeddedIPv4("2606:4700::1"), null);
  });
});

describe("assertSafeUrl", () => {
  const reject = async (u: string, resolve = publicDns) =>
    assert.rejects(assertSafeUrl(u, { resolve }), UnsafeUrlError);

  it("rejects bracketed IPv4-mapped IPv6 literals after URL normalization", async () => {
    await reject("http://[::ffff:127.0.0.1]/");
    await reject("http://[::ffff:7f00:1]/");
    await reject("http://[::ffff:a9fe:a9fe]/latest/meta-data/");
    await reject("http://[64:ff9b::a9fe:a9fe]/");
    await reject("http://[2002:7f00:1::]/");
  });
  it("rejects numeric IPv4 spellings that URL parsing canonicalizes", async () => {
    await reject("http://2130706433/");
    await reject("http://0x7f.1/");
    await reject("http://0177.0.0.1/");
    await reject("http://100.64.1.1/");
    await reject("http://198.18.0.1/");
    await reject("http://192.0.0.192/");
  });
  it("rejects metadata names, localhost and trailing-dot variants", async () => {
    await reject("http://metadata.google.internal./computeMetadata/v1/");
    await reject("http://localhost:3000/");
    await reject("http://api.localhost/");
  });
  it("rejects a hostname with any internal DNS answer", async () => {
    await reject("https://rebind.example/", async () => ["93.184.216.34", "::ffff:10.0.0.5"]);
    await reject("https://nat64.example/", async () => ["64:ff9b::7f00:1"]);
  });
  it("rejects credentials and non-http schemes", async () => {
    await reject("https://user:pw@example.com/");
    await reject("file:///etc/passwd");
    await reject("gopher://example.com/");
  });
  it("accepts a public URL", async () => {
    assert.equal(await assertSafeUrl("https://example.com/a/", { resolve: publicDns }), "https://example.com/a");
  });
});

describe("safeFetch redirects", () => {
  function fakeFetch(routes: Record<string, { status: number; location?: string }>) {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      const r = routes[url] ?? { status: 200 };
      return new Response(r.status === 200 ? "ok" : null, {
        status: r.status,
        headers: r.location ? { location: r.location } : {},
      });
    }) as typeof fetch;
    return { fn, calls };
  }

  it("strips Authorization and Cookie on a cross-origin redirect", async () => {
    const { fn, calls } = fakeFetch({
      "https://a.example/start": { status: 302, location: "https://a.example/same" },
      "https://a.example/same": { status: 307, location: "https://b.example/other" },
    });
    const res = await safeFetch(
      "https://a.example/start",
      { headers: { Authorization: "Bearer secret", Cookie: "s=1", "X-Keep": "1" } },
      { fetchFn: fn, resolve: publicDns },
    );
    assert.equal(res.status, 200);
    assert.equal(calls.length, 3);
    assert.equal(calls[1].headers.get("authorization"), "Bearer secret", "same-origin hop keeps auth");
    assert.equal(calls[2].url, "https://b.example/other");
    assert.equal(calls[2].headers.get("authorization"), null);
    assert.equal(calls[2].headers.get("cookie"), null);
    assert.equal(calls[2].headers.get("x-keep"), "1");
  });

  it("refuses a redirect into a blocked range without fetching it", async () => {
    const { fn, calls } = fakeFetch({
      "https://a.example/start": { status: 301, location: "http://[::ffff:a9fe:a9fe]/latest/meta-data/" },
    });
    await assert.rejects(
      safeFetch("https://a.example/start", {}, { fetchFn: fn, resolve: publicDns }),
      UnsafeUrlError,
    );
    assert.equal(calls.length, 1);
  });
});
