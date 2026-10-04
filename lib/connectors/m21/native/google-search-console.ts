// ShapesOS — M21 Google Search Console adapter.
//
// LIVE WIRING (Phase 4b): with a vault credential this adapter calls the
// Search Console API (Webmasters v3):
//   GET  https://www.googleapis.com/webmasters/v3/sites → list_sites() + health check
//   POST https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query
//     → query_performance() (dimension query) and page_performance()
//       (dimension page), paged by startRow
// Auth: OAuth2 Bearer (scope webmasters.readonly), refresh-on-401 through
// the vault; 429/5xx/quota-403 back off and retry. Phase 6: the HTTP client
// is the one in lib/intelligence/gsc/api.ts, shared with the bulk snapshot
// cron (lib/intelligence/gsc/client.ts) — there is no second GSC client.
// Docs: https://developers.google.com/webmaster-tools/v1/searchanalytics/query
//
// MOCK MODE (no credential): deterministic demo rows for a demo property;
// every row is flagged mock: true and titles carry "(MOCK)". No network calls.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { strProp, numProp, mockOk, liveOk, fail } from "../types";
import { clampInt, isIsoDate, liveFailure, tokenSourceFrom, ConnectorApiError, type LiveDeps } from "../live/http";
import { gscListSites, gscQuery, normalizeProperty, shapeGscRow } from "@/lib/intelligence/gsc/api";

interface GscRow {
  query: string;
  page?: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  mock: true;
}

function row(
  query: string,
  clicks: number,
  impressions: number,
  position: number,
  page?: string,
): GscRow {
  return {
    query: `${query} (MOCK)`,
    ...(page ? { page } : {}),
    clicks,
    impressions,
    ctr: impressions > 0 ? Math.round((clicks / impressions) * 1000) / 1000 : 0,
    position: Math.round(position * 10) / 10,
    mock: true,
  };
}

const MOCK_QUERIES: [string, number, number, number][] = [
  ["harbor dental studio", 812, 5210, 1.8],
  ["emergency dentist greenville nc", 441, 3105, 3.2],
  ["teeth whitening cost", 287, 4820, 6.4],
  ["dental implants near me", 203, 3911, 8.1],
  ["invisalign consultation", 156, 2214, 4.7],
  ["pediatric dentist greenville", 98, 1402, 5.9],
];

const MOCK_PAGES: [string, number, number, number][] = [
  ["https://demo-site.local/", 1204, 9840, 2.1],
  ["https://demo-site.local/services/implants/", 388, 4012, 5.4],
  ["https://demo-site.local/blog/5-tips-healthy-smile/", 244, 5510, 7.8],
  ["https://demo-site.local/contact/", 176, 1902, 3.3],
];

export class GoogleSearchConsoleAdapter implements ConnectorAdapter {
  readonly key = "google-search-console";
  readonly displayName = "Google Search Console";
  readonly authType = "oauth2" as const;
  readonly configSchema = {
    type: "object",
    properties: {
      property: {
        type: "string",
        description:
          "Search Console property, e.g. sc-domain:example.com or https://example.com/. Also accepted per-project via ProjectDataSource.projectConfig.",
      },
    },
  };

  constructor(private readonly deps: LiveDeps = {}) {}

  listTools(): ConnectorToolDef[] {
    return [
      {
        name: "list_sites",
        description: "List Search Console properties the connected Google account can access.",
        mutating: false,
        argsSchema: { type: "object", properties: {} },
      },
      {
        name: "query_performance",
        description:
          "Top search queries with clicks, impressions, CTR, and average position for a property and date range.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            property: strProp("Property URL, e.g. sc-domain:example.com."),
            startDate: strProp("Start date YYYY-MM-DD."),
            endDate: strProp("End date YYYY-MM-DD."),
            limit: numProp("Max queries to return (default 10)."),
          },
          required: ["property", "startDate", "endDate"],
        },
      },
      {
        name: "page_performance",
        description:
          "Top pages with clicks, impressions, CTR, and average position for a property and date range.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            property: strProp("Property URL, e.g. sc-domain:example.com."),
            startDate: strProp("Start date YYYY-MM-DD."),
            endDate: strProp("End date YYYY-MM-DD."),
            limit: numProp("Max pages to return (default 10)."),
          },
          required: ["property", "startDate", "endDate"],
        },
      },
    ];
  }

  async invoke(
    tool: string,
    args: Record<string, unknown>,
    credential: DecryptedCredential | null,
    ctx: InvokeContext,
  ): Promise<InvokeResult> {
    const auth = tokenSourceFrom(credential, ctx);
    if (!auth) return this.mockInvoke(tool, args, ctx);
    try {
      switch (tool) {
        case "list_sites":
          return liveOk(await gscListSites(auth, this.deps));
        case "query_performance":
        case "page_performance": {
          const dimension = tool === "query_performance" ? "query" : "page";
          const property = normalizeProperty(args.property ?? ctx.projectConfig?.property);
          if (!isIsoDate(args.startDate) || !isIsoDate(args.endDate)) {
            throw new ConnectorApiError(this.displayName, "bad_request", `${this.displayName}: startDate and endDate must be YYYY-MM-DD.`);
          }
          const rows = await gscQuery(
            auth,
            { property, startDate: args.startDate, endDate: args.endDate, dimension, limit: clampInt(args.limit, 10, 1, 50_000) },
            this.deps,
          );
          return liveOk({
            property,
            startDate: args.startDate,
            endDate: args.endDate,
            rows: rows.map((r) => shapeGscRow(r, dimension)),
          });
        }
        default:
          return fail(`Unknown tool "${tool}" for connector ${this.key}`);
      }
    } catch (err) {
      return liveFailure(err, this.displayName);
    }
  }

  async healthCheck(credential: DecryptedCredential, ctx: InvokeContext): Promise<InvokeResult> {
    const auth = tokenSourceFrom(credential, ctx);
    if (!auth) return { ok: false, error: "No access token stored.", errorCode: "not_connected" };
    try {
      const sites = await gscListSites(auth, this.deps);
      return liveOk({ reachable: true, sites: sites.length });
    } catch (err) {
      return liveFailure(err, this.displayName);
    }
  }

  private mockInvoke(tool: string, args: Record<string, unknown>, ctx: InvokeContext): InvokeResult {
    const property =
      (args.property as string | undefined) ??
      (ctx.projectConfig?.property as string | undefined) ??
      "sc-domain:demo-site.local";
    switch (tool) {
      case "list_sites":
        return mockOk([
          { property: "sc-domain:demo-site.local", mock: true },
          { property: "https://demo-site.local/", mock: true },
        ]);
      case "query_performance": {
        const limit = Math.min(Number(args.limit) || 10, 50);
        return mockOk({
          property,
          startDate: args.startDate,
          endDate: args.endDate,
          rows: MOCK_QUERIES.slice(0, limit).map(([q, c, i, p]) => row(q, c, i, p)),
        });
      }
      case "page_performance": {
        const limit = Math.min(Number(args.limit) || 10, 50);
        return mockOk({
          property,
          startDate: args.startDate,
          endDate: args.endDate,
          rows: MOCK_PAGES.slice(0, limit).map(([u, c, i, p]) =>
            row(u.replace("https://demo-site.local", "[page]"), c, i, p, `${u} (MOCK)`),
          ),
        });
      }
      default:
        return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    }
  }
}
