// Phase 6: the GSC bulk cron (client.ts querySearchAnalytics) and the M21
// adapter share ONE Search Console HTTP client (api.ts). This pins the cron
// path onto it: request shape, multi-dimension row mapping, metering per
// page, and refresh-on-401 through the token's refresher.
// Run: npx tsx --test --experimental-test-module-mocks lib/intelligence/gsc/__tests__/shared-client.test.ts

import { describe, it, before, mock } from "node:test";
import assert from "node:assert/strict";
import { jsonResponse, scriptedFetch, liveDeps } from "@/lib/connectors/m21/live/__tests__/fixtures";

const metered: Array<{ vendor: string; quantity: number }> = [];

mock.module("@/lib/prisma", { namedExports: { prisma: {} } });
mock.module("@/lib/substrate/graph/rls", { namedExports: { withWorkspaceScope: async () => null } });
mock.module("@/lib/vault/refresh", {
  namedExports: { getDecryptedCredential: async () => null, refreshConnection: async () => "needs_reauth" },
});
mock.module("@/lib/intelligence/providers", {
  namedExports: {
    recordApiMeter: async (_ws: string, vendor: string, _kind: string, quantity: number) => {
      metered.push({ vendor, quantity });
    },
  },
});

let querySearchAnalytics: typeof import("../client").querySearchAnalytics;

before(async () => {
  ({ querySearchAnalytics } = await import("../client"));
});

describe("GSC cron rides the shared Search Console client", () => {
  it("posts the documented body, maps multi-dimension keys, meters, refreshes once on 401", async () => {
    const f = scriptedFetch([
      jsonResponse(401, { error: { code: 401, message: "Invalid Credentials" } }),
      jsonResponse(200, {
        rows: [{ keys: ["dentist", "https://example.com/", "usa", "MOBILE"], clicks: 3, impressions: 40, ctr: 0.075, position: 2.5 }],
      }),
    ]);
    let refreshes = 0;
    const out = await querySearchAnalytics(
      "ws-1",
      {
        token: {
          accessToken: "old",
          property: "sc-domain:example.com",
          refresh: async () => {
            refreshes += 1;
            return "fresh";
          },
        },
        window: { start: new Date("2026-09-01T00:00:00Z"), end: new Date("2026-09-02T00:00:00Z") },
        dimensions: ["query", "page", "country", "device"],
        dataState: "all",
      },
      liveDeps(f.fetchImpl).deps,
    );

    assert.equal(refreshes, 1);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].headers.authorization, "Bearer old");
    assert.equal(f.calls[1].headers.authorization, "Bearer fresh");
    assert.equal(f.calls[1].method, "POST");
    assert.equal(
      f.calls[1].url.href,
      "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query",
    );
    assert.deepEqual(f.calls[1].body, {
      startDate: "2026-09-01",
      endDate: "2026-09-02",
      dimensions: ["query", "page", "country", "device"],
      dataState: "all",
      rowLimit: 25_000,
      startRow: 0,
    });
    assert.deepEqual(out.rows, [
      { query: "dentist", page: "https://example.com/", country: "usa", device: "MOBILE", clicks: 3, impressions: 40, ctr: 0.075, position: 2.5 },
    ]);
    assert.equal(out.truncated, false);
    assert.deepEqual(metered, [{ vendor: "google_gsc", quantity: 1 }]);
  });

  it("a hard failure surfaces a closed-code error without the token", async () => {
    const f = scriptedFetch([jsonResponse(403, { error: { code: 403, message: "User does not have sufficient permission for token old-secret-token" } })]);
    await assert.rejects(
      querySearchAnalytics(
        "ws-1",
        {
          token: { accessToken: "old-secret-token", property: "https://example.com/" },
          window: { start: new Date("2026-09-01T00:00:00Z"), end: new Date("2026-09-02T00:00:00Z") },
          dimensions: ["query"],
          dataState: "all",
        },
        liveDeps(f.fetchImpl).deps,
      ),
      (e: unknown) =>
        e instanceof Error &&
        (e as { code?: string }).code === "forbidden" &&
        !e.message.includes("old-secret-token"),
    );
  });
});
