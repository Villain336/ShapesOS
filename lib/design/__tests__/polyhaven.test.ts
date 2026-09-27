// Marketr — Phase 11 "Canvas": Poly Haven 3D integration lib tests.
// Run: npx tsx --test lib/design/__tests__/polyhaven.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CURATED_3D_ASSETS,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  POLY_HAVEN_API_BASE,
  POLY_HAVEN_CREDIT,
  POLY_HAVEN_REFERER,
  POLY_HAVEN_USER_AGENT,
  SearchParamError,
  THREE_D_ANGLES,
  fetchPolyHavenModels,
  mapPolyHavenInfo,
  parsePolyHavenSearchParams,
  polyHavenHeaders,
  threeDProvenance,
  validateCuratedManifest,
  type CuratedModel3D,
} from "../polyhaven";

const INFO_MODEL = {
  name: "Wooden Chair 01",
  type: 2,
  authors: { "Jake Mobley": "All" },
  thumbnail_url: "https://cdn.polyhaven.com/asset_img/thumbs/WoodenChair_01.png?width=256&height=256",
  categories: ["furniture", "seating"],
};

describe("mapPolyHavenInfo", () => {
  it("trims the /info payload to the documented shape", () => {
    assert.deepEqual(mapPolyHavenInfo("WoodenChair_01", INFO_MODEL), {
      id: "WoodenChair_01",
      name: "Wooden Chair 01",
      categories: ["furniture", "seating"],
      thumbnailUrl:
        "https://cdn.polyhaven.com/asset_img/thumbs/WoodenChair_01.png?width=256&height=256",
      pageUrl: "https://polyhaven.com/a/WoodenChair_01",
      license: "CC0",
    });
  });

  it("marks every mapped asset CC0", () => {
    const asset = mapPolyHavenInfo("WoodenChair_01", INFO_MODEL);
    assert.ok(asset);
    assert.equal(asset.license, "CC0");
  });

  it("excludes HDRIs and textures (only 3D models belong in the 3D panel)", () => {
    assert.equal(mapPolyHavenInfo("some_hdri", { ...INFO_MODEL, type: 0 }), null);
    assert.equal(mapPolyHavenInfo("some_tex", { ...INFO_MODEL, type: 1 }), null);
  });

  it("returns null for payloads missing renderable data", () => {
    assert.equal(mapPolyHavenInfo("x", null), null);
    assert.equal(mapPolyHavenInfo("x", {}), null);
    assert.equal(mapPolyHavenInfo("x", { ...INFO_MODEL, name: null }), null);
    assert.equal(mapPolyHavenInfo("x", { ...INFO_MODEL, thumbnail_url: null }), null);
  });
});

describe("parsePolyHavenSearchParams", () => {
  const p = (s: string) => new URLSearchParams(s);

  it("parses q with defaults and lower-cases it for cache sharing", () => {
    assert.deepEqual(parsePolyHavenSearchParams(p("q=Wooden+Chair")), {
      q: "wooden chair",
      limit: DEFAULT_SEARCH_LIMIT,
    });
  });

  it("caps limit at 24", () => {
    assert.equal(MAX_SEARCH_LIMIT, 24);
    assert.equal(parsePolyHavenSearchParams(p("q=a&limit=100")).limit, 24);
    assert.equal(parsePolyHavenSearchParams(p("q=a&limit=5")).limit, 5);
  });

  it("rejects an empty or over-long query", () => {
    assert.throws(
      () => parsePolyHavenSearchParams(p("")),
      (e) => e instanceof SearchParamError && e.status === 400,
    );
    assert.throws(
      () => parsePolyHavenSearchParams(p("q=%20%20")),
      (e) => e instanceof SearchParamError && e.status === 400,
    );
    assert.throws(() => parsePolyHavenSearchParams(p(`q=${"a".repeat(101)}`)), SearchParamError);
  });

  it("rejects a non-positive-integer limit", () => {
    assert.throws(() => parsePolyHavenSearchParams(p("q=a&limit=0")), SearchParamError);
    assert.throws(() => parsePolyHavenSearchParams(p("q=a&limit=nope")), SearchParamError);
  });
});

describe("polyHavenHeaders", () => {
  it("identifies the app per the Poly Haven ToS", () => {
    const h = polyHavenHeaders();
    assert.ok(h.Referer.length > 0, "Referer must be set");
    assert.ok(h["User-Agent"].length > 0, "User-Agent must be set");
    assert.equal(h.Referer, POLY_HAVEN_REFERER);
    assert.equal(h["User-Agent"], POLY_HAVEN_USER_AGENT);
    assert.ok(!/unsplash|pexels/i.test(h.Referer), "must identify Marketr, not another provider");
  });

  it("points at the official API base", () => {
    assert.equal(POLY_HAVEN_API_BASE, "https://api.polyhaven.com");
  });

  it("defines the ToS credit line", () => {
    assert.ok(POLY_HAVEN_CREDIT.length > 0);
    assert.match(POLY_HAVEN_CREDIT, /Poly Haven/);
  });
});

describe("fetchPolyHavenModels", () => {
  const slugFor = (infoBySlug: Record<string, unknown>) =>
    async (input: string, init?: RequestInit): Promise<Response> => {
      const url = input;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      assert.ok(headers.Referer, "Referer must be sent server-side");
      if (url.startsWith(`${POLY_HAVEN_API_BASE}/search`)) {
        return new Response(
          JSON.stringify({
            results: Object.keys(infoBySlug).map((slug) => ({ slug, score: 0.7 })),
            total: Object.keys(infoBySlug).length,
          }),
          { status: 200 },
        );
      }
      const slug = decodeURIComponent(url.split("/info/")[1] ?? "");
      const info = infoBySlug[slug];
      return info
        ? new Response(JSON.stringify(info), { status: 200 })
        : new Response("{}", { status: 404 });
    };

  it("searches slugs then hydrates each via /info", async () => {
    const { results, total } = await fetchPolyHavenModels(
      { q: "chair", limit: 12 },
      slugFor({ WoodenChair_01: INFO_MODEL }),
    );
    assert.equal(total, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "WoodenChair_01");
    assert.equal(results[0].license, "CC0");
  });

  it("filters the search to models only", async () => {
    let searchUrl = "";
    const impl: typeof fetch = (async (input: string, init?: RequestInit) => {
      searchUrl = String(input);
      return new Response(JSON.stringify({ results: [], total: 0 }), { status: 200 });
    }) as typeof fetch;
    await fetchPolyHavenModels({ q: "chair", limit: 12 }, impl);
    assert.match(searchUrl, /[?&]t=models(&|$)/);
  });

  it("skips slugs whose /info lookup fails instead of failing the search", async () => {
    const { results } = await fetchPolyHavenModels(
      { q: "chair", limit: 12 },
      slugFor({ WoodenChair_01: INFO_MODEL, Missing_01: null }),
    );
    // Missing_01 404s; only the good one survives.
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "WoodenChair_01");
  });

  it("throws a status-0 error when the network fails", async () => {
    const boom = async (): Promise<Response> => {
      throw new Error("nope");
    };
    await assert.rejects(
      () => fetchPolyHavenModels({ q: "chair", limit: 12 }, boom),
      (e) => e instanceof Error && "status" in e && (e as { status: number }).status === 0,
    );
  });

  it("passes the provider HTTP status through", async () => {
    const bad = async (): Promise<Response> => new Response("{}", { status: 503 });
    await assert.rejects(
      () => fetchPolyHavenModels({ q: "chair", limit: 12 }, bad),
      (e) => e instanceof Error && "status" in e && (e as { status: number }).status === 503,
    );
  });
});

describe("CURATED_3D_ASSETS manifest", () => {
  it("is non-empty but stays small (repo-bloat guard)", () => {
    assert.ok(CURATED_3D_ASSETS.length >= 10, "starter bundle should be useful");
    assert.ok(CURATED_3D_ASSETS.length <= 20, "starter bundle must stay small");
  });

  it("passes the integrity validator with zero problems", () => {
    const { ok, problems } = validateCuratedManifest(CURATED_3D_ASSETS);
    assert.deepEqual(problems, []);
    assert.equal(ok, true);
  });

  it("gives every entry the CC0 license", () => {
    for (const a of CURATED_3D_ASSETS) {
      assert.equal(a.license, "CC0", `${a.id} must be CC0`);
    }
  });

  it("gives every entry one png per angle under /studio/3d-stills/", () => {
    for (const a of CURATED_3D_ASSETS) {
      for (const angle of THREE_D_ANGLES) {
        assert.match(a.png[angle], new RegExp(`^/studio/3d-stills/${a.id}-${angle}\\.png$`));
      }
    }
  });

  it("has unique ids", () => {
    const ids = CURATED_3D_ASSETS.map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("validator catches manifest rot", () => {
    const bad: CuratedModel3D = {
      ...CURATED_3D_ASSETS[0],
      id: "dup",
      license: "CC-BY" as "CC0",
      png: { ...CURATED_3D_ASSETS[0].png, front: "/wrong/path.png" },
    };
    const { ok, problems } = validateCuratedManifest([CURATED_3D_ASSETS[0], { ...CURATED_3D_ASSETS[0], id: "dup" }, bad]);
    assert.equal(ok, false);
    assert.ok(problems.some((p) => /not CC0/i.test(p)), "flags non-CC0 license");
    assert.ok(problems.some((p) => /png path/i.test(p)), "flags bad png path");
  });
});

describe("threeDProvenance", () => {
  it("shapes the custom-bag provenance for curated inserts", () => {
    assert.deepEqual(threeDProvenance("kenney", "kenney-chair", { angle: "front" }), {
      source: "kenney",
      assetId: "kenney-chair",
      license: "CC0",
      angle: "front",
    });
  });

  it("shapes the custom-bag provenance for Poly Haven inserts", () => {
    const p = threeDProvenance("poly-haven", "WoodenChair_01");
    assert.equal(p.source, "poly-haven");
    assert.equal(p.assetId, "WoodenChair_01");
    assert.equal(p.license, "CC0");
  });
});
