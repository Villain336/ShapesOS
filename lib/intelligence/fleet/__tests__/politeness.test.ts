// Marketr — Phase 10 M4: politeness enforcement tests.
// Run: npx tsx --test lib/intelligence/fleet/__tests__/politeness.test.ts
//
// Politeness IS the fleet's cost control (spec §M4): ≥2s between hits to the
// same domain (default), 15s timeout, identifiable User-Agent, robots
// crawl-delay honored when larger. All timing is injected — no real sleeps.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PoliteFetcher, fleetUserAgent, FLEET_USER_AGENT_BASE, isOnWatchedDomain } from "../polite-fetch";
import { UnsafeUrlError } from "../../../safe-url";

/** Fake public DNS: the SSRF guard resolves every host; tests never hit DNS. */
const publicDns = async () => ["93.184.216.34"];

function harness(opts: { minDelayMs?: number; timeoutMs?: number } = {}) {
  // Start the virtual clock far from epoch: PoliteFetcher treats "no previous
  // hit" as timestamp 0, and production clocks (Date.now()) are huge — so a
  // big start value reproduces the no-delay-on-first-hit behavior.
  let now = 1_000_000_000_000;
  const slept: number[] = [];
  const seen: Array<{ url: string; ua: string | null }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    seen.push({ url: u, ua: new Headers(init?.headers).get("user-agent") });
    return new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  const fetcher = new PoliteFetcher({
    fetchImpl,
    resolve: publicDns,
    minDelayMs: opts.minDelayMs,
    timeoutMs: opts.timeoutMs,
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms; // advance the virtual clock so delays don't compound
    },
  });
  return {
    fetcher,
    seen,
    slept,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("PoliteFetcher delays", () => {
  it("waits ≥2s between hits to the same domain (default)", async () => {
    const h = harness();
    await h.fetcher.get("https://comp.example/a");
    await h.fetcher.get("https://comp.example/b");
    assert.equal(h.slept.length, 1);
    assert.ok(h.slept[0] >= 2000, `expected ≥2000ms delay, got ${h.slept[0]}`);
  });

  it("does not delay across different domains", async () => {
    const h = harness();
    await h.fetcher.get("https://a.example/x");
    await h.fetcher.get("https://b.example/x");
    assert.equal(h.slept.length, 0);
  });

  it("does not delay when enough virtual time has passed", async () => {
    const h = harness();
    await h.fetcher.get("https://comp.example/a");
    h.advance(5000);
    await h.fetcher.get("https://comp.example/b");
    assert.equal(h.slept.length, 0);
  });

  it("honors robots crawl-delay when larger than the floor", async () => {
    const h = harness();
    h.fetcher.setCrawlDelay("comp.example", 10);
    await h.fetcher.get("https://comp.example/a");
    await h.fetcher.get("https://comp.example/b");
    assert.equal(h.slept.length, 1);
    assert.ok(h.slept[0] >= 10000, `expected ≥10000ms crawl-delay, got ${h.slept[0]}`);
  });

  it("ignores non-positive crawl-delay values", async () => {
    const h = harness();
    h.fetcher.setCrawlDelay("comp.example", 0);
    h.fetcher.setCrawlDelay("comp.example", -5);
    await h.fetcher.get("https://comp.example/a");
    await h.fetcher.get("https://comp.example/b");
    assert.ok(h.slept[0] >= 2000 && h.slept[0] < 10000);
  });
});

describe("PoliteFetcher identity + timeout", () => {
  it("sends an identifiable User-Agent on every request", async () => {
    const h = harness();
    await h.fetcher.get("https://comp.example/a");
    assert.equal(h.seen.length, 1);
    const ua = h.seen[0].ua ?? "";
    assert.ok(ua.startsWith(FLEET_USER_AGENT_BASE), `unexpected UA: ${ua}`);
    assert.equal(fleetUserAgent().startsWith(FLEET_USER_AGENT_BASE), true);
  });

  it("aborts after the configured timeout instead of hanging", async () => {
    const hanging = (async (_url: string | URL | Request, init?: RequestInit) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
      throw new Error("unreachable");
    }) as typeof fetch;
    const fetcher = new PoliteFetcher({
      fetchImpl: hanging,
      resolve: publicDns,
      timeoutMs: 50,
      minDelayMs: 0,
      sleep: async () => {},
    });
    await assert.rejects(
      () => fetcher.get("https://slow.example/page"),
      /timed out after 50ms/,
    );
  });

  it("refuses malformed URLs without touching the network", async () => {
    const h = harness();
    await assert.rejects(() => h.fetcher.get("not a url"), /malformed/);
    assert.equal(h.seen.length, 0);
  });
});

describe("PoliteFetcher SSRF guard (H8)", () => {
  it("refuses internal targets without calling fetch", async () => {
    let calls = 0;
    const fetcher = new PoliteFetcher({
      fetchImpl: (async () => {
        calls++;
        return new Response("x");
      }) as typeof fetch,
      resolve: async () => ["10.0.0.1"],
      minDelayMs: 0,
      sleep: async () => {},
    });
    for (const u of [
      "http://169.254.169.254/latest/meta-data/",
      "http://[::ffff:7f00:1]/",
      "https://intranet.comp.example/",
    ]) {
      await assert.rejects(() => fetcher.get(u), UnsafeUrlError);
    }
    assert.equal(calls, 0);
  });

  it("does not follow a redirect to an internal address", async () => {
    const seen: string[] = [];
    const fetcher = new PoliteFetcher({
      fetchImpl: (async (u: string | URL | Request) => {
        seen.push(String(u));
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:5432/" } });
      }) as typeof fetch,
      resolve: publicDns,
      minDelayMs: 0,
      sleep: async () => {},
    });
    await assert.rejects(() => fetcher.get("https://comp.example/sitemap.xml"), UnsafeUrlError);
    assert.deepEqual(seen, ["https://comp.example/sitemap.xml"]);
  });
});

describe("isOnWatchedDomain", () => {
  it("accepts the domain, www and subdomains", () => {
    assert.equal(isOnWatchedDomain("https://comp.example/a", "comp.example"), true);
    assert.equal(isOnWatchedDomain("https://www.comp.example/a", "comp.example"), true);
    assert.equal(isOnWatchedDomain("https://blog.comp.example/a", "www.comp.example"), true);
  });
  it("rejects other hosts, look-alikes and non-http schemes", () => {
    assert.equal(isOnWatchedDomain("https://evilcomp.example/a", "comp.example"), false);
    assert.equal(isOnWatchedDomain("https://comp.example.evil.test/a", "comp.example"), false);
    assert.equal(isOnWatchedDomain("http://169.254.169.254/", "comp.example"), false);
    assert.equal(isOnWatchedDomain("file:///etc/passwd", "comp.example"), false);
    assert.equal(isOnWatchedDomain("not a url", "comp.example"), false);
  });
});
