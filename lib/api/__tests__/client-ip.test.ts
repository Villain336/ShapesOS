// ShapesOS — Phase 1: trusted-proxy client IP. Rotating a client-written
// X-Forwarded-For prefix must not change the IP the limiters key on.
// Run: npx tsx --test lib/api/__tests__/client-ip.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clientIpFromHeaders, trustedProxyHops } from "../client-ip";
import { __resetRateLimits, checkRateLimit, clientIp, rateLimitKey } from "../rate-limit";

const h = (init: Record<string, string>) => new Headers(init);

describe("clientIpFromHeaders", () => {
  it("one trusted hop: the rightmost entry (what the proxy saw)", () => {
    assert.equal(clientIpFromHeaders(h({ "x-forwarded-for": "6.6.6.6, 9.9.9.9" }), 1), "9.9.9.9");
    assert.equal(clientIpFromHeaders(h({ "x-forwarded-for": "9.9.9.9" }), 1), "9.9.9.9");
  });

  it("two trusted hops: second from the right", () => {
    assert.equal(
      clientIpFromHeaders(h({ "x-forwarded-for": "6.6.6.6, 1.2.3.4, 10.0.0.2" }), 2),
      "1.2.3.4",
    );
    // Shorter chain than the configured hops: furthest address seen.
    assert.equal(clientIpFromHeaders(h({ "x-forwarded-for": "1.2.3.4" }), 2), "1.2.3.4");
  });

  it("zero hops trusts no proxy header", () => {
    assert.equal(clientIpFromHeaders(h({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "1.2.3.4" }), 0), null);
  });

  it("x-real-ip only when x-forwarded-for is absent", () => {
    assert.equal(clientIpFromHeaders(h({ "x-real-ip": " 5.5.5.5 " }), 1), "5.5.5.5");
    assert.equal(clientIpFromHeaders(h({ "x-forwarded-for": "7.7.7.7", "x-real-ip": "5.5.5.5" }), 1), "7.7.7.7");
    assert.equal(clientIpFromHeaders(h({}), 1), null);
    assert.equal(clientIpFromHeaders(h({ "x-forwarded-for": " , " }), 1), null);
    assert.equal(clientIpFromHeaders(null), null);
  });

  it("TRUSTED_PROXY_HOPS parsing (default 1, invalid → default)", () => {
    assert.equal(trustedProxyHops({} as unknown as NodeJS.ProcessEnv), 1);
    assert.equal(trustedProxyHops({ TRUSTED_PROXY_HOPS: "2" } as unknown as NodeJS.ProcessEnv), 2);
    assert.equal(trustedProxyHops({ TRUSTED_PROXY_HOPS: "0" } as unknown as NodeJS.ProcessEnv), 0);
    assert.equal(trustedProxyHops({ TRUSTED_PROXY_HOPS: "-1" } as unknown as NodeJS.ProcessEnv), 1);
    assert.equal(trustedProxyHops({ TRUSTED_PROXY_HOPS: "abc" } as unknown as NodeJS.ProcessEnv), 1);
  });

  it("env drives the default hop count", () => {
    const prev = process.env.TRUSTED_PROXY_HOPS;
    try {
      process.env.TRUSTED_PROXY_HOPS = "2";
      assert.equal(clientIpFromHeaders(h({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" })), "2.2.2.2");
    } finally {
      if (prev === undefined) delete process.env.TRUSTED_PROXY_HOPS;
      else process.env.TRUSTED_PROXY_HOPS = prev;
    }
  });
});

describe("auth-tier rate limit can't be bypassed by rotating X-Forwarded-For", () => {
  it("30 rotated spoofed prefixes from one real client hit the 10/min limit", () => {
    __resetRateLimits();
    const now = 1_000_000;
    let allowed = 0;
    for (let i = 0; i < 30; i++) {
      const headers = h({ "x-forwarded-for": `10.9.${i}.1, 198.51.100.7` });
      const key = rateLimitKey("auth", null, clientIp(headers));
      if (checkRateLimit(key, "auth", now).allowed) allowed++;
    }
    assert.equal(allowed, 10);
    __resetRateLimits();
  });
});
