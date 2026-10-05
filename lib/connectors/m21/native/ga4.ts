// ShapesOS — M21 GA4 adapter.
//
// LIVE WIRING (Phase 4b): with a vault credential this adapter calls the
// Google Analytics Data API v1beta + Admin API v1beta:
//   POST https://analyticsdata.googleapis.com/v1beta/properties/{propertyId}:runReport
//     → traffic_report() (no dimensions; sessions, totalUsers, newUsers,
//       engagementRate, keyEvents — GA4 renamed "conversions" to key events)
//     → top_pages() (dimensions pagePath + pageTitle, ordered by sessions)
//   GET  https://analyticsadmin.googleapis.com/v1beta/accountSummaries
//     → list_properties() (pageToken pagination) and the health check
// Auth: OAuth2 Bearer (scope analytics.readonly), refresh-on-401 through
// the vault (InvokeContext.refreshCredential). 429/5xx back off and retry
// (lib/connectors/m21/live/http.ts). Property id comes from args or
// ProjectDataSource.projectConfig.propertyId.
// Docs: https://developers.google.com/analytics/devguides/reporting/data/v1
//
// MOCK MODE (no credential): deterministic demo metrics; every row flagged
// mock: true, labels carry "(MOCK)". No network calls.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { strProp, numProp, mockOk, liveOk, fail } from "../types";
import { clampInt, liveFailure, tokenSourceFrom, type LiveDeps } from "../live/http";
import {
  ga4ListProperties,
  ga4Ping,
  ga4TopPages,
  ga4TrafficReport,
  normalizeGaDate,
  normalizePropertyId,
} from "../live/ga4";

export class Ga4Adapter implements ConnectorAdapter {
  readonly key = "ga4";
  readonly displayName = "Google Analytics 4";
  readonly authType = "oauth2" as const;
  readonly configSchema = {
    type: "object",
    properties: {
      propertyId: {
        type: "string",
        description:
          "GA4 property id (numeric, e.g. 123456789). Also accepted per-project via ProjectDataSource.projectConfig.",
      },
    },
  };

  constructor(private readonly deps: LiveDeps = {}) {}

  listTools(): ConnectorToolDef[] {
    return [
      {
        name: "list_properties",
        description: "List GA4 properties (with their numeric ids) the connected Google account can read.",
        mutating: false,
        argsSchema: { type: "object", properties: {} },
      },
      {
        name: "traffic_report",
        description:
          "Sessions, users, engagement rate, and conversions for a GA4 property over a date range.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            propertyId: strProp("GA4 property id (numeric)."),
            startDate: strProp("Start date YYYY-MM-DD."),
            endDate: strProp("End date YYYY-MM-DD."),
          },
          required: ["propertyId", "startDate", "endDate"],
        },
      },
      {
        name: "top_pages",
        description: "Top landing pages by sessions with users, engagement, and conversions.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            propertyId: strProp("GA4 property id (numeric)."),
            startDate: strProp("Start date YYYY-MM-DD."),
            endDate: strProp("End date YYYY-MM-DD."),
            limit: numProp("Max pages to return (default 10)."),
          },
          required: ["propertyId", "startDate", "endDate"],
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
        case "list_properties":
          return liveOk({ properties: await ga4ListProperties(auth, this.deps) });
        case "traffic_report":
          return liveOk(
            await ga4TrafficReport(
              auth,
              {
                propertyId: normalizePropertyId(args.propertyId ?? ctx.projectConfig?.propertyId),
                startDate: normalizeGaDate(args.startDate, "startDate"),
                endDate: normalizeGaDate(args.endDate, "endDate"),
              },
              this.deps,
            ),
          );
        case "top_pages":
          return liveOk(
            await ga4TopPages(
              auth,
              {
                propertyId: normalizePropertyId(args.propertyId ?? ctx.projectConfig?.propertyId),
                startDate: normalizeGaDate(args.startDate, "startDate"),
                endDate: normalizeGaDate(args.endDate, "endDate"),
                limit: clampInt(args.limit, 10, 1, 250),
              },
              this.deps,
            ),
          );
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
      return liveOk(await ga4Ping(auth, this.deps));
    } catch (err) {
      return liveFailure(err, this.displayName);
    }
  }

  private mockInvoke(tool: string, args: Record<string, unknown>, ctx: InvokeContext): InvokeResult {
    const propertyId =
      (args.propertyId as string | undefined) ??
      (ctx.projectConfig?.propertyId as string | undefined) ??
      "987654321";
    switch (tool) {
      case "list_properties":
        return mockOk({
          properties: [
            { propertyId: "987654321", displayName: "Harbor Dental — Web (MOCK)", account: "1000", accountName: "Harbor Dental (MOCK)", mock: true },
          ],
        });
      case "traffic_report":
        return mockOk({
          propertyId,
          startDate: args.startDate,
          endDate: args.endDate,
          sessions: 18432,
          totalUsers: 14210,
          newUsers: 11887,
          engagementRate: 0.62,
          conversions: 431,
          mock: true,
        });
      case "top_pages": {
        const limit = Math.min(Number(args.limit) || 10, 50);
        const pages = [
          { pagePath: "/", pageTitle: "Home (MOCK)", sessions: 6210, users: 5400, engagementRate: 0.58, conversions: 148 },
          { pagePath: "/services/implants/", pageTitle: "Dental Implants (MOCK)", sessions: 2412, users: 2201, engagementRate: 0.71, conversions: 96 },
          { pagePath: "/blog/5-tips-healthy-smile/", pageTitle: "5 tips for a healthy smile (MOCK)", sessions: 1884, users: 1770, engagementRate: 0.66, conversions: 21 },
          { pagePath: "/contact/", pageTitle: "Contact (MOCK)", sessions: 1201, users: 1105, engagementRate: 0.74, conversions: 112 },
        ];
        return mockOk({
          propertyId,
          rows: pages.slice(0, limit).map((p) => ({ ...p, mock: true })),
        });
      }
      default:
        return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    }
  }
}
