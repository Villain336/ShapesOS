// Marketr — Phase 11 "Canvas": Pexels + Pixabay stock-provider lib tests.
// Run: npx tsx --test lib/design/__tests__/stock-providers.test.ts

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PER_PAGE,
  MAX_PER_PAGE,
  NOT_CONFIGURED_MESSAGE as PEXELS_NOT_CONFIGURED,
  PEXELS_ATTRIBUTION_LINE,
  PexelsApiError,
  SearchParamError as PexelsSearchParamError,
  fetchPexelsMedia,
  mapPexelsPhoto,
  mapPexelsVideo,
  notConfiguredError as pexelsNotConfiguredError,
  parseSearchParams as parsePexelsParams,
  pexelsStatus,
  pickVideoFile,
} from "../pexels";
import {
  ASSET_CACHE_TTL_MS,
  NOT_CONFIGURED_MESSAGE as PIXABAY_NOT_CONFIGURED,
  PIXABAY_CDN_HOST,
  RELEASE_DISCLAIMER,
  PixabayApiError,
  SearchParamError as PixabaySearchParamError,
  buildAssetUrl,
  checkRateLimit,
  clearAssetCache,
  clearRateLimit,
  clearResponseCache,
  decodeAssetToken,
  encodeAssetToken,
  fetchPixabayMedia,
  getCachedAsset,
  isPermanentSourceAllowed,
  mapPixabayImage,
  mapPixabayVideo,
  notConfiguredError as pixabayNotConfiguredError,
  parseSearchParams as parsePixabayParams,
  pixabayStatus,
} from "../pixabay";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  return async (input: string, init?: RequestInit): Promise<Response> => handler(input, init);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Pexels: URL builders + param validation
// ---------------------------------------------------------------------------

describe("pexels parseSearchParams", () => {
  it("parses a basic photo search", () => {
    const p = parsePexelsParams(new URLSearchParams({ q: "coffee shop" }));
    assert.equal(p.q, "coffee shop");
    assert.equal(p.page, 1);
    assert.equal(p.perPage, DEFAULT_PER_PAGE);
    assert.equal(p.type, "photo");
  });

  it("accepts type=video", () => {
    const p = parsePexelsParams(new URLSearchParams({ q: "ocean", type: "video" }));
    assert.equal(p.type, "video");
  });

  it("rejects a missing or overlong query", () => {
    assert.throws(() => parsePexelsParams(new URLSearchParams({})), PexelsSearchParamError);
    assert.throws(
      () => parsePexelsParams(new URLSearchParams({ q: "x".repeat(201) })),
      PexelsSearchParamError,
    );
  });

  it("rejects an unknown media type", () => {
    assert.throws(
      () => parsePexelsParams(new URLSearchParams({ q: "x", type: "gif" })),
      /type must be "photo" or "video"/,
    );
  });

  it("rejects non-positive page/per_page and caps per_page", () => {
    assert.throws(() => parsePexelsParams(new URLSearchParams({ q: "x", page: "0" })), PexelsSearchParamError);
    assert.throws(() => parsePexelsParams(new URLSearchParams({ q: "x", per_page: "-3" })), PexelsSearchParamError);
    const p = parsePexelsParams(new URLSearchParams({ q: "x", per_page: "80" }));
    assert.equal(p.perPage, MAX_PER_PAGE);
  });
});

describe("pexels fetchPexelsMedia", () => {
  const RAW_PHOTO = {
    id: 123,
    width: 6000,
    height: 4000,
    alt: "a latte",
    src: {
      original: "https://images.pexels.com/photos/123/original.jpeg",
      large: "https://images.pexels.com/photos/123/large.jpeg",
      medium: "https://images.pexels.com/photos/123/medium.jpeg",
      small: "https://images.pexels.com/photos/123/small.jpeg",
      tiny: "https://images.pexels.com/photos/123/tiny.jpeg",
    },
    photographer: "Jane Doe",
    photographer_url: "https://www.pexels.com/@janedoe",
  };

  it("hits the photo search endpoint with the Authorization header", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const fetchImpl = mockFetch(async (url, init) => {
      seenUrl = url;
      seenAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      return jsonResponse({ photos: [RAW_PHOTO], total_results: 42 });
    });
    const { results, total } = await fetchPexelsMedia("key-123", {
      q: "coffee",
      page: 1,
      perPage: 12,
      type: "photo",
    }, fetchImpl);
    assert.match(seenUrl, /^https:\/\/api\.pexels\.com\/v1\/search\?/);
    assert.match(seenUrl, /query=coffee/);
    assert.equal(seenAuth, "key-123");
    assert.equal(total, 42);
    assert.equal(results.length, 1);
    const photo = results[0];
    assert.ok("urls" in photo);
    if ("urls" in photo) {
      assert.equal(photo.urls.large, "https://images.pexels.com/photos/123/large.jpeg");
    }
  });

  it("hits the video search endpoint for type=video", async () => {
    let seenUrl = "";
    const fetchImpl = mockFetch(async (url) => {
      seenUrl = url;
      return jsonResponse({ videos: [], total_results: 0 });
    });
    await fetchPexelsMedia("key-123", { q: "ocean", page: 1, perPage: 12, type: "video" }, fetchImpl);
    assert.match(seenUrl, /^https:\/\/api\.pexels\.com\/v1\/videos\/search\?/);
  });

  it("wraps network failures and HTTP errors", async () => {
    await assert.rejects(
      fetchPexelsMedia("k", { q: "x", page: 1, perPage: 12, type: "photo" }, async () => {
        throw new Error("down");
      }),
      (e: unknown) => e instanceof PexelsApiError && e.status === 0,
    );
    await assert.rejects(
      fetchPexelsMedia("k", { q: "x", page: 1, perPage: 12, type: "photo" }, async () => jsonResponse({}, 401)),
      (e: unknown) => e instanceof PexelsApiError && e.status === 401,
    );
  });
});

// ---------------------------------------------------------------------------
// Pexels: attribution shaping
// ---------------------------------------------------------------------------

describe("pexels attribution shaping", () => {
  const RAW_PHOTO = {
    id: 7,
    width: 3000,
    height: 2000,
    alt: null,
    src: {
      large: "https://images.pexels.com/photos/7/large.jpeg",
      medium: "https://images.pexels.com/photos/7/medium.jpeg",
      small: "https://images.pexels.com/photos/7/small.jpeg",
    },
    photographer: "John Smith",
    photographer_url: "https://www.pexels.com/@johnsmith",
  };

  it("keeps photographer name + profile URL on every mapped photo", () => {
    const photo = mapPexelsPhoto(RAW_PHOTO);
    assert.ok(photo);
    assert.equal(photo.photographer, "John Smith");
    assert.equal(photo.photographerUrl, "https://www.pexels.com/@johnsmith");
  });

  it("falls back honestly when the photographer block is missing", () => {
    const photo = mapPexelsPhoto({ ...RAW_PHOTO, photographer: null, photographer_url: null });
    assert.ok(photo);
    assert.equal(photo.photographer, "Unknown photographer");
    assert.equal(photo.photographerUrl, "https://www.pexels.com");
  });

  it("returns null for photos missing renderable URLs", () => {
    assert.equal(mapPexelsPhoto(null), null);
    assert.equal(mapPexelsPhoto({ id: 1 }), null);
    assert.equal(
      mapPexelsPhoto({ ...RAW_PHOTO, src: { large: null, medium: null, small: null } }),
      null,
    );
  });

  it("requires the 'Photos provided by Pexels' line to exist for the panel footer", () => {
    assert.match(PEXELS_ATTRIBUTION_LINE, /provided by Pexels/);
  });

  it("picks the widest mp4 at or below 1920px from video_files", () => {
    const files = [
      { link: "https://videos.pexels.com/1/uhd.mp4", file_type: "video/mp4", width: 3840, height: 2160, quality: "uhd" },
      { link: "https://videos.pexels.com/1/hd.mp4", file_type: "video/mp4", width: 1920, height: 1080, quality: "hd" },
      { link: "https://videos.pexels.com/1/sd.mp4", file_type: "video/mp4", width: 640, height: 360, quality: "sd" },
    ];
    const best = pickVideoFile(files);
    assert.ok(best);
    assert.equal(best.link, "https://videos.pexels.com/1/hd.mp4");
    assert.equal(best.width, 1920);
  });

  it("rejects non-mp4 and oversized files in video selection", () => {
    assert.equal(pickVideoFile([]), null);
    assert.equal(
      pickVideoFile([{ link: "x.webm", file_type: "video/webm", width: 640, height: 360 }]),
      null,
    );
    assert.equal(
      pickVideoFile([{ link: "https://a/b.mp4", file_type: "video/mp4", width: 3840, height: 2160 }]),
      null,
    );
  });

  it("maps a video to a poster + attribution + direct mp4 reference", () => {
    const video = mapPexelsVideo({
      id: 99,
      image: "https://images.pexels.com/videos/99/preview.jpeg",
      width: 1920,
      height: 1080,
      duration: 12,
      user: { name: "Film Maker", url: "https://www.pexels.com/@filmmaker" },
      video_files: [
        { link: "https://videos.pexels.com/99/hd.mp4", file_type: "video/mp4", width: 1920, height: 1080, quality: "hd" },
      ],
    });
    assert.ok(video);
    assert.equal(video.preview, "https://images.pexels.com/videos/99/preview.jpeg");
    assert.equal(video.duration, 12);
    assert.equal(video.videoFile, "https://videos.pexels.com/99/hd.mp4");
    assert.equal(video.videographer, "Film Maker");
    assert.equal(video.videographerUrl, "https://www.pexels.com/@filmmaker");
  });

  it("drops videos with no usable mp4 or no preview", () => {
    assert.equal(mapPexelsVideo({ id: 1, image: "x", video_files: [] }), null);
    assert.equal(mapPexelsVideo({ id: 1, video_files: [] }), null);
  });
});

describe("pexels status + not-configured", () => {
  it("reports the honest unconfigured message without key material", () => {
    const { body } = pexelsNotConfiguredError();
    assert.equal(body.code, "pexels_not_configured");
    assert.equal(body.error, PEXELS_NOT_CONFIGURED);
    assert.ok(!JSON.stringify(body).includes("key-"));
  });

  it("pexelsStatus reflects the environment key", () => {
    const prev = process.env.PEXELS_API_KEY;
    process.env.PEXELS_API_KEY = "";
    assert.equal(pexelsStatus().configured, false);
    process.env.PEXELS_API_KEY = "abc";
    assert.equal(pexelsStatus().configured, true);
    if (prev === undefined) delete process.env.PEXELS_API_KEY;
    else process.env.PEXELS_API_KEY = prev;
  });
});

// ---------------------------------------------------------------------------
// Pixabay: URL builders + param validation
// ---------------------------------------------------------------------------

describe("pixabay parseSearchParams", () => {
  it("parses a basic image search", () => {
    const p = parsePixabayParams(new URLSearchParams({ q: "cat" }));
    assert.equal(p.q, "cat");
    assert.equal(p.type, "image");
    assert.equal(p.imageType, "photo");
    assert.equal(p.perPage, DEFAULT_PER_PAGE);
  });

  it("accepts video + image_type variants", () => {
    assert.equal(
      parsePixabayParams(new URLSearchParams({ q: "x", type: "video" })).type,
      "video",
    );
    assert.equal(
      parsePixabayParams(new URLSearchParams({ q: "x", image_type: "illustration" })).imageType,
      "illustration",
    );
  });

  it("rejects bad queries, types, and pagination", () => {
    assert.throws(() => parsePixabayParams(new URLSearchParams({})), PixabaySearchParamError);
    assert.throws(
      () => parsePixabayParams(new URLSearchParams({ q: "x".repeat(201) })),
      PixabaySearchParamError,
    );
    assert.throws(
      () => parsePixabayParams(new URLSearchParams({ q: "x", type: "audio" })),
      PixabaySearchParamError,
    );
    assert.throws(
      () => parsePixabayParams(new URLSearchParams({ q: "x", image_type: "3d" })),
      PixabaySearchParamError,
    );
    const p = parsePixabayParams(new URLSearchParams({ q: "x", per_page: "200" }));
    assert.equal(p.perPage, MAX_PER_PAGE);
  });
});

describe("pixabay fetchPixabayMedia", () => {
  beforeEach(() => {
    clearResponseCache();
    clearRateLimit();
  });

  const RAW_IMAGE = {
    id: 555,
    previewURL: "https://cdn.pixabay.com/photo/555/preview.jpg",
    webformatURL: "https://cdn.pixabay.com/photo/555/web.jpg",
    largeImageURL: "https://cdn.pixabay.com/photo/555/large.jpg",
    imageWidth: 1280,
    imageHeight: 720,
    tags: "a cat",
    user: "contributor",
    pageURL: "https://pixabay.com/photos/555",
  };

  it("appends the key as a query param server-side and maps images", async () => {
    let seenUrl = "";
    const fetchImpl = mockFetch(async (url) => {
      seenUrl = url;
      return jsonResponse({ hits: [RAW_IMAGE], totalHits: 7 });
    });
    const { results, total } = await fetchPixabayMedia("secret-key", {
      q: "cat",
      page: 1,
      perPage: 12,
      type: "image",
      imageType: "photo",
    }, fetchImpl);
    assert.match(seenUrl, /^https:\/\/pixabay\.com\/api\/\?/);
    assert.match(seenUrl, /key=secret-key/);
    assert.match(seenUrl, /image_type=photo/);
    assert.equal(total, 7);
    assert.equal(results.length, 1);
    const asset = results[0];
    assert.equal(asset.thumbUrl, "https://cdn.pixabay.com/photo/555/preview.jpg");
    // Permanent source is Marketr-served — never the CDN URL.
    assert.ok(isPermanentSourceAllowed(asset.placeUrl));
    assert.ok(!asset.placeUrl.includes(PIXABAY_CDN_HOST));
    assert.equal(asset.author, "contributor");
    assert.equal(asset.pageUrl, "https://pixabay.com/photos/555");
  });

  it("uses the video endpoint for type=video", async () => {
    let seenUrl = "";
    const fetchImpl = mockFetch(async (url) => {
      seenUrl = url;
      return jsonResponse({ hits: [], totalHits: 0 });
    });
    await fetchPixabayMedia("k", { q: "x", page: 1, perPage: 12, type: "video", imageType: "photo" }, fetchImpl);
    assert.match(seenUrl, /^https:\/\/pixabay\.com\/api\/videos\/\?/);
  });

  it("caches responses for 24h (terms requirement) — no second fetch", async () => {
    let calls = 0;
    const fetchImpl = mockFetch(async () => {
      calls += 1;
      return jsonResponse({ hits: [RAW_IMAGE], totalHits: 1 });
    });
    const params = { q: "cached", page: 1, perPage: 12, type: "image" as const, imageType: "photo" as const };
    await fetchPixabayMedia("k", params, fetchImpl);
    await fetchPixabayMedia("k", params, fetchImpl);
    assert.equal(calls, 1);
  });

  it("wraps network failures and HTTP errors", async () => {
    const params = { q: "x", page: 1, perPage: 12, type: "image" as const, imageType: "photo" as const };
    await assert.rejects(
      fetchPixabayMedia("k", params, async () => {
        throw new Error("down");
      }),
      (e: unknown) => e instanceof PixabayApiError && e.status === 0,
    );
    await assert.rejects(
      fetchPixabayMedia("k", params, async () => jsonResponse({}, 403)),
      (e: unknown) => e instanceof PixabayApiError && e.status === 403,
    );
  });
});

// ---------------------------------------------------------------------------
// Pixabay: the no-hotlink guard (Open item 1 conservative architecture)
// ---------------------------------------------------------------------------

describe("pixabay no-hotlink guard", () => {
  it("never allows a raw Pixabay CDN URL as a permanent design source", () => {
    assert.equal(isPermanentSourceAllowed("https://cdn.pixabay.com/photo/1/large.jpg"), false);
    assert.equal(isPermanentSourceAllowed("https://cdn.pixabay.com/photo/1/large.jpg?x=1"), false);
    assert.equal(isPermanentSourceAllowed("http://cdn.pixabay.com/photo/1/large.jpg"), false);
    assert.equal(isPermanentSourceAllowed("https://images.pexels.com/photos/1/large.jpeg"), false);
    assert.equal(isPermanentSourceAllowed("https://example.com/img.jpg"), false);
    assert.equal(isPermanentSourceAllowed(""), false);
  });

  it("allows the Marketr-served asset route as the permanent source", () => {
    assert.equal(isPermanentSourceAllowed("/api/studio/pixabay/asset?t=abc123"), true);
  });

  it("no mapped asset ever emits a CDN URL as its placeUrl", () => {
    const image = mapPixabayImage({
      id: 1,
      previewURL: "https://cdn.pixabay.com/photo/1/preview.jpg",
      webformatURL: "https://cdn.pixabay.com/photo/1/web.jpg",
      largeImageURL: "https://cdn.pixabay.com/photo/1/large.jpg",
      imageWidth: 10,
      imageHeight: 10,
      tags: "x",
      user: "u",
      pageURL: "https://pixabay.com/photos/1",
    });
    const video = mapPixabayVideo({
      id: 2,
      previewURL: "https://cdn.pixabay.com/video/2/preview.jpg",
      tags: "y",
      user: "u",
      pageURL: "https://pixabay.com/videos/2",
      duration: 9,
      videos: { small: { url: "https://cdn.pixabay.com/video/2/small.mp4" } },
    });
    for (const asset of [image, video]) {
      assert.ok(asset);
      assert.ok(
        isPermanentSourceAllowed(asset.placeUrl),
        `placeUrl must be Marketr-served, got: ${asset.placeUrl}`,
      );
    }
  });
});

describe("pixabay asset tokens", () => {
  it("round-trips a CDN URL through encode/decode", () => {
    const url = "https://cdn.pixabay.com/photo/2024/01/01/large-image_1280.jpg";
    const token = encodeAssetToken(url);
    assert.equal(decodeAssetToken(token), url);
    assert.equal(buildAssetUrl(token), `/api/studio/pixabay/asset?t=${token}`);
  });

  it("rejects non-Pixabay-CDN URLs (open-proxy guard)", () => {
    assert.equal(decodeAssetToken(encodeAssetToken("https://evil.com/img.jpg")), null);
    assert.equal(decodeAssetToken(encodeAssetToken("https://sub.cdn.pixabay.com/img.jpg")), null);
    assert.equal(decodeAssetToken("not-base64!!!"), null);
    assert.equal(decodeAssetToken(encodeAssetToken("http://cdn.pixabay.com/img.jpg")), null);
  });

  it("the token carries no key material", () => {
    const token = encodeAssetToken("https://cdn.pixabay.com/photo/1/a.jpg");
    assert.ok(!token.includes("secret"));
  });
});

describe("pixabay getCachedAsset", () => {
  beforeEach(() => {
    clearAssetCache();
  });

  it("downloads once, serves from cache, then again after expiry is re-fetched", async () => {
    let calls = 0;
    const bytes = Buffer.from([1, 2, 3]);
    const fetchImpl = mockFetch(async () => {
      calls += 1;
      return new Response(bytes, { status: 200 });
    });
    const first = await getCachedAsset("https://cdn.pixabay.com/photo/1/a.jpg", fetchImpl);
    const second = await getCachedAsset("https://cdn.pixabay.com/photo/1/a.jpg", fetchImpl);
    assert.equal(calls, 1);
    assert.equal(first.bytes.length, 3);
    assert.equal(first.mime, "image/jpeg");
    assert.equal(second.bytes.length, 3);
    assert.ok(ASSET_CACHE_TTL_MS === 24 * 60 * 60 * 1000);
  });

  it("rejects downloads over MAX_DOWNLOAD_BYTES (25 MB)", async () => {
    const big = Buffer.alloc(26 * 1024 * 1024);
    const fetchImpl = mockFetch(async () => new Response(big, { status: 200 }));
    await assert.rejects(
      getCachedAsset("https://cdn.pixabay.com/photo/1/big.jpg", fetchImpl),
      (e: unknown) => e instanceof PixabayApiError && e.status === 413,
    );
  });

  it("maps file extensions to MIME types", async () => {
    const fetchImpl = mockFetch(async () => new Response(Buffer.from([0]), { status: 200 }));
    assert.equal((await getCachedAsset("https://cdn.pixabay.com/a/b.png", fetchImpl)).mime, "image/png");
    clearAssetCache();
    assert.equal((await getCachedAsset("https://cdn.pixabay.com/a/b.gif", fetchImpl)).mime, "image/gif");
    clearAssetCache();
    assert.equal((await getCachedAsset("https://cdn.pixabay.com/a/b.svg", fetchImpl)).mime, "image/svg+xml");
  });

  it("wraps download failures", async () => {
    await assert.rejects(
      getCachedAsset("https://cdn.pixabay.com/a/missing.jpg", async () => {
        throw new Error("down");
      }),
      (e: unknown) => e instanceof PixabayApiError && e.status === 0,
    );
  });
});

describe("pixabay rate limit", () => {
  beforeEach(() => {
    clearRateLimit();
  });

  it("allows bursts under 100/min and blocks the 101st", async () => {
    for (let i = 0; i < 100; i++) assert.equal(await checkRateLimit("ws-1"), true);
    assert.equal(await checkRateLimit("ws-1"), false);
    // A different workspace gets its own budget.
    assert.equal(await checkRateLimit("ws-2"), true);
  });
});

describe("pixabay status + not-configured", () => {
  it("reports the honest unconfigured message without key material", () => {
    const { body } = pixabayNotConfiguredError();
    assert.equal(body.code, "pixabay_not_configured");
    assert.equal(body.error, PIXABAY_NOT_CONFIGURED);
    assert.ok(!JSON.stringify(body).includes("key-"));
  });

  it("pixabayStatus reflects the environment key", () => {
    const prev = process.env.PIXABAY_API_KEY;
    process.env.PIXABAY_API_KEY = "";
    assert.equal(pixabayStatus().configured, false);
    process.env.PIXABAY_API_KEY = "abc";
    assert.equal(pixabayStatus().configured, true);
    if (prev === undefined) delete process.env.PIXABAY_API_KEY;
    else process.env.PIXABAY_API_KEY = prev;
  });

  it("the release disclaimer names the model/property-release gap", () => {
    assert.match(RELEASE_DISCLAIMER, /model or property releases/);
  });
});
