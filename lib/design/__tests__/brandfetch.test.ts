// Marketr — Phase 11 "Canvas": Brandfetch brand-lookup lib tests.
// Run: npx tsx --test lib/design/__tests__/brandfetch.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BrandfetchApiError,
  BrandfetchNotConfiguredError,
  BrandfetchNotFoundError,
  DomainInputError,
  brandColorsToKit,
  brandFontsToKit,
  brandfetchStatus,
  fetchBrandfetchBrand,
  lookupBrandForKit,
  mapBrandfetchBrand,
  normalizeDomain,
} from "../brandfetch";

// Realistic Brandfetch API v2 payload (shape per docs.brandfetch.com).
const RAW_BRAND = {
  id: 10979,
  name: "Stripe",
  domain: "stripe.com",
  claimed: true,
  description: "Stripe is a payments platform.",
  longDescription: "Stripe is a longer payments platform description.",
  links: [{ name: "twitter", url: "https://twitter.com/stripe" }],
  logos: [
    {
      type: "logo",
      theme: "light",
      formats: [
        { src: "https://cdn.brandfetch.io/stripe.com/logo.svg", format: "svg", background: "light" },
        { src: "https://cdn.brandfetch.io/stripe.com/logo.png", format: "png", background: "light" },
      ],
    },
    {
      type: "icon",
      theme: "dark",
      formats: [{ src: "https://cdn.brandfetch.io/stripe.com/icon.png", format: "png", background: "dark" }],
    },
  ],
  colors: [
    { hex: "#635bff", type: "primary", brightness: 110 },
    { hex: "#635BFF", type: "accent" },
    { hex: "#0a2540", type: "dark" },
    { hex: "not-a-color", type: "accent" },
  ],
  fonts: [
    { name: "Sohne", type: "title" },
    { name: "Sohne", type: "body" },
    { name: "Inter", type: "body" },
  ],
};

type StubFetch = (input: string, init?: RequestInit) => Promise<Response>;

function stubFetch(
  status: number,
  payload: unknown,
  opts?: { jsonThrows?: boolean; networkError?: boolean },
): { fetch: StubFetch; seen: { url: string; auth: string | null }[] } {
  const seen: { url: string; auth: string | null }[] = [];
  const fetch: StubFetch = async (input, init) => {
    if (opts?.networkError) throw new Error("socket hangup");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url: input, auth: headers["Authorization"] ?? null });
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => {
        if (opts?.jsonThrows) throw new Error("bad json");
        return payload;
      },
    } as unknown as Response;
  };
  return { fetch, seen };
}

function withEnv(value: string | undefined, fn: () => void) {
  const prev = process.env.BRANDFETCH_API_KEY;
  try {
    if (value === undefined) delete process.env.BRANDFETCH_API_KEY;
    else process.env.BRANDFETCH_API_KEY = value;
    fn();
  } finally {
    if (prev === undefined) delete process.env.BRANDFETCH_API_KEY;
    else process.env.BRANDFETCH_API_KEY = prev;
  }
}

describe("normalizeDomain", () => {
  it("accepts a bare domain", () => {
    assert.equal(normalizeDomain("stripe.com"), "stripe.com");
  });
  it("strips scheme, path, query, port, and case", () => {
    assert.equal(normalizeDomain("https://WWW.Stripe.com:443/pricing?x=1#y"), "stripe.com");
  });
  it("strips a trailing dot", () => {
    assert.equal(normalizeDomain("stripe.com."), "stripe.com");
  });
  it("rejects empty input", () => {
    assert.throws(() => normalizeDomain("   "), DomainInputError);
  });
  it("rejects garbage", () => {
    assert.throws(() => normalizeDomain("not a domain!!"), DomainInputError);
  });
  it("rejects single-label names", () => {
    assert.throws(() => normalizeDomain("localhost"), DomainInputError);
  });
  it("rejects IP addresses", () => {
    assert.throws(() => normalizeDomain("1.2.3.4"), DomainInputError);
    assert.throws(() => normalizeDomain("http://127.0.0.1/"), DomainInputError);
  });
  it("rejects non-http schemes", () => {
    assert.throws(() => normalizeDomain("ftp://stripe.com"), DomainInputError);
  });
  it("rejects overlong input", () => {
    assert.throws(() => normalizeDomain(`${"a".repeat(64)}.com`), DomainInputError);
  });
});

describe("mapBrandfetchBrand", () => {
  it("trims the raw v2 payload to the client-safe shape", () => {
    assert.deepEqual(mapBrandfetchBrand(RAW_BRAND), {
      name: "Stripe",
      domain: "stripe.com",
      description: "Stripe is a payments platform.",
      logoUrl: "https://cdn.brandfetch.io/stripe.com/logo.svg",
      colors: ["#635BFF", "#0A2540"],
      fonts: ["Sohne", "Inter"],
    });
  });
  it("normalizes and dedupes colors (drops bad hex)", () => {
    const brand = mapBrandfetchBrand(RAW_BRAND);
    assert.ok(brand);
    assert.deepEqual(brand.colors, ["#635BFF", "#0A2540"]);
  });
  it("prefers type=logo over type=icon", () => {
    const raw = {
      ...RAW_BRAND,
      logos: [
        { type: "icon", theme: "dark", formats: [{ src: "https://cdn/icon.png", format: "png" }] },
        { type: "logo", theme: "light", formats: [{ src: "https://cdn/logo.png", format: "png" }] },
      ],
    };
    assert.equal(mapBrandfetchBrand(raw)?.logoUrl, "https://cdn/logo.png");
  });
  it("falls back to the icon when there is no logo", () => {
    const raw = {
      ...RAW_BRAND,
      logos: [{ type: "icon", theme: "dark", formats: [{ src: "https://cdn/icon.png", format: "png" }] }],
    };
    assert.equal(mapBrandfetchBrand(raw)?.logoUrl, "https://cdn/icon.png");
  });
  it("returns null when no logo has an https src", () => {
    const raw = {
      ...RAW_BRAND,
      logos: [{ type: "logo", theme: "light", formats: [{ src: "data:image/png;base64,xx", format: "png" }] }],
    };
    assert.equal(mapBrandfetchBrand(raw)?.logoUrl, null);
  });
  it("returns null for malformed payloads", () => {
    assert.equal(mapBrandfetchBrand(null), null);
    assert.equal(mapBrandfetchBrand({ name: "Stripe" }), null);
    assert.equal(mapBrandfetchBrand({ domain: "stripe.com" }), null);
    assert.equal(mapBrandfetchBrand([]), null);
  });
});

describe("brandColorsToKit / brandFontsToKit", () => {
  it("maps explicit types to kit slots and fills the rest in order", () => {
    const brand = mapBrandfetchBrand(RAW_BRAND);
    assert.ok(brand);
    assert.deepEqual(brandColorsToKit(RAW_BRAND.colors, brand.colors), {
      primary: "#635BFF",
      secondary: "#0A2540",
    });
  });
  it("maps title→heading and body→body for fonts", () => {
    const brand = mapBrandfetchBrand(RAW_BRAND);
    assert.ok(brand);
    assert.deepEqual(brandFontsToKit(RAW_BRAND.fonts, brand.fonts), {
      heading: "Sohne",
      body: "Inter",
    });
  });
  it("returns empty objects when Brandfetch has no colors/fonts", () => {
    assert.deepEqual(brandColorsToKit([], []), {});
    assert.deepEqual(brandFontsToKit([], []), {});
  });
});

describe("lookupBrandForKit", () => {
  it("returns the trimmed brand plus kit-ready mappings", async () => {
    const { fetch } = stubFetch(200, RAW_BRAND);
    const result = await lookupBrandForKit("k", "stripe.com", fetch);
    assert.equal(result.brand.name, "Stripe");
    assert.deepEqual(result.kitColors, { primary: "#635BFF", secondary: "#0A2540" });
    assert.deepEqual(result.kitFonts, { heading: "Sohne", body: "Inter" });
  });

  it("throws BrandfetchNotConfiguredError when the key is missing", async () => {
    const { fetch } = stubFetch(200, RAW_BRAND);
    await assert.rejects(() => lookupBrandForKit("", "stripe.com", fetch), BrandfetchNotConfiguredError);
  });

  it("throws BrandfetchNotFoundError on HTTP 404 with the honest code", async () => {
    const { fetch } = stubFetch(404, { message: "Brand not found" });
    const err = await lookupBrandForKit("k", "nope.invalid", fetch).catch((e) => e);
    assert.ok(err instanceof BrandfetchNotFoundError);
    assert.equal(err.code, "brandfetch_not_found");
    assert.match(err.message, /nope\.invalid/);
  });

  it("calls out an invalid key on 401 without leaking it", async () => {
    const { fetch } = stubFetch(401, { message: "Unauthorized" });
    const err = await lookupBrandForKit("bf_secret_key", "stripe.com", fetch).catch((e) => e);
    assert.ok(err instanceof BrandfetchApiError);
    assert.match(err.message, /API key may be invalid/);
    assert.ok(!err.message.includes("bf_secret_key"), "key leaked into error message");
  });

  it("surfaces HTTP 429 as a rate-limit error", async () => {
    const { fetch } = stubFetch(429, {});
    const err = await lookupBrandForKit("k", "stripe.com", fetch).catch((e) => e);
    assert.ok(err instanceof BrandfetchApiError);
    assert.equal(err.status, 429);
  });

  it("maps network failures to status 0", async () => {
    const { fetch } = stubFetch(200, RAW_BRAND, { networkError: true });
    const err = await lookupBrandForKit("k", "stripe.com", fetch).catch((e) => e);
    assert.ok(err instanceof BrandfetchApiError);
    assert.equal(err.status, 0);
  });

  it("rejects unreadable JSON", async () => {
    const { fetch } = stubFetch(200, RAW_BRAND, { jsonThrows: true });
    await assert.rejects(() => lookupBrandForKit("k", "stripe.com", fetch), BrandfetchApiError);
  });

  it("rejects a 200 with an unexpected shape (never fake data)", async () => {
    const { fetch } = stubFetch(200, { hello: "world" });
    const err = await lookupBrandForKit("k", "stripe.com", fetch).catch((e) => e);
    assert.ok(err instanceof BrandfetchApiError);
    assert.match(err.message, /unexpected response shape/);
  });
});

describe("key hygiene", () => {
  const SECRET = "bf_test_secret_abc123";

  it("sends the key only in the Authorization header, never the URL", async () => {
    const { fetch, seen } = stubFetch(200, RAW_BRAND);
    await fetchBrandfetchBrand(SECRET, "stripe.com", fetch);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].auth, `Bearer ${SECRET}`);
    assert.ok(!seen[0].url.includes(SECRET), "key leaked into request URL");
  });

  it("never includes the key in the returned brand payload", async () => {
    const { fetch } = stubFetch(200, RAW_BRAND);
    const brand = await fetchBrandfetchBrand(SECRET, "stripe.com", fetch);
    assert.ok(!JSON.stringify(brand).includes(SECRET), "key leaked into brand payload");
    assert.ok(!("apiKey" in brand) && !("key" in brand), "key-shaped field on payload");
  });

  it("never includes the key in error messages", async () => {
    const { fetch } = stubFetch(401, {});
    const err = await lookupBrandForKit(SECRET, "stripe.com", fetch).catch((e) => e);
    assert.ok(err instanceof Error);
    assert.ok(!err.message.includes(SECRET), "key leaked into error message");
  });
});

describe("brandfetchStatus", () => {
  it("reports unconfigured when the env var is missing", () => {
    withEnv(undefined, () => {
      assert.deepEqual(brandfetchStatus(), { name: "brandfetch", isLive: false, configured: false });
    });
  });
  it("reports configured when the env var is set", () => {
    withEnv("some-key", () => {
      assert.deepEqual(brandfetchStatus(), { name: "brandfetch", isLive: true, configured: true });
    });
  });
});
