// Marketr — Phase 10 M4: politeness enforcement tests.
// Run: npx tsx --test lib/intelligence/fleet/__tests__/politeness.test.ts
//
// Politeness IS the fleet's cost control (spec §M4): ≥2s between hits to the
// same domain (default), 15s timeout, identifiable User-Agent, robots
// crawl-delay honored when larger. All timing is injected — no real sleeps.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PoliteFetcher, fleetUserAgent, FLEET_USER_AGENT_BASE } from "../polite-fetch";

function harness(opts: { minDelayMs?: number; timeoutMs?: number } = {}) {
  // Start the virtual clock far from epoch: PoliteFetcher treats "no previous
  // hit" as timestamp 0, and production clocks (Date.now()) are huge — so a
  // big start value reproduces the no-delay-on-first-hit behavior.
  let now = 1_000_000_000_000;
  const slept: number[] = [];
  const seen: Array<{ url: string; ua: string | null }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    seen.push({ url: u, ua: (init?.headers as Record<string, string> | undefined)?.["User-Agent"] ?? null });
    return new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  const fetcher = new PoliteFetcher({
    fetchImpl,
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
