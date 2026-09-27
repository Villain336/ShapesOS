// Marketr — Phase 11 "Canvas": Unsplash stock-photo lib tests.
// Run: npx tsx --test lib/design/__tests__/unsplash.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PER_PAGE,
  MAX_PER_PAGE,
  NOT_CONFIGURED_MESSAGE,
  SearchParamError,
  UnsplashApiError,
  fetchUnsplashPhotos,
  mapUnsplashPhoto,
  notConfiguredError,
  parseSearchParams,
  unsplashStatus,
} from "../unsplash";

const RAW_PHOTO = {
  id: "abc123",
  width: 6000,
  height: 4000,
  alt_description: "a mountain at dawn",
  urls: {
    raw: "https://images.unsplash.com/photo-raw",
    full: "https://images.unsplash.com/photo-full",
    regular: "https://images.unsplash.com/photo-regular",
    small: "https://images.unsplash.com/photo-small",
    thumb: "https://images.unsplash.com/photo-thumb",
  },
  user: {
    name: "Jane Doe",
    links: { html: "https://unsplash.com/@janedoe" },
  },
};

describe("mapUnsplashPhoto", () => {
  it("trims the raw Unsplash payload to the documented shape", () => {
    assert.deepEqual(mapUnsplashPhoto(RAW_PHOTO), {
      id: "abc123",
      urls: {
        small: "https://images.unsplash.com/photo-small",
        regular: "https://images.unsplash.com/photo-regular",
      },
      width: 6000,
      height: 4000,
      alt: "a mountain at dawn",
      photographer: "Jane Doe",
      photographerUrl: "https://unsplash.com/@janedoe",
    });
  });

  it("preserves photographer attribution", () => {
    const photo = mapUnsplashPhoto(RAW_PHOTO);
    assert.ok(photo);
    assert.equal(photo.photographer, "Jane Doe");
    assert.equal(photo.photographerUrl, "https://unsplash.com/@janedoe");
  });

  it("falls back honestly when the photographer block is missing", () => {
    const photo = mapUnsplashPhoto({ ...RAW_PHOTO, user: null });
    assert.ok(photo);
    assert.equal(photo.photographer, "Unknown photographer");
    assert.equal(photo.photographerUrl, "https://unsplash.com");
  });

  it("treats a missing alt_description as null", () => {
    const photo = mapUnsplashPhoto({ ...RAW_PHOTO, alt_description: null });
    assert.ok(photo);
    assert.equal(photo.alt, null);
  });

  it("returns null for payloads missing renderable data", () => {
    assert.equal(mapUnsplashPhoto(null), null);
    assert.equal(mapUnsplashPhoto(undefined), null);
    assert.equal(mapUnsplashPhoto({}), null);
    assert.equal(mapUnsplashPhoto({ ...RAW_PHOTO, id: null }), null);
    assert.equal(mapUnsplashPhoto({ ...RAW_PHOTO, urls: null }), null);
    assert.equal(
      mapUnsplashPhoto({ ...RAW_PHOTO, urls: { small: null, regular: "x" } }),
      null,
    );
  });
});

describe("parseSearchParams", () => {
  const p = (s: string) => new URLSearchParams(s);

  it("parses q with defaults", () => {
    assert.deepEqual(parseSearchParams(p("q=mountains")), {
      q: "mountains",
      page: 1,
      perPage: DEFAULT_PER_PAGE,
    });
  });

  it("caps per_page at 24", () => {
    assert.equal(MAX_PER_PAGE, 24);
    assert.equal(parseSearchParams(p("q=mountains&per_page=100")).perPage, 24);
    assert.equal(parseSearchParams(p("q=mountains&per_page=24")).perPage, 24);
  });

  it("rejects an empty query", () => {
    assert.throws(
      () => parseSearchParams(p("")),
      (e) => e instanceof SearchParamError && e.status === 400,
    );
    assert.throws(
      () => parseSearchParams(p("q=%20%20")),
      (e) => e instanceof SearchParamError && e.status === 400,
    );
  });

  it("rejects non-positive-integer page and per_page", () => {
    assert.throws(() => parseSearchParams(p("q=a&page=0")), SearchParamError);
    assert.throws(() => parseSearchParams(p("q=a&page=-2")), SearchParamError);
    assert.throws(() => parseSearchParams(p("q=a&page=2.5")), SearchParamError);
    assert.throws(() => parseSearchParams(p("q=a&page=nope")), SearchParamError);
    assert.throws(() => parseSearchParams(p("q=a&per_page=nope")), SearchParamError);
  });

  it("rejects an overlong query", () => {
    assert.throws(() => parseSearchParams(p(`q=${"x".repeat(201)}`)), SearchParamError);
  });
});

describe("notConfiguredError", () => {
  it("is an honest 4xx shape that names Settings → Providers", () => {
    const { status, body } = notConfiguredError();
    assert.ok(status >= 400 && status < 500, "must be a 4xx");
    assert.equal(body.code, "unsplash_not_configured");
    assert.match(body.error, /Settings → Providers/);
  });

  it("never carries key material", () => {
    assert.equal(NOT_CONFIGURED_MESSAGE, notConfiguredError().body.error);
    // The message names the env var but must never interpolate a value.
    assert.ok(!/UNSPLASH_ACCESS_KEY=\S/.test(NOT_CONFIGURED_MESSAGE));
  });
});

describe("unsplashStatus", () => {
  it("matches the providerStatus shape", () => {
    const s = unsplashStatus();
    assert.equal(s.name, "unsplash");
    assert.equal(typeof s.isLive, "boolean");
    assert.equal(typeof s.configured, "boolean");
  });
});

describe("fetchUnsplashPhotos (mocked fetch)", () => {
  it("sends Client-ID auth and the validated query params", async () => {
    let seenUrl = "";
    let seenAuth: string | null = null;
    const fakeFetch = async (input: string, init?: RequestInit) => {
      seenUrl = input;
      seenAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return new Response(JSON.stringify({ total: 1, results: [RAW_PHOTO] }), { status: 200 });
    };
    const { results, total } = await fetchUnsplashPhotos(
      "test-key",
      { q: "mountains", page: 2, perPage: 5 },
      fakeFetch,
    );
    assert.equal(seenAuth, "Client-ID test-key");
    assert.match(seenUrl, /https:\/\/api\.unsplash\.com\/search\/photos/);
    assert.match(seenUrl, /query=mountains/);
    assert.match(seenUrl, /page=2/);
    assert.match(seenUrl, /per_page=5/);
    assert.equal(total, 1);
    assert.equal(results.length, 1);
    // Attribution survives the full fetch → map path.
    assert.equal(results[0]!.photographer, "Jane Doe");
    assert.equal(results[0]!.photographerUrl, "https://unsplash.com/@janedoe");
  });

  it("drops unusable photos instead of failing the whole page", async () => {
    const fakeFetch = async () =>
      new Response(
        JSON.stringify({ total: 2, results: [RAW_PHOTO, { id: "broken" }] }),
        { status: 200 },
      );
    const { results } = await fetchUnsplashPhotos(
      "k",
      { q: "a", page: 1, perPage: 12 },
      fakeFetch,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0]!.id, "abc123");
  });

  it("surfaces Unsplash 429 so the route can pass it through", async () => {
    const fakeFetch = async () => new Response("rate limited", { status: 429 });
    await assert.rejects(
      () => fetchUnsplashPhotos("k", { q: "a", page: 1, perPage: 12 }, fakeFetch),
      (e) => e instanceof UnsplashApiError && e.status === 429,
    );
  });

  it("surfaces network failures distinctly (status 0)", async () => {
    const fakeFetch = async () => {
      throw new Error("boom");
    };
    await assert.rejects(
      () => fetchUnsplashPhotos("k", { q: "a", page: 1, perPage: 12 }, fakeFetch),
      (e) => e instanceof UnsplashApiError && e.status === 0,
    );
  });
});
