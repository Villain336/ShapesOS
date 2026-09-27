// Marketr — Phase 12 "embeds": integration lib tests.
// Run: npx tsx --test lib/integrations/__tests__/embeds.test.ts
// All network calls use injected mock fetch — no live services touched.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  fetchUmamiPageviews,
  fetchUmamiStats,
  normalizePageviews,
  normalizeStats,
  umamiSnippetConfig,
  umamiStatus,
  UmamiApiError,
} from "../umami";
import { chatwootStatus, chatwootWidgetConfig } from "../chatwoot";
import {
  buildGhostJwt,
  ghostStatus,
  markdownToHtml,
} from "../ghost";
import {
  GrowthBookApiError,
  applyFlagOverrides,
  growthBookSdkConfig,
  growthBookStatus,
  listGrowthBookFeatures,
  marketrFlagDefaults,
  normalizeFeature,
  setGrowthBookDefault,
  type GrowthBookFeature,
} from "../growthbook";
import { buildCreateDocumentForm, documensoStatus } from "../documenso";
import { sanitizeReplayBatch } from "../replay";

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    return handler(u, init);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------- Umami ---

describe("umami status", () => {
  it("unconfigured with empty env", () => {
    const s = umamiStatus({});
    assert.equal(s.statsConfigured, false);
    assert.equal(s.snippetConfigured, false);
    assert.equal(umamiSnippetConfig({}), null);
  });

  it("stats vs snippet config are independent", () => {
    const env = { UMAMI_URL: "http://u:3000", UMAMI_API_KEY: "k" };
    const s = umamiStatus(env);
    assert.equal(s.statsConfigured, true);
    assert.equal(s.snippetConfigured, false);
    const snip = umamiSnippetConfig({ UMAMI_WEBSITE_ID: "w", UMAMI_SCRIPT_URL: "http://u/s.js" });
    assert.deepEqual(snip, { websiteId: "w", scriptUrl: "http://u/s.js" });
  });
});

describe("umami normalize", () => {
  it("coerces string numbers and defaults missing fields", () => {
    const s = normalizeStats({ pageviews: "42", visitors: 7 });
    assert.equal(s.pageviews, 42);
    assert.equal(s.visitors, 7);
    assert.equal(s.visits, 0);
    assert.equal(s.bounces, 0);
    assert.equal(s.totaltime, 0);
  });

  it("normalizes pageview buckets and drops malformed rows", () => {
    const rows = normalizePageviews({
      pageviews: [
        { t: 1, x: "2026-01-01", y: 5 },
        { t: "bad", x: "2026-01-02", y: "3" },
        { nope: true },
      ],
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.y, 5);
    assert.equal(rows[1]!.y, 3);
  });
});

describe("umami fetch", () => {
  const env = {
    UMAMI_URL: "http://umami:3000",
    UMAMI_API_KEY: "secret",
    UMAMI_WEBSITE_ID: "site1",
  };

  it("sends the bearer token and parses stats", async () => {
    let seenAuth = "";
    let seenUrl = "";
    const stats = await fetchUmamiStats(
      1,
      2,
      mockFetch((url, init) => {
        seenUrl = url;
        seenAuth = String((init?.headers as Record<string, string>)["Authorization"]);
        return jsonResponse({ pageviews: 10, visitors: 4, visits: 5, bounces: 1, totaltime: 99 });
      }),
      env,
    );
    assert.ok(seenUrl.includes("/api/websites/site1/stats"));
    assert.equal(seenAuth, "Bearer secret");
    assert.equal(stats.pageviews, 10);
  });

  it("throws UmamiApiError(0) when unconfigured", async () => {
    await assert.rejects(() => fetchUmamiStats(1, 2, mockFetch(() => jsonResponse({})), {}), (e: unknown) => {
      assert.ok(e instanceof UmamiApiError && e.status === 0);
      return true;
    });
  });

  it("throws on unreachable sidecar", async () => {
    await assert.rejects(
      () =>
        fetchUmamiPageviews(
          1,
          2,
          "day",
          mockFetch(() => {
            throw new Error("nope");
          }),
          env,
        ),
      (e: unknown) => e instanceof UmamiApiError && e.status === 0,
    );
  });

  it("throws with the HTTP status on API errors", async () => {
    await assert.rejects(
      () => fetchUmamiStats(1, 2, mockFetch(() => jsonResponse({}, 401)), env),
      (e: unknown) => e instanceof UmamiApiError && e.status === 401,
    );
  });
});

// -------------------------------------------------------------- Chatwoot ---

describe("chatwoot status", () => {
  it("off by default even with credentials", () => {
    const s = chatwootStatus({
      CHATWOOT_BASE_URL: "https://chat.example.com",
      CHATWOOT_WEBSITE_TOKEN: "tok",
    });
    assert.equal(s.configured, true);
    assert.equal(s.enabled, false);
    assert.equal(s.active, false);
    assert.equal(chatwootWidgetConfig({}), null);
  });

  it("active only with explicit opt-in", () => {
    const env = {
      CHATWOOT_BASE_URL: "https://chat.example.com/",
      CHATWOOT_WEBSITE_TOKEN: "tok",
      CHATWOOT_WIDGET_ENABLED: "true",
    };
    const s = chatwootStatus(env);
    assert.equal(s.active, true);
    assert.deepEqual(chatwootWidgetConfig(env), {
      baseUrl: "https://chat.example.com",
      websiteToken: "tok",
    });
  });
});

// ----------------------------------------------------------------- Ghost ---

describe("ghost status + JWT", () => {
  it("unconfigured with empty env", () => {
    assert.equal(ghostStatus({}).configured, false);
  });

  it("configured with both vars", () => {
    assert.equal(
      ghostStatus({ GHOST_URL: "https://blog.example.com", GHOST_ADMIN_API_KEY: "id:abcd1234" }).configured,
      true,
    );
  });

  it("builds a verifiable HS256 JWT", () => {
    const id = "abc123";
    const secretHex = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const token = buildGhostJwt(id, secretHex, 1_700_000_000_000);
    const [h, p, sig] = token.split(".");
    const expected = createHmac("sha256", Buffer.from(secretHex, "hex"))
      .update(`${h}.${p}`)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    assert.equal(sig, expected);
    const header = JSON.parse(Buffer.from(h!, "base64").toString());
    const payload = JSON.parse(Buffer.from(p!, "base64").toString());
    assert.equal(header.kid, id);
    assert.equal(header.alg, "HS256");
    assert.equal(payload.aud, "/admin/");
    assert.equal(payload.exp - payload.iat, 300);
  });
});

describe("ghost markdownToHtml", () => {
  it("renders headings, emphasis, links, lists", () => {
    const html = markdownToHtml("# Hello\n\nSome **bold** and *italic* text.\n\n- one\n- two\n\n[Link](https://example.com)");
    assert.ok(html.includes("<h1>Hello</h1>"));
    assert.ok(html.includes("<strong>bold</strong>"));
    assert.ok(html.includes("<em>italic</em>"));
    assert.ok(html.includes('<a href="https://example.com">Link</a>'));
    assert.ok(html.includes("<ul>") && html.includes("<li>one</li>"));
  });

  it("escapes raw HTML (no injection into Ghost)", () => {
    const html = markdownToHtml('<script>alert(1)</script>');
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("&lt;script&gt;"));
  });

  it("renders ordered lists and blockquotes", () => {
    const html = markdownToHtml("1. first\n2. second\n\n> quoted");
    assert.ok(html.includes("<ol>"));
    assert.ok(html.includes("<blockquote>"));
  });
});

// ------------------------------------------------------------ GrowthBook ---

describe("growthbook status", () => {
  it("unconfigured with empty env", () => {
    const s = growthBookStatus({});
    assert.equal(s.managementConfigured, false);
    assert.equal(s.sdkConfigured, false);
    assert.equal(growthBookSdkConfig({}), null);
  });

  it("management and sdk config are independent", () => {
    const env = { GROWTHBOOK_API_HOST: "http://gb:3000", GROWTHBOOK_API_KEY: "adm" };
    const s = growthBookStatus(env);
    assert.equal(s.managementConfigured, true);
    assert.equal(s.sdkConfigured, false);
    const sdk = growthBookSdkConfig({
      GROWTHBOOK_API_HOST: "http://gb:3000/",
      GROWTHBOOK_CLIENT_KEY: "sdk-key",
    });
    assert.deepEqual(sdk, { apiHost: "http://gb:3000", clientKey: "sdk-key" });
  });
});

describe("growthbook features", () => {
  it("normalizes feature rows and drops malformed ones", () => {
    const rows = [
      { id: "a", valueType: "boolean", defaultValue: true, description: "d", rules: [{}, {}] },
      { id: "b", valueType: "weird", defaultValue: "x" },
      { nope: true },
    ].map(normalizeFeature);
    assert.equal(rows[0]?.rulesCount, 2);
    assert.equal(rows[1]?.valueType, "json");
    assert.equal(rows[2], null);
  });

  it("marketr flag defaults are the documented contract", () => {
    assert.deepEqual(marketrFlagDefaults(), {
      "studio.compact-hero": false,
      "content.brief-v2": false,
    });
  });

  it("lists features with the bearer key", async () => {
    let seenAuth = "";
    const features = await listGrowthBookFeatures(
      mockFetch((url, init) => {
        seenAuth = String((init?.headers as Record<string, string>)["Authorization"]);
        assert.ok(url.endsWith("/api/v1/features"));
        return jsonResponse({ features: [{ id: "x", valueType: "boolean", defaultValue: false }] });
      }),
      { GROWTHBOOK_API_HOST: "http://gb:3000", GROWTHBOOK_API_KEY: "adm" },
    );
    assert.equal(seenAuth, "Bearer adm");
    assert.equal(features.length, 1);
    assert.equal(features[0]!.id, "x");
  });

  it("setGrowthBookDefault PUTs the default value", async () => {
    let seenMethod = "";
    let seenBody = "";
    await setGrowthBookDefault(
      "my-flag",
      true,
      mockFetch((url, init) => {
        seenMethod = init?.method ?? "";
        seenBody = String(init?.body);
        assert.ok(url.endsWith("/api/v1/features/my-flag"));
        return jsonResponse({ status: 200 });
      }),
      { GROWTHBOOK_API_HOST: "http://gb:3000", GROWTHBOOK_API_KEY: "adm" },
    );
    assert.equal(seenMethod, "PUT");
    assert.deepEqual(JSON.parse(seenBody), { defaultValue: true });
  });

  it("throws GrowthBookApiError(0) when unconfigured", async () => {
    await assert.rejects(
      () => listGrowthBookFeatures(mockFetch(() => jsonResponse({})), {}),
      (e: unknown) => e instanceof GrowthBookApiError && e.status === 0,
    );
  });
});

describe("growthbook tenant overrides", () => {
  const features: GrowthBookFeature[] = [
    { id: "a", valueType: "boolean", defaultValue: false, description: "", rulesCount: 0 },
    { id: "b", valueType: "json", defaultValue: { x: 1 }, description: "", rulesCount: 2 },
  ];

  it("override wins over the GrowthBook default, flagged as overridden", () => {
    const eff = applyFlagOverrides(features, { a: true });
    const a = eff.find((f) => f.id === "a")!;
    assert.equal(a.effectiveValue, true);
    assert.equal(a.overridden, true);
    // The remote default is preserved for reference.
    assert.equal(a.defaultValue, false);
    const b = eff.find((f) => f.id === "b")!;
    assert.deepEqual(b.effectiveValue, { x: 1 });
    assert.equal(b.overridden, false);
  });

  it("empty overrides leave everything untouched", () => {
    const eff = applyFlagOverrides(features, {});
    assert.ok(eff.every((f) => f.overridden === false));
    assert.equal(eff.find((f) => f.id === "a")!.effectiveValue, false);
  });

  it("keeps overrides for flags GrowthBook no longer defines", () => {
    const eff = applyFlagOverrides(features, { ghost: true });
    const g = eff.find((f) => f.id === "ghost")!;
    assert.equal(g.effectiveValue, true);
    assert.equal(g.overridden, true);
  });
});

// ------------------------------------------------------------- Documenso ---

describe("documenso", () => {
  it("unconfigured with empty env", () => {
    assert.equal(documensoStatus({}).configured, false);
  });

  it("buildCreateDocumentForm carries file + title", () => {
    const form = buildCreateDocumentForm(new Blob(["%PDF"], { type: "application/pdf" }), "t.pdf", "Title");
    assert.equal(form.get("title"), "Title");
    assert.ok(form.get("file") instanceof Blob);
  });
});

// ----------------------------------------------------------------- rrweb ---

describe("replay batch sanitization", () => {
  it("keeps well-formed events, drops the rest", () => {
    const events = sanitizeReplayBatch([
      { type: 2, timestamp: 1, data: { a: 1 } },
      { type: "x", timestamp: 2 },
      null,
      "nope",
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 2);
  });

  it("caps oversized batches", () => {
    const big = Array.from({ length: 2000 }, (_, i) => ({ type: 2, timestamp: i }));
    assert.equal(sanitizeReplayBatch(big).length, 500);
  });

  it("rejects non-arrays", () => {
    assert.deepEqual(sanitizeReplayBatch({}), []);
  });
});
