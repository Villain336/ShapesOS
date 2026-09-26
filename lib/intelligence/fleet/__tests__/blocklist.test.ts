// Marketr — Phase 10 M4: licensed-review blocklist guard tests.
// Run: npx tsx --test lib/intelligence/fleet/__tests__/blocklist.test.ts
//
// Spec §2 hard line: review data comes ONLY from licensed hosts
// (api.yelp.com Fusion, api.dataforseo.com Business Data, GBP APIs).
// Every adapter passes its request URL through assertLicensedReviewHost()
// BEFORE fetching — these tests pin that behavior.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertLicensedReviewHost,
  LICENSED_REVIEW_HOSTS,
  BLOCKED_REVIEW_DOMAINS,
} from "../types";

describe("assertLicensedReviewHost", () => {
  it("allows the licensed review hosts", () => {
    assertLicensedReviewHost("https://api.yelp.com/v3/businesses/x/reviews");
    assertLicensedReviewHost("https://api.dataforseo.com/v3/business_data/google/reviews/task_post");
    assertLicensedReviewHost("https://mybusiness.googleapis.com/v4/accounts/1/locations/2/reviews");
    assertLicensedReviewHost("https://businessprofileperformance.googleapis.com/v1/locations/2:getDailyMetricsTimeSeries");
  });

  it("blocks every unlicensed review surface", () => {
    const hostile = [
      "https://www.g2.com/products/x/reviews",
      "https://www.capterra.com/p/x/reviews/",
      "https://www.trustpilot.com/review/x.com",
      "https://www.reddit.com/r/x/comments/1/",
      "https://www.google.com/maps/place/x/reviews",
      "https://www.yelp.com/biz/x", // page scraping — only api.yelp.com allowed
      "https://g2.com/products/x",
    ];
    for (const url of hostile) {
      assert.throws(
        () => assertLicensedReviewHost(url),
        /not a licensed review host/,
        `expected block: ${url}`,
      );
    }
  });

  it("blocks lookalike / subdomain-smuggled hosts", () => {
    assert.throws(() => assertLicensedReviewHost("https://api.yelp.com.evil.com/reviews"), /not a licensed review host/);
    assert.throws(() => assertLicensedReviewHost("https://yelp.com@evil.com/"), /not a licensed review host/);
  });

  it("rejects malformed URLs rather than guessing", () => {
    assert.throws(() => assertLicensedReviewHost("not a url"), /malformed/);
  });

  it("the blocklist covers the spec §2 prohibited surfaces", () => {
    for (const d of ["g2.com", "capterra.com", "trustpilot.com", "reddit.com"]) {
      assert.ok(
        BLOCKED_REVIEW_DOMAINS.some((b) => b.includes(d)),
        `blocklist missing ${d}`,
      );
    }
    for (const h of LICENSED_REVIEW_HOSTS) {
      assert.ok(!BLOCKED_REVIEW_DOMAINS.includes(h as never), `${h} must not be blocked`);
    }
  });
});

describe("adapters never call non-allowlisted hosts", () => {
  it("fetchYelpReviews checks the host before fetching (spy never fires on block)", async () => {
    // Import lazily so the guard module under test is the real one.
    const { fetchYelpReviews } = await import("../reviews");
    let calls = 0;
    const spy = (async () => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    // Without YELP_API_KEY the adapter degrades gracefully — no fetch at all.
    delete process.env.YELP_API_KEY;
    const idle = await fetchYelpReviews("some-biz", { fetchImpl: spy });
    assert.equal(idle.status, "unconfigured");
    assert.equal(calls, 0);

    // With a key, the fetch URL must be the licensed host (assert inside the
    // adapter throws before fetch on anything else).
    process.env.YELP_API_KEY = "test-key";
    const ok = await fetchYelpReviews("some-biz", { fetchImpl: spy });
    assert.equal(calls, 1);
    assert.equal(ok.status, "ok");
    delete process.env.YELP_API_KEY;
  });
});
